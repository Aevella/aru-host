import { spawnSync } from "node:child_process";

const DEFAULT_SERVICE = "cn.aelion.aru.host-provider.v1";

export function createProviderSecretStore({
  platform = process.platform,
  service = DEFAULT_SERVICE,
  run = spawnSync,
} = {}) {
  let cachedAvailability;

  function availability() {
    if (cachedAvailability) return cachedAvailability;
    if (platform !== "darwin") {
      cachedAvailability = {
        supported: false,
        storage: "unavailable",
        failure: "macos-keychain-required",
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
      throw new Error("模型 API 密钥目前只能保存在 macOS 钥匙串中");
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
