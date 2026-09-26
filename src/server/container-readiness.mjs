import { verifyContainerRuntime } from "../../container-runtime-setup.mjs";

// One attempt per Core process, with explicit retries. Preparation is not proof
// of availability in the background service's environment.
export function createContainerReadiness(config, verify = verifyContainerRuntime) {
  let snapshot = { status: config.containerRuntime ? "checking" : "unconfigured", checkedAt: null, message: null };
  let attempt;
  function check() {
    if (attempt) return attempt;
    if (!config.containerRuntime) return Promise.resolve(snapshot);
    snapshot = { status: "checking", checkedAt: null, message: null };
    attempt = Promise.resolve().then(() => verify(config.containerRuntime, {
      allowPull: false,
      setting: (key, fallback) => ({ NODE_IMAGE: config.runtimeImages.node, PYTHON_IMAGE: config.runtimeImages.python,
        SHELL_IMAGE: config.runtimeImages.shell, CONTAINER_MEMORY: config.containerMemory, CONTAINER_CPUS: config.containerCPUs }[key] ?? fallback),
    })).then(() => snapshot = { status: "ready", checkedAt: Date.now(), message: null },
      error => snapshot = { status: "failed", checkedAt: Date.now(), reason: error.code === "engine-unavailable" ? "engine-unavailable" : "execution-failed",
        message: error.code === "engine-unavailable" ? "The configured container engine is unavailable to the Host background process. Start the engine and verify the service user can access it, then retry."
          : "Host Core could not execute the configured Node/Python/Shell container checks. Prepare the images and check workspace access for the Host service user, then retry." })
      .finally(() => { attempt = undefined; });
    return attempt;
  }
  return { check, snapshot: () => ({ ...snapshot }), ready: () => snapshot.status === "ready" };
}
