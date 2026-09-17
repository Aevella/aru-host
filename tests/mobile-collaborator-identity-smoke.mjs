import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollaboratorHost } from "../collaborator-host.mjs";

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const root = mkdtempSync(join(tmpdir(), "aru-mobile-identity-"));
const stateFile = join(root, "state.json");
let state = { agentDriverProbes: ["codex", "claude-code"].map(id => ({ id, status: "unavailable", checkedAt: 1 })) };
let device = { deviceId: "paired-phone" };
let authorized = true;
let failWrite = false;
let revokeWhileReading = false;
const build = () => createCollaboratorHost({
  dataDir: root, state,
  saveState: () => {
    if (failWrite) throw new Error("test disk write failure");
    writeFileSync(stateFile, JSON.stringify(state));
  },
  readJSONBody: async (req) => {
    if (revokeWhileReading) authorized = false;
    return req.body;
  },
  sendJSON: (res, status, body) => Object.assign(res, { status, body }),
  HttpError, managedWorkspaceRoot: root,
  providerSecretStore: { availability: () => ({ supported: false }), read: () => null },
});
let host = build();
async function call(method, path, body) {
  const res = {};
  assert.equal(await host.route({ method, body }, res, path, () => {
    if (!authorized) throw new HttpError(401, "device.revoked", "revoked");
    return device;
  }, () => device), true);
  return res.body;
}
const sourceA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const sourceB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const enroll = (source, displayName = "Phone") => call("PUT", `/aru/v1/mobile-collaborator-identities/${source}`, { displayName });
try {
  assert.equal(host.driverInventory().execution.enabled, false);
  revokeWhileReading = true;
  await assert.rejects(enroll(sourceA), { status: 401 });
  assert.equal(state.mobileCollaboratorIdentities.length, 0);
  revokeWhileReading = false; authorized = true;
  failWrite = true;
  await assert.rejects(enroll(sourceA), /disk write failure/);
  assert.equal(state.mobileCollaboratorIdentities.length, 0);
  failWrite = false;
  const [a, duplicate] = await Promise.all([enroll(sourceA), enroll(sourceA)]);
  assert.equal(a.collaboratorId, duplicate.collaboratorId);
  assert.equal(a.authority, "phone");
  assert.equal(a.turnExecution, false);
  failWrite = true;
  await assert.rejects(enroll(sourceA, "Failed rename"), /disk write failure/);
  assert.equal(state.mobileCollaboratorIdentities[0].displayName, "Phone");
  failWrite = false;
  const b = await enroll(sourceB);
  assert.notEqual(a.collaboratorId, b.collaboratorId);
  assert.equal(state.hostedCollaborators.length, 0);
  assert.equal(host.collaboratorInventory().mobileIdentities.length, 2);
  const project = await host.callProjectTool("aru_collaborator_project_create", {
    collaboratorId: a.collaboratorId, title: "Driver-free page",
  }, device).value;
  const published = await host.callProjectTool("aru_collaborator_project_publish", {
    collaboratorId: a.collaboratorId, projectId: project.projectId,
    expectedRevision: project.revision, networkAccess: "none",
  }, device).value;
  assert.ok(published.project.surfaceId);
  const surfaces = host.callSurfaceTool("aru_collaborator_surface_inventory", { collaboratorId: a.collaboratorId }, device).value;
  assert.equal(surfaces.surfaces.length, 1);
  assert.equal((await host.callProjectTool("aru_collaborator_project_inventory", { collaboratorId: b.collaboratorId }, device).value).projects.length, 0);
  await assert.rejects(call("GET", `/aru/v1/hosted-collaborators/${b.collaboratorId}/projects/${project.projectId}`), { status: 404 });
  // Artifact identities cannot enter computer cognition or execution endpoints.
  await assert.rejects(call("GET", `/aru/v1/hosted-collaborators/${a.collaboratorId}/cognition`), { code: "collaborator.unknown" });
  authorized = false;
  await assert.rejects(enroll(sourceA), { status: 401 });
  assert.equal(state.mobileCollaboratorIdentities.length, 2);
  authorized = true;
  // Restart + new pairing + rename restores the original artifact namespace.
  host.stop(); state = JSON.parse(readFileSync(stateFile, "utf8")); host = build();
  device = { deviceId: "repaired-phone" };
  const restored = await enroll(sourceA, "Renamed phone collaborator");
  assert.equal(restored.collaboratorId, a.collaboratorId);
  assert.equal(restored.displayName, "Renamed phone collaborator");
  assert.equal((await host.callProjectTool("aru_collaborator_project_inventory", { collaboratorId: restored.collaboratorId }, device).value).projects.length, 1);
  await assert.rejects(enroll("../escape"));
  assert.equal(state.hostedCollaborators.length, 0);
  assert.equal(host.driverInventory().execution.enabled, false);
  console.log("PASS mobile identity: no driver, idempotency, isolation, publication, revoke, restart and re-pair");
} finally { host.stop(); rmSync(root, { recursive: true, force: true }); }
