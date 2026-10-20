import { requestFailure } from "./host-request.mjs";

// Installation receipts describe disk. Only a valid live manifest can authorize
// release repair. A failed read is not evidence of a mismatched installation.
export async function waitForCoreRelease(readManifest, { version, serverId, timeoutMs = 30_000, intervalMs = 250 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let last;
  let failure;
  try {
    while (!controller.signal.aborted) {
      try {
        const value = await readManifest(controller.signal);
        if (!value || typeof value !== "object" || typeof value.serverId !== "string" || !value.serverId.trim()) {
          throw requestFailure("manifest", null, "missing Host identity");
        }
        if (serverId && value.serverId !== serverId) throw Object.assign(new Error("The running Host identity changed. Installation has not been accepted."), { code: "host_identity_changed" });
        if (typeof value.releaseVersion !== "string" || !value.releaseVersion.trim()) {
          throw requestFailure("manifest", null, "missing release version");
        }
        // A response arriving after the overall deadline cannot accept activation.
        if (controller.signal.aborted) {
          last = undefined;
          failure ??= requestFailure("deadline", null, "response arrived after deadline");
          break;
        }
        last = value;
        failure = undefined;
        if (value.releaseVersion === version) return value;
      } catch (error) {
        if (error.code === "host_identity_changed") throw error;
        // Deadline cancellation must not erase a more informative previous error.
        if (!controller.signal.aborted || !failure) {
          failure = error.stage ? error : requestFailure("request", error);
        }
        last = undefined;
      }
      await new Promise(resolve => {
        const finish = () => { clearTimeout(delay); controller.signal.removeEventListener("abort", finish); resolve(); };
        const delay = setTimeout(finish, intervalMs);
        controller.signal.addEventListener("abort", finish, { once: true });
        if (controller.signal.aborted) finish();
      });
    }
  } finally { clearTimeout(timer); }
  throw Object.assign(new Error(`Host Core startup is not verified: expected ${version}, running ${last?.releaseVersion ?? "unknown"}.${failure ? ` ${failure.message}` : " No matching live release was verified before the deadline."}`, { cause: failure }), { code: last ? "core_release_mismatch" : "core_unreachable" });
}
