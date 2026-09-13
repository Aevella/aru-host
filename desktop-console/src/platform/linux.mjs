import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { runWithInput } from "./shared.mjs";
import { desktopReleaseAsset } from "../runtime.mjs";

const SECRET_TOOL = "/usr/bin/secret-tool";

export function createLinuxPlatform({
  homeDir,
  env = process.env,
  serviceName,
  credentialAccount,
  execFile = promisify(execFileCallback),
  fileExists = existsSync,
  writeSecretInput = runWithInput,
} = {}) {
  const baseRoot = env.ARU_LINUX_BASE_ROOT
    ?? join(env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"), "aru-host");
  const instanceRoot = join(baseRoot, "instances", "home");
  const controlPath = join(homeDir, ".local", "bin", "aru-selfhost");
  const unitName = "aru-host-home.service";

  async function serviceAction(action) {
    await execFile("systemctl", ["--user", action, unitName], { timeout: 30_000 });
  }

  function requireSecretTool() {
    if (!fileExists(SECRET_TOOL)) {
      throw new Error("Aru Host needs Linux Secret Service (libsecret-tools) to protect credentials");
    }
  }

  return {
    id: "linux",
    secretStorageId: "linux-secret-service",
    nodeEnvPath: join(instanceRoot, "config", "node.env"),
    installEnvPath: join(instanceRoot, "config", "install.env"),

    hostInstalled() {
      return fileExists(controlPath);
    },

    async runInstaller(hostCoreRoot, releaseVersion) {
      await execFile("/bin/bash", [
        join(hostCoreRoot, "install-linux-desktop.sh"),
        "--source-dir", hostCoreRoot,
        "--instance", "home",
        "--release-version", releaseVersion,
      ], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    },

    async validateState(hostCoreRoot) {
      await execFile("/bin/bash", ["-c",
        'source "$1"; exec "$ARU_NODE_BINARY" "$2" --data-dir "$ARU_DATA_DIR" --container-runtime none --check-state',
        "aru-state-check", join(instanceRoot, "config", "node.env"),
        join(hostCoreRoot, "aru-selfhost-stub.mjs"),
      ], { timeout: 30_000 });
    },

    setupContainerRuntime: () => execFile(controlPath, ["--instance", "home", "setup-runtime"], { maxBuffer: 4 * 1024 * 1024 }),

    startService: () => serviceAction("start"),
    restartService: () => serviceAction("restart"),

    async uninstallHost() {
      await execFile(controlPath, ["--instance", "home", "uninstall"], {
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    },

    async issuePairingOutput() {
      const { stdout } = await execFile(controlPath, ["--instance", "home", "pairing"], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    },

    // The declared boundary has no plaintext fallback: without Secret Service
    // every credential operation fails loudly instead of degrading to a file.
    async readCredential() {
      requireSecretTool();
      try {
        const { stdout } = await execFile(SECRET_TOOL, [
          "lookup", "service", serviceName, "account", credentialAccount,
        ], { timeout: 10_000 });
        return stdout.replace(/[\r\n]+$/, "") || null;
      } catch (error) {
        if (error.code === 1) return null;
        throw new Error("Linux Secret Service could not read the Console credential");
      }
    },

    async writeCredential(value) {
      requireSecretTool();
      await writeSecretInput(
        SECRET_TOOL,
        ["store", "--label=Aru Host Console", "service", serviceName, "account", credentialAccount],
        `${value}\n`,
      );
    },

    async deleteCredential() {
      requireSecretTool();
      try {
        await execFile(SECRET_TOOL, [
          "clear", "service", serviceName, "account", credentialAccount,
        ], { timeout: 10_000 });
      } catch (error) {
        if (error.code !== 1) throw error;
      }
    },

    releaseAssetName(version, arch = process.arch) {
      return desktopReleaseAsset("linux", version, arch);
    },

    async firewallState() {
      return "not-applicable";
    },

    async configureFirewall() {
      throw new Error("Firewall configuration is not managed by the Console on Linux");
    },
  };
}
