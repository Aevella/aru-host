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
  await assert.rejects(waitForContainerRuntime(async () => ({ serverVersion: "test-version" }),
    { timeoutMs: 20, intervalMs: 1 }), /still reports.*test-version/);
});
