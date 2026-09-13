// The setup command owns verification and persistence. This only waits for the
// restarted service to expose its live capability, including response-body IO.
export async function waitForContainerRuntime(readManifest, { timeoutMs = 90_000, intervalMs = 500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let lastManifest;
  try {
    while (!controller.signal.aborted) {
      try {
        const manifest = await readManifest(controller.signal);
        if (controller.signal.aborted) break;
        lastManifest = manifest;
        if (manifest.capabilities?.["workspace-runtime"]?.enabled) return manifest;
      } catch {
        // Connection refusal is expected while the service is restarting.
      }
      if (!controller.signal.aborted) {
        await new Promise(resolve => {
          const finish = () => {
            clearTimeout(pause);
            controller.signal.removeEventListener("abort", finish);
            resolve();
          };
          const pause = setTimeout(finish, intervalMs);
          controller.signal.addEventListener("abort", finish, { once: true });
        });
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!lastManifest) {
    throw new Error("Containers passed verification, but Host Core did not respond before the readiness check timed out. The runtime setting is saved. Check the Host service status and logs, then refresh.");
  }
  throw new Error(`Containers passed verification, but Host Core still reports the runtime as unavailable (version ${lastManifest.serverVersion ?? "unknown"}). The runtime setting is saved. Check the Host startup logs, then restart the Host service and refresh.`);
}
