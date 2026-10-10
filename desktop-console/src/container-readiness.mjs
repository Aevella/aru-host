// Core owns service-environment verification. Wait for its receipt after setup
// or explicit retry, including response-body IO.
export async function waitForContainerRuntime(readManifest, { timeoutMs = 90_000, intervalMs = 500, readDiagnostics } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let lastManifest;
  async function failureError(message) {
    if (readDiagnostics) {
      const diagnosticController = new AbortController();
      const diagnosticTimer = setTimeout(() => diagnosticController.abort(), 5_000);
      try {
        const diagnostics = await readDiagnostics(diagnosticController.signal);
        if (diagnostics.failure) {
          const { stage, executable, image, detail } = diagnostics.failure;
          message += `\n${stage}: ${executable}${image ? `\nImage: ${image}` : ""}\n${detail}`;
        } else if (diagnostics.status === "unconfigured") {
          message += "\nThe running Host has no container executable configured. Verify and enable the runtime again.";
        } else if (diagnostics.status === "checking") {
          message += "\nThe Host check is still running. Retry verification to read its completed result.";
        }
      } catch (error) {
        // Older installed Hosts do not expose the authenticated diagnostic route.
        message += `\nCould not read Host runtime diagnostics: ${error.message}`;
      } finally { clearTimeout(diagnosticTimer); }
    }
    return Object.assign(new Error(message), { code: "core_runtime_verification_failed" });
  }
  try {
    while (!controller.signal.aborted) {
      try {
        const manifest = await readManifest(controller.signal);
        if (controller.signal.aborted) break;
        lastManifest = manifest;
        if (manifest.capabilities?.["workspace-runtime"]?.enabled) return manifest;
        if (manifest.capabilities?.["workspace-runtime"]?.readiness?.status === "failed") {
          throw await failureError(manifest.capabilities["workspace-runtime"].readiness.message);
        }
      } catch (error) {
        if (error.code === "core_runtime_verification_failed") throw error;
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
    throw new Error("Host Core did not respond before the readiness check timed out. The runtime setting is saved. Check the Host service status and logs, then refresh.");
  }
  throw await failureError(`Host Core still reports the runtime as unavailable (version ${lastManifest.releaseVersion ?? "unknown release"}). The runtime setting is saved.`);
}
