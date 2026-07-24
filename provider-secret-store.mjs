import { spawnSync } from "node:child_process";

const DEFAULT_SERVICE = "cn.aelion.aru.host-provider.v1";

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
