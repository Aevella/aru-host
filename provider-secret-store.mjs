import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, constants, openSync, closeSync, fsyncSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SERVICE = "cn.aelion.aru.host-provider.v1";
const WINDOWS_POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const LINUX_SECRET_TOOL = "/usr/bin/secret-tool";
const LINUX_AVAILABILITY_PROBE_SERVICE = "cn.aelion.aru.secret-service-probe.v1";
const LINUX_AVAILABILITY_PROBE_ACCOUNT = "availability-probe";
export const LINUX_AVAILABILITY_CACHE_MILLISECONDS = 5_000;

export function lookupLinuxSecret({
  run = spawnSync,
  service,
  account,
  timeout = 5_000,
}) {
  const result = run(LINUX_SECRET_TOOL, [
    "lookup", "service", service, "account", account,
  ], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  if (result.error?.code === "ENOENT") return { outcome: "tool-missing", value: null };
  if (result.status === 0) {
    return {
      outcome: "found",
      value: String(result.stdout ?? "").replace(/[\r\n]+$/, ""),
    };
  }
  // libsecret uses exit 1 for both "no matching item" and backend failures.
  // A missing item is silent; D-Bus, unlock, and service failures write stderr.
  if (result.status === 1 && !String(result.stderr ?? "").trim()) {
    return { outcome: "missing", value: null };
  }
  return { outcome: "unavailable", value: null };
}

export function probeLinuxSecretService(run = spawnSync) {
  const result = lookupLinuxSecret({
    run,
    service: LINUX_AVAILABILITY_PROBE_SERVICE,
    account: LINUX_AVAILABILITY_PROBE_ACCOUNT,
    timeout: 3_000,
  });
  if (result.outcome === "tool-missing") {
    return { supported: false, storage: "unavailable", failure: "secret-tool-not-found" };
  }
  if (result.outcome === "unavailable") {
    return { supported: false, storage: "unavailable", failure: "linux-secret-service-unavailable" };
  }
  return { supported: true, storage: "linux-secret-service", failure: null };
}

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
  now = Date.now,
  env = process.env,
} = {}) {
  // The installer selects this backend explicitly; a desktop keyring outage
  // must never silently create a second credential store.
  if (platform === "linux" && env.ARU_PROVIDER_SECRET_ROOT) {
    return createHeadlessProviderSecretStore(env.ARU_PROVIDER_SECRET_ROOT);
  }
  let cachedAvailability;
  let availabilityCheckedAt = 0;

  function availability() {
    if (platform === "linux") {
      const timestamp = now();
      if (cachedAvailability
          && timestamp - availabilityCheckedAt < LINUX_AVAILABILITY_CACHE_MILLISECONDS) {
        return cachedAvailability;
      }
      const detected = probeLinuxSecretService(run);
      cachedAvailability = detected;
      availabilityCheckedAt = timestamp;
      return detected;
    }
    if (cachedAvailability) return cachedAvailability;
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
      const result = lookupLinuxSecret({
        run,
        service,
        account: account(profileId),
      });
      if (result.outcome === "missing") return null;
      if (result.outcome === "tool-missing") {
        throw new Error("Linux 系统没有安装 secret-tool，无法读取模型 API 密钥");
      }
      if (result.outcome === "unavailable") {
        throw new Error("Linux Secret Service 当前不可访问，无法读取模型 API 密钥");
      }
      return result.value;
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
      const result = run(LINUX_SECRET_TOOL, [
        "store", "--label=Aru Host provider", "service", service, "account", account(profileId),
      ], {
        input: `${value}\n`,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      if (result.error?.code === "ENOENT") {
        throw new Error("Linux 系统没有安装 secret-tool，无法保存模型 API 密钥");
      }
      if (result.status !== 0) {
        throw new Error("Linux Secret Service 当前不可访问，无法保存模型 API 密钥");
      }
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
      const result = run(LINUX_SECRET_TOOL, [
        "clear", "service", service, "account", account(profileId),
      ], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      if (result.error?.code === "ENOENT") {
        throw new Error("Linux 系统没有安装 secret-tool，无法删除模型 API 密钥");
      }
      if (result.status !== 0) {
        throw new Error("Linux Secret Service 当前不可访问，无法删除模型 API 密钥");
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
    const current = availability();
    if (current.supported) return;
    if (current.failure === "secret-tool-not-found") {
      throw new Error("当前 Linux 系统没有安装 secret-tool");
    }
    if (current.failure === "linux-secret-service-unavailable") {
      throw new Error("Linux Secret Service 当前不可访问或尚未解锁");
    }
    throw new Error("当前系统没有可用的安全凭据存储");
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


// VPS service-owned storage lives outside exported Host data. The installation
// provisions a persistent 32-byte key; losing it is a repair condition, never
// permission to generate a replacement and abandon existing ciphertext.
export function createHeadlessProviderSecretStore(root) {
  function checkedKey() {
    const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) {
      throw new Error("Host secret directory must be private (0700)");
    }
    const path = join(root, "master.key");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
      throw new Error("Host secret key must be private (0600)");
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const key = readFileSync(fd);
      if (key.length !== 32) throw new Error("Host secret key is invalid; restore the original key");
      return key;
    } finally { closeSync(fd); }
  }
  function pathFor(id) { return join(root, `${account(id)}.sealed`); }
  function read(id) {
    const key = checkedKey();
    let bytes;
    try {
      const fd = openSync(pathFor(id), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { bytes = readFileSync(fd); } finally { closeSync(fd); }
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (bytes.length < 29 || bytes[0] !== 1) throw new Error("Invalid Host secret file");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
    decipher.setAAD(Buffer.from(account(id)));
    decipher.setAuthTag(bytes.subarray(13, 29));
    return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8");
  }
  function write(id, value) {
    const key = checkedKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(account(id)));
    const encrypted = Buffer.concat([cipher.update(validatedSecret(value), "utf8"), cipher.final()]);
    const destination = pathFor(id);
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { writeFileSync(fd, Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted])); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, destination);
      const dir = openSync(root, constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { try { unlinkSync(temporary); } catch (e) { if (e.code !== "ENOENT") throw e; } }
  }
  return {
    // A bounded, one-time import from the old desktop backend. Unknown/unreadable
    // keys remain absent and are re-entered through the profile editor; no
    // permanent read-old/read-new fallback participates in normal requests.
    adoptLegacyProfiles(profiles) {
      checkedKey();
      const marker = join(root, "legacy-import-complete");
      try { readFileSync(marker); return; } catch (e) { if (e.code !== "ENOENT") throw e; }
      const legacy = createProviderSecretStore({ platform: "linux", env: {} });
      if (legacy.availability().supported) {
        for (const profile of profiles) {
          if (profile.authMode === "none") continue;
          try {
            if (read(profile.profileId)) continue;
            const value = legacy.read(profile.profileId);
            if (value) {
              write(profile.profileId, value);
              if (read(profile.profileId) !== value) throw new Error("Secret import verification failed");
              // Keep the old copy until a deliberate keyring cleanup; it is never
              // read again by the service-file backend and preserves rollback evidence.
            }
          } catch { /* Missing key is exposed on its profile, not as data deletion. */ }
        }
      }
      writeFileSync(marker, "1\n", { flag: "wx", mode: 0o600 });
    },
    availability() {
      try { checkedKey(); return { supported: true, storage: "linux-service-encrypted-file", failure: null }; }
      catch { return { supported: false, storage: "unavailable", failure: "linux-service-key-repair-required" }; }
    },
    read, write,
    remove(id) { checkedKey(); try { unlinkSync(pathFor(id)); } catch (e) { if (e.code !== "ENOENT") throw e; } },
  };
}
