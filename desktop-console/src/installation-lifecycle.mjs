import { readInstalledVersion } from "./runtime.mjs";
import { waitForCoreRelease } from "./core-release.mjs";

// All Console start/retry/restart entrypoints share admission and live verification.
// Platform installers retain ownership of activation and rollback; no new receipt.
export function createInstallationLifecycle({ platform, readRelease, consoleVersion,
  hostCoreRoot, readInstalled, readManifest, verify = waitForCoreRelease }) {
  let active;
  async function run({ restart = false }) {
    const release = await readRelease();
    if (release.schema !== "aru.host.release.v1" || release.version !== consoleVersion) {
      throw new Error("The bundled Host Core does not match this Console release");
    }
    const previous = await readManifest(AbortSignal.timeout(3_000)).catch(() => null);
    let installedVersion = null;
    try { installedVersion = readInstalledVersion(await readInstalled()); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const installed = await platform.hostInstalled();
    if (installedVersion !== release.version || !installed) {
      await platform.runInstaller(hostCoreRoot, release.version);
    } else {
      await platform.validateState(hostCoreRoot);
      if (restart) await platform.restartService();
      else await platform.startService();
      const running = await readManifest(AbortSignal.timeout(3_000)).catch(() => null);
      if (!restart && running && running.releaseVersion !== release.version) await platform.restartService();
    }
    const check = () => verify(readManifest, { version: release.version, serverId: previous?.serverId });
    try { return await check(); }
    catch (error) {
      if (error.code !== "core_release_mismatch" || installedVersion !== release.version) throw error;
      await platform.runInstaller(hostCoreRoot, release.version);
      return check();
    }
  }
  return {
    ensure(options = {}) {
      if (!active) active = run(options).finally(() => { active = undefined; });
      return active;
    },
  };
}
