import { verifyContainerRuntime } from "../../container-runtime-setup.mjs";

// One attempt per Core process, with explicit retries. Preparation is not proof
// of availability in the background service's environment.
export function createContainerReadiness(config, verify = verifyContainerRuntime) {
  let snapshot = { status: config.containerRuntime ? "checking" : "unconfigured", checkedAt: null, message: null };
  let attempt;
  let failure;
  function check() {
    if (attempt) return attempt;
    if (!config.containerRuntime) return Promise.resolve(snapshot);
    snapshot = { status: "checking", checkedAt: null, message: null };
    failure = undefined;
    const options = {
      allowPull: false,
      setting: (key, fallback) => ({ NODE_IMAGE: config.runtimeImages.node, PYTHON_IMAGE: config.runtimeImages.python,
        SHELL_IMAGE: config.runtimeImages.shell, CONTAINER_MEMORY: config.containerMemory, CONTAINER_CPUS: config.containerCPUs }[key] ?? fallback),
    };
    attempt = Promise.resolve().then(async () => {
      try {
        await verify(config.containerRuntime, options);
        return { resourceLimits: true };
      } catch (error) {
        // Only retry the synthetic probe for the specific rootless cgroup denial.
        // Never retry an actual workspace job which might already have run.
        const detail = String(error.detail ?? error.message ?? "");
        if (!/rootless needs no limits \+ no cgroup path when no permission is granted for cgroups/i.test(detail)) throw error;
        let cgroupsDisabled = false;
        try {
          await verify(config.containerRuntime, { ...options, resourceLimits: false });
        } catch (unlimitedError) {
          const unlimitedDetail = String(unlimitedError.detail ?? unlimitedError.message ?? "");
          if (!/rootless needs no limits \+ no cgroup path when no permission is granted for cgroups/i.test(unlimitedDetail)) throw unlimitedError;
          await verify(config.containerRuntime, { ...options, resourceLimits: false, cgroupsDisabled: true });
          cgroupsDisabled = true;
        }
        failure = { stage: "resource-limits", executable: config.containerRuntime, detail };
        return { resourceLimits: false, cgroupsDisabled };
      }
    }).then(result => snapshot = { status: "ready", checkedAt: Date.now(), message: null, ...result },
      error => {
        failure = { stage: error.stage ?? "workspace", executable: config.containerRuntime,
          image: error.image ?? null, detail: error.detail ?? error.message };
        return snapshot = { status: "failed", checkedAt: Date.now(), reason: error.code === "engine-unavailable" ? "engine-unavailable" : "execution-failed",
        message: error.code === "engine-unavailable" ? "The configured container engine is unavailable to the Host background process. Start the engine and verify the service user can access it, then retry."
          : "Host Core could not execute the configured Node/Python/Shell container checks. Prepare the images and check workspace access for the Host service user, then retry." };
      })
      .finally(() => { attempt = undefined; });
    return attempt;
  }
  return { check, snapshot: () => ({ ...snapshot }),
    diagnostics: () => ({ ...snapshot, executable: config.containerRuntime, ...(failure ? { failure: { ...failure } } : {}) }),
    ready: () => snapshot.status === "ready",
    resourceLimits: () => snapshot.resourceLimits !== false,
    cgroupsDisabled: () => snapshot.cgroupsDisabled === true };
}
