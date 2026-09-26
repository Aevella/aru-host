// Installation receipts describe disk. Only the live process can prove which
// Core owns the port after a start or upgrade.
export async function waitForCoreRelease(readManifest, { version, serverId, timeoutMs = 30_000, intervalMs = 250 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let last;
  try {
    while (!controller.signal.aborted) {
      try {
        last = await readManifest(controller.signal);
        if (serverId && last.serverId !== serverId) throw Object.assign(new Error("The running Host identity changed. Installation has not been accepted."), { code: "host_identity_changed" });
        if (last.releaseVersion === version) return last;
      } catch (error) { if (error.code === "host_identity_changed") throw error; }
      await new Promise(resolve => {
        const finish = () => { clearTimeout(delay); controller.signal.removeEventListener("abort", finish); resolve(); };
        const delay = setTimeout(finish, intervalMs);
        controller.signal.addEventListener("abort", finish, { once: true });
        if (controller.signal.aborted) finish();
      });
    }
  } finally { clearTimeout(timer); }
  throw Object.assign(new Error(`Host Core startup is not verified: expected ${version}, running ${last?.releaseVersion ?? "unknown"}. Restart the Host service and retry; the installation receipt is not runtime proof.`), { code: last ? "core_release_mismatch" : "core_unreachable" });
}
