import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SERVICE = "cn.aelion.aru.host-provider.v1";
const WINDOWS_POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

// Windows secrets are DPAPI (CurrentUser) ciphertext files: the OS-native
// protected storage a background Scheduled Task process can read without a
// Console open, and never a plaintext config fallback. All file IO happens
// inside PowerShell so the injectable `run` stays the only side-effect outlet.
export function windowsSecretFilePath(service, account, env = process.env) {
  const base = env.ARU_WINDOWS_SECRET_ROOT
    ?? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AruHost", "secrets");
  return join(base, service, `${account}.dpapi`);
}

function windowsQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function windowsDpapiScripts(secretPath) {
  const quoted = windowsQuote(secretPath);
  return {
    probe: "Add-Type -AssemblyName System.Security; "
      + "[void][Security.Cryptography.ProtectedData]::Protect([byte[]](1),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    read: "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; "
      + `$p=${quoted}; if(!(Test-Path -LiteralPath $p)){exit 44}; `
      + "$c=[IO.File]::ReadAllBytes($p); "
      + "$b=[Security.Cryptography.ProtectedData]::Unprotect($c,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
      + "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))",
    write: "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; "
      + `$p=${quoted}; ` + '$s=[Console]::In.ReadToEnd().TrimEnd("`r","`n"); '
      + "if($s.Length -eq 0){exit 1}; "
      + "New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $p) | Out-Null; "
      + "$b=[Text.Encoding]::UTF8.GetBytes($s); "
      + "$c=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
      + "[IO.File]::WriteAllBytes($p,$c)",
    remove: `$p=${windowsQuote(secretPath)}; if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force}`,
  };
}

export function createProviderSecretStore({
  platform = process.platform,
  service = DEFAULT_SERVICE,
  run = spawnSync,
} = {}) {
  const linuxSecretTool = "/usr/bin/secret-tool";
  let cachedAvailability;

  function availability() {
    if (cachedAvailability) return cachedAvailability;
    if (platform === "linux") {
      const result = run(linuxSecretTool, ["--version"], {
        encoding: "utf8",
        timeout: 3_000,
        windowsHide: true,
      });
      cachedAvailability = result.error?.code === "ENOENT" || result.status !== 0
        ? { supported: false, storage: "unavailable", failure: "secret-tool-not-found" }
        : { supported: true, storage: "linux-secret-service", failure: null };
      return cachedAvailability;
    }
    if (platform === "win32") {
      const result = run("powershell.exe", [
        ...WINDOWS_POWERSHELL_FLAGS, windowsDpapiScripts("").probe,
      ], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      cachedAvailability = result.error?.code === "ENOENT"
        ? { supported: false, storage: "unavailable", failure: "powershell-not-found" }
        : result.status !== 0
          ? { supported: false, storage: "unavailable", failure: "windows-dpapi-unavailable" }
          : { supported: true, storage: "windows-dpapi", failure: null };
      return cachedAvailability;
    }
    if (platform !== "darwin") {
      cachedAvailability = {
        supported: false,
        storage: "unavailable",
        failure: "platform-secret-store-unavailable",
      };
      return cachedAvailability;
    }
    const result = run("/usr/bin/security", ["help"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    });
    cachedAvailability = result.error?.code === "ENOENT"
      ? { supported: false, storage: "unavailable", failure: "security-command-not-found" }
      : { supported: true, storage: "macos-keychain", failure: null };
    return cachedAvailability;
  }

  function read(profileId) {
    requireAvailable();
    if (platform === "linux") {
      const result = run(linuxSecretTool, [
        "lookup", "service", service, "account", account(profileId),
      ], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      if (result.status === 1) return null;
      if (result.status !== 0) throw new Error("无法从 Linux Secret Service 读取模型 API 密钥");
      return String(result.stdout ?? "").replace(/[\r\n]+$/, "");
    }
    if (platform === "win32") {
      const result = run("powershell.exe", [
        ...WINDOWS_POWERSHELL_FLAGS,
        windowsDpapiScripts(windowsSecretFilePath(service, account(profileId))).read,
      ], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      if (result.status === 44) return null;
      if (result.status !== 0) throw new Error("无法从 Windows 数据保护存储读取模型 API 密钥");
      return String(result.stdout ?? "").replace(/[\r\n]+$/, "");
    }
    const result = run("/usr/bin/security", [
      "find-generic-password",
      "-a", account(profileId),
      "-s", service,
      "-w",
    ], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status === 44 || /could not be found/i.test(result.stderr ?? "")) return null;
    if (result.status !== 0) throw new Error("无法从 macOS 钥匙串读取模型 API 密钥");
    return String(result.stdout ?? "").replace(/[\r\n]+$/, "");
  }

  function write(profileId, secret) {
    requireAvailable();
    const value = validatedSecret(secret);
    if (platform === "linux") {
      const result = run(linuxSecretTool, [
        "store", "--label=Aru Host provider", "service", service, "account", account(profileId),
      ], {
        input: `${value}\n`,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error("无法把模型 API 密钥保存到 Linux Secret Service");
      return;
    }
    if (platform === "win32") {
      const result = run("powershell.exe", [
        ...WINDOWS_POWERSHELL_FLAGS,
        windowsDpapiScripts(windowsSecretFilePath(service, account(profileId))).write,
      ], {
        input: `${value}\n`,
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error("无法把模型 API 密钥保存到 Windows 数据保护存储");
      return;
    }
    const result = run("/usr/bin/security", [
      "add-generic-password",
      "-a", account(profileId),
      "-s", service,
      "-U",
      "-w",
    ], {
      input: `${value}\n${value}\n`,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error("无法把模型 API 密钥保存到 macOS 钥匙串");
  }

  function remove(profileId) {
    requireAvailable();
    if (platform === "linux") {
      const result = run(linuxSecretTool, [
        "clear", "service", service, "account", account(profileId),
      ], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      if (result.status !== 0 && result.status !== 1) {
        throw new Error("无法从 Linux Secret Service 删除模型 API 密钥");
      }
      return;
    }
    if (platform === "win32") {
      const result = run("powershell.exe", [
        ...WINDOWS_POWERSHELL_FLAGS,
        windowsDpapiScripts(windowsSecretFilePath(service, account(profileId))).remove,
      ], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error("无法从 Windows 数据保护存储删除模型 API 密钥");
      return;
    }
    const result = run("/usr/bin/security", [
      "delete-generic-password",
      "-a", account(profileId),
      "-s", service,
    ], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status === 44 || /could not be found/i.test(result.stderr ?? "")) return;
    if (result.status !== 0) throw new Error("无法从 macOS 钥匙串删除模型 API 密钥");
  }

  function requireAvailable() {
    if (!availability().supported) {
      throw new Error("当前系统没有可用的安全凭据存储");
    }
  }

  return { availability, read, write, remove };
}

function account(profileId) {
  const value = String(profileId ?? "");
  if (!/^provider_[A-Fa-f0-9-]+$/.test(value)) throw new Error("invalid provider profile id");
  return value;
}

function validatedSecret(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("API key is required");
  if (/[\r\n\u0000]/.test(value)) throw new Error("API key contains unsupported characters");
  return value;
}
