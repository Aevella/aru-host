import assert from "node:assert/strict";
import test from "node:test";
import { createPluginWorkshop } from "../src/plugins/plugin-workshop.mjs";

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fixture() {
  const state = { plugins: [], pluginDrafts: [] };
  let saved;
  const workshop = createPluginWorkshop({
    state, HttpError, saveState: () => { saved = structuredClone(state); }, log() {},
    sourceRuntime: {
      available: true, validateDraft: async () => ({ digest: "sha256:fixture", tools: [] }),
      store() {}, readPackage: () => "export const tools = [];",
    },
    pluginRecord: id => state.plugins.find(p => p.pluginId === id),
    publicPlugin: p => p, validPluginId: id => typeof id === "string" && /^[a-z-]+$/.test(id),
    validatePluginManifest: m => assert.equal(typeof m.publisher, "string"),
    stopPlugin() {}, appendPluginEvent() {}, assertDynamicToolNamesAvailable() {},
    enablePlugin: async id => state.plugins.find(p => p.pluginId === id),
    sendJSON: (res, status, body) => { res.body = body; res.status = status; },
  });
  return { workshop, state, saved: () => saved };
}
const request = { pluginId: "sample", displayName: "Sample", version: "1.0", sourceCode: "export const tools = [];" };
const device = { deviceId: "test-device" };

test("publisher survives draft, publish, source export and omitted-credit update", async () => {
  const f = fixture();
  const draft = await f.workshop.saveSourceDraft({ ...request, publisher: " Studio " }, device);
  assert.equal(draft.publisher, "Studio");
  assert.equal(f.saved().pluginDrafts[0].publisher, "Studio");
  const result = await f.workshop.applyDraft(request.pluginId, device);
  assert.equal(result.plugin.manifest.publisher, "Studio");
  const response = {};
  await f.workshop.route({ method: "GET" }, response, "/aru/v1/plugins/sample/source", () => device);
  assert.equal(response.body.publisher, "Studio");
  const updated = await f.workshop.saveSourceDraft({ ...request, version: "2.0" }, device);
  assert.equal(updated.publisher, "Studio");
  // A metadata-only correction must not be rejected as an unchanged source release.
  const corrected = await f.workshop.applySource({ ...request, publisher: "Studio & Friend" }, device);
  assert.equal(corrected.plugin.manifest.publisher, "Studio & Friend");
});

test("invalid publisher cannot replace durable drafts; old clients remain admitted", async () => {
  const f = fixture();
  await f.workshop.saveSourceDraft(request, device);
  assert.equal(f.state.pluginDrafts[0].publisher, "Aru workshop");
  const before = structuredClone(f.state);
  await assert.rejects(f.workshop.saveSourceDraft({ ...request, publisher: {} }, device), /publisher must be a string/);
  assert.deepEqual(f.state, before);
});
