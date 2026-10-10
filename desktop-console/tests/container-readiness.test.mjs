import test from "node:test";
import assert from "node:assert/strict";
import { waitForContainerRuntime } from "../src/container-readiness.mjs";

const enabled = { capabilities: { "workspace-runtime": { enabled: true } } };
test("waits through restart and unavailable capability until enabled", async () => {
  let calls = 0;
  const result = await waitForContainerRuntime(async () => {
    if (++calls === 1) throw new Error("connection refused");
    return calls === 2 ? { serverVersion: "test" } : enabled;
  }, { timeoutMs: 1000, intervalMs: 1 });
  assert.equal(result, enabled);
  assert.equal(calls, 3);
});
test("aborts a hanging manifest request and allows a later independent attempt", async () => {
  let aborted = false;
  await assert.rejects(waitForContainerRuntime(signal => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }), { timeoutMs: 20 }), /did not respond/);
  assert.equal(aborted, true);
  assert.equal(await waitForContainerRuntime(async () => enabled), enabled);
});
test("an unavailable live capability is not reported as enabled or unreachable", async () => {
  await assert.rejects(waitForContainerRuntime(async () => ({ serverVersion: "stub-0.30", releaseVersion: "test-version" }),
    { timeoutMs: 20, intervalMs: 1 }), /still reports.*test-version/);
});
test("Core execution failure is surfaced immediately without calling it an old release", async () => {
  await assert.rejects(waitForContainerRuntime(async () => ({ releaseVersion: "0.33.1", capabilities: {
    "workspace-runtime": { enabled: false, readiness: { status: "failed", message: "Service user cannot access engine" } },
  } })), /Service user cannot access engine/);
});

test("failure reads authenticated diagnostics once and preserves Podman stderr", async () => {
  let reads = 0;
  await assert.rejects(waitForContainerRuntime(async () => ({ capabilities: {
    "workspace-runtime": { enabled: false, readiness: { status: "failed", message: "Background check failed" } },
  } }), { readDiagnostics: async () => {
    reads++;
    return { failure: { stage: "python", executable: "podman.exe", image: "python:test", detail: "cannot connect to Podman socket" } };
  } }), /python: podman.exe\nImage: python:test\ncannot connect to Podman socket/);
  assert.equal(reads, 1);
});

test("successful readiness never reads private diagnostics", async () => {
  assert.equal(await waitForContainerRuntime(async () => enabled, {
    readDiagnostics: async () => { assert.fail("unnecessary diagnostic request"); },
  }), enabled);
});

test("timeout explains unconfigured Core and failed diagnostic transport does not erase the failure", async () => {
  await assert.rejects(waitForContainerRuntime(async () => ({ releaseVersion: "test" }), {
    timeoutMs: 10, intervalMs: 1, readDiagnostics: async () => ({ status: "unconfigured" }),
  }), /no container executable configured/);
  await assert.rejects(waitForContainerRuntime(async () => ({ capabilities: {
    "workspace-runtime": { readiness: { status: "failed", message: "Engine unavailable" } },
  } }), { readDiagnostics: async () => { throw new Error("route.unknown"); } }), /Engine unavailable[\s\S]*route.unknown/);
});
