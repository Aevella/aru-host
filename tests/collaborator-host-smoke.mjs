#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeDesktopExecutableCandidates,
  createCollaboratorHost,
} from "../collaborator-host.mjs";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const profileId = "provider_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const state = {
  agentDriverProbes: [
    { id: "codex", status: "unavailable", version: null, failure: "not-installed", checkedAt: 10 },
    { id: "claude-code", status: "ready", version: "1.0", failure: null, checkedAt: 10 },
  ],
  hostedCollaborators: [],
  providerProfiles: [],
};
let secretReadCount = 0;
let conversationOptions;
let clock = 20;
let probeCalls = 0;
const probeStatuses = { codex: "unavailable", "claude-code": "ready" };
const probeLocalDriver = (definition, checkedAt) => {
  probeCalls += 1;
  const status = probeStatuses[definition.id];
  return status === "ready"
    ? { id: definition.id, status, version: "1.0", checkedAt, failure: null }
    : { id: definition.id, status, version: null, checkedAt, failure: "command-not-found" };
};
// Background retries stay pending until the test releases them, so the read that triggers
// a retry and any concurrent reads can be observed before the result lands.
const pendingRetries = [];
const retryLocalDriverProbe = (definition, checkedAt) => new Promise((resolve) => {
  const status = probeStatuses[definition.id];
  pendingRetries.push(() => {
    const currentStatus = probeStatuses[definition.id];
    probeStatuses[definition.id] = status;
    const result = probeLocalDriver(definition, checkedAt);
    probeStatuses[definition.id] = currentStatus;
    resolve(result);
  });
});
const secretStore = {
  availability: () => ({ supported: true, storage: "test", failure: null }),
  read: () => { secretReadCount += 1; return "test-key"; },
  write() {},
  remove() {},
};
const root = mkdtempSync(join(tmpdir(), "aru-collaborator-host-"));
const desktopClaudeRoot = join(root, "Library/Application Support/Claude/claude-code");
mkdirSync(join(desktopClaudeRoot, "2.1.99"), { recursive: true });
mkdirSync(join(desktopClaudeRoot, "2.1.246"), { recursive: true });
assert.deepEqual(claudeDesktopExecutableCandidates(root), [
  join(desktopClaudeRoot, "2.1.246/claude.app/Contents/MacOS/claude"),
  join(desktopClaudeRoot, "2.1.99/claude.app/Contents/MacOS/claude"),
]);
const host = createCollaboratorHost({
  dataDir: root,
  state,
  saveState() {},
  readJSONBody: async (req) => req.body,
  sendJSON(res, status, body) { res.status = status; res.body = body; },
  HttpError,
  managedWorkspaceRoot: root,
  providerSecretStore: secretStore,
  toolCatalog: () => [{
    name: "aru_collaborator_surface_inventory",
    inputSchema: {
      type: "object",
      properties: { collaboratorId: { type: "string" } },
      required: ["collaboratorId"],
    },
  }, {
    name: "test_other_tool",
    inputSchema: { type: "object", properties: {} },
  }],
  conversationHostFactory: (options) => {
    conversationOptions = options;
    return {
      route: async () => false,
      status: () => ({ conversationCount: 0, activeTurnCount: 0, pendingApprovalCount: 0 }),
    };
  },
  now: () => clock,
  probeLocalDriver,
  retryLocalDriverProbe,
});

// Startup re-probes local drivers instead of trusting the persisted result.
assert.equal(probeCalls, 2);
assert.equal(state.agentDriverProbes.every((probe) => probe.checkedAt === 20), true);

const claudeOnly = host.driverInventory();
assert.equal(claudeOnly.drivers.find((driver) => driver.id === "claude-code").status, "ready");
assert.equal(claudeOnly.execution.enabled, true);

// A CLI installed after the last probe is picked up on read once the old result is stale.
const readDrivers = async () => {
  const response = {};
  assert.equal(await host.route(
    { method: "GET", url: "/aru/v1/agent-drivers" },
    response,
    "/aru/v1/agent-drivers",
    () => ({ deviceId: "device_test" }),
    () => {},
  ), true);
  assert.equal(response.status, 200);
  return response.body;
};
const driverStatus = (inventory, id) => inventory.drivers.find((driver) => driver.id === id).status;
probeStatuses.codex = "ready";
probeCalls = 0;
assert.equal(driverStatus(await readDrivers(), "codex"), "unavailable");
assert.equal(pendingRetries.length, 0, "a fresh unavailable probe is not retried on read");
clock += 30_000;
assert.equal(driverStatus(await readDrivers(), "codex"), "unavailable", "the triggering read answers without waiting");
assert.equal(driverStatus(await readDrivers(), "codex"), "unavailable");
assert.equal(pendingRetries.length, 1, "only the stale unready driver is retried, and concurrent reads share one retry");
pendingRetries.splice(0).forEach((release) => release());
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(probeCalls, 1, "ready drivers are not re-probed by the retry");
const retried = await readDrivers();
assert.equal(driverStatus(retried, "codex"), "ready");
assert.equal(driverStatus(retried, "claude-code"), "ready");
assert.equal(state.agentDriverProbes.find((probe) => probe.id === "claude-code").checkedAt, 20);
assert.equal(state.agentDriverProbes.find((probe) => probe.id === "codex").checkedAt, 30_020);
assert.equal(pendingRetries.length, 0, "ready drivers are not retried on later reads");
// An older automatic probe must not overwrite a newer manual result, even
// when both attempts have the same clock timestamp. Concurrent manual refreshes
// share their work, and GET plus the event loop remain responsive while they wait.
state.agentDriverProbes.find((probe) => probe.id === "codex").status = "unavailable";
probeStatuses.codex = "unavailable";
clock += 30_000;
await readDrivers();
assert.equal(pendingRetries.length, 1);
const releaseOldRetry = pendingRetries.shift();
probeStatuses.codex = "ready";
let manualCompleted = false;
const refreshDrivers = async () => {
  const response = {};
  await host.route({ method: "POST" }, response, "/aru/v1/agent-drivers/refresh",
    () => ({ deviceId: "device_test" }), () => {});
  return response.body;
};
const firstManual = refreshDrivers().then((value) => { manualCompleted = true; return value; });
const secondManual = refreshDrivers();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(manualCompleted, false, "manual response waits without blocking the event loop");
assert.equal(pendingRetries.length, 2, "concurrent manual refreshes share a single full probe");
assert.equal(driverStatus(await readDrivers(), "codex"), "unavailable");
assert.equal(pendingRetries.length, 2, "GET does not start another retry during manual refresh");
pendingRetries.splice(0).forEach((release) => release());
assert.equal(driverStatus(await firstManual, "codex"), "ready");
assert.equal(driverStatus(await secondManual, "codex"), "ready");
const manualResult = structuredClone(state.agentDriverProbes);
releaseOldRetry();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(state.agentDriverProbes, manualResult, "late old result cannot undo a manual refresh");
clock = 20;

state.providerProfiles.push({
  profileId,
  displayName: "Unhealthy API",
  protocol: "openai-compatible",
  baseURL: "https://api.example.test/",
  path: "v1/chat/completions",
  model: "test-model",
  authMode: "bearer",
  maxOutputTokens: null,
  maxToolRounds: null,
  revision: 1,
  createdAt: 10,
  updatedAt: 10,
  health: "unhealthy",
  lastCheckedAt: 10,
  lastError: "temporary failure",
});
for (const suffix of ["a", "b"]) {
  state.hostedCollaborators.push({
    collaboratorId: `hostcol_${suffix.repeat(32)}`,
    displayName: `Collaborator ${suffix}`,
    driverId: "api",
    providerProfileId: profileId,
    revision: 1,
    createdAt: 10,
    updatedAt: 10,
    archivedAt: null,
    toolAccess: { mode: "all", toolNames: [] },
  });
}

const withUnhealthyAPI = host.driverInventory();
assert.equal(withUnhealthyAPI.drivers.find((driver) => driver.id === "api").status, "unhealthy");
assert.equal(withUnhealthyAPI.execution.enabled, true);

secretReadCount = 0;
const collaborators = host.collaboratorInventory().collaborators;
assert.equal(secretReadCount, 1);
assert.equal(collaborators.length, 2);
assert.equal(collaborators.every((item) => item.turnExecution), true);
assert.equal(collaborators.every((item) => item.activationStatus === "driver-unhealthy"), true);

const owner = state.hostedCollaborators[0];
const otherOwner = state.hostedCollaborators[1];
const conversationTools = conversationOptions.toolCatalog(owner);
assert.equal(conversationTools.some((tool) => tool.name === "test_other_tool"), true);
const publishTool = conversationTools.find((tool) => tool.name === "aru_collaborator_surface_publish");
assert.ok(publishTool);
assert.equal("collaboratorId" in publishTool.inputSchema.properties, false);
assert.equal(publishTool.inputSchema.required.includes("collaboratorId"), false);
assert.deepEqual(publishTool.inputSchema.properties.networkAccess.enum, ["none", "outbound"]);
const runtimeTool = conversationTools.find((tool) => tool.name === "aru_collaborator_surface_runtime");
assert.ok(runtimeTool);
assert.equal("collaboratorId" in runtimeTool.inputSchema.properties, false);
const initiativeCreateTool = conversationTools.find(
  (tool) => tool.name === "aru_collaborator_initiative_create",
);
assert.ok(initiativeCreateTool);
assert.equal("collaboratorId" in initiativeCreateTool.inputSchema.properties, false);
assert.deepEqual(
  initiativeCreateTool.inputSchema.required,
  ["expectedRevision", "title", "goal", "fireAfterMinutes", "recurrenceMinutes"],
);
assert.equal(initiativeCreateTool.outputSchema.properties.rules.type, "array");

let ownInitiative = await conversationOptions.executeTool(
  "aru_collaborator_initiative_read",
  {},
  { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
  owner,
);
ownInitiative = await conversationOptions.executeTool(
  "aru_collaborator_initiative_create",
  {
    expectedRevision: ownInitiative.revision,
    title: "Keep in touch",
    goal: "Check in with the user later",
    fireAfterMinutes: 15,
    recurrenceMinutes: 0,
  },
  { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
  owner,
);
assert.equal(ownInitiative.collaboratorId, owner.collaboratorId);
assert.equal(ownInitiative.rules.length, 1);
assert.equal(ownInitiative.rules[0].nextFireAt, 900_020);
assert.equal(ownInitiative.rules[0].notificationsEnabled, true);
await assert.rejects(
  conversationOptions.executeTool(
    "aru_collaborator_initiative_create",
    {
      collaboratorId: otherOwner.collaboratorId,
      expectedRevision: ownInitiative.revision,
      title: "Forged initiative",
      goal: "Write another collaborator's rules",
      fireAfterMinutes: 15,
      recurrenceMinutes: 0,
    },
    { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
    owner,
  ),
  (error) => error.code === "initiative.owner_scope_fixed",
);

const published = await conversationOptions.executeTool(
  "aru_collaborator_surface_publish",
  { title: "My page", sourceHTML: "<!doctype html><title>Mine</title>", networkAccess: "outbound" },
  { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
  owner,
);
assert.equal(published.collaboratorId, owner.collaboratorId);
assert.equal(published.networkAccess, "outbound");
assert.equal(published.storageMode, "isolated-persistent");
const runtimeUpdated = await conversationOptions.executeTool(
  "aru_collaborator_surface_runtime",
  { surfaceId: published.surfaceId, expectedRevision: published.revision, networkAccess: "none" },
  { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
  owner,
);
assert.equal(runtimeUpdated.networkAccess, "none");
assert.equal(runtimeUpdated.revision, published.revision + 1);

const projectDirectory = join(root, "collaborator-workspaces", owner.collaboratorId, "aurora", "dist", "assets");
mkdirSync(projectDirectory, { recursive: true });
writeFileSync(join(root, "collaborator-workspaces", owner.collaboratorId, "aurora", "dist", "index.html"),
  '<!doctype html><link rel="stylesheet" href="assets/app.css"><main>Project</main>');
writeFileSync(join(projectDirectory, "app.css"), "main{color:rebeccapurple}");
const projectSurface = await conversationOptions.executeTool(
  "aru_collaborator_surface_publish_project",
  { title: "Project page", projectPath: "aurora/dist", entryPath: "index.html" },
  { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
  owner,
);
assert.equal(projectSurface.delivery, "bundle");
assert.equal(projectSurface.files.length, 2);
assert.equal(projectSurface.sourceHTML, null);
const bundleResponse = {};
assert.equal(await host.route(
  { method: "GET", url: `/aru/v1/hosted-collaborators/${owner.collaboratorId}/surfaces/${projectSurface.surfaceId}/versions/${projectSurface.activeVersionId}/bundle` },
  bundleResponse,
  `/aru/v1/hosted-collaborators/${owner.collaboratorId}/surfaces/${projectSurface.surfaceId}/versions/${projectSurface.activeVersionId}/bundle`,
  () => ({ deviceId: "device_test" }),
  () => {},
), true);
assert.equal(bundleResponse.status, 200);
assert.equal(bundleResponse.body.files.length, 2);
const entryFile = bundleResponse.body.files.find((file) => file.path === "index.html");
assert.ok(entryFile);
assert.match(Buffer.from(entryFile.contentBase64, "base64").toString("utf8"), /Project/);
await assert.rejects(
  conversationOptions.executeTool(
    "aru_collaborator_surface_publish_project",
    { title: "Escaped", projectPath: "../outside" },
    { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
    owner,
  ),
  (error) => error.code === "surface.projectPath_invalid",
);
const linkedAsset = join(root, "collaborator-workspaces", owner.collaboratorId, "aurora", "dist", "linked-assets");
symlinkSync("assets", linkedAsset);
await assert.rejects(
  conversationOptions.executeTool(
    "aru_collaborator_surface_publish_project",
    { title: "Linked", projectPath: "aurora/dist" },
    { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
    owner,
  ),
  (error) => error.code === "surface.project_symlink",
);
unlinkSync(linkedAsset);
assert.equal(conversationOptions.toolCatalog(otherOwner).length, conversationTools.length);
await assert.rejects(
  conversationOptions.executeTool(
    "aru_collaborator_surface_publish",
    {
      collaboratorId: otherOwner.collaboratorId,
      title: "Forged page",
      sourceHTML: "<!doctype html><title>Forged</title>",
    },
    { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
    owner,
  ),
  (error) => error.code === "surface.owner_scope_fixed",
);

console.log("ARU_COLLABORATOR_HOST_SMOKE_OK");

const createRequest = {
  method: "POST", body: { displayName: "Phone-created", driverId: "claude-code",
    requestId: "33333333-3333-4333-8333-333333333333" },
};
const firstCreate = {}, repeatedCreate = {};
await host.route(createRequest, firstCreate, "/aru/v1/hosted-collaborators", () => ({ deviceId: "phone-create" }), () => {});
await host.route(createRequest, repeatedCreate, "/aru/v1/hosted-collaborators", () => ({ deviceId: "phone-create" }), () => {});
assert.equal(firstCreate.body.collaboratorId, repeatedCreate.body.collaboratorId);
assert.equal(state.hostedCollaborators.filter((item) => item.createRequestId === createRequest.body.requestId).length, 1);
console.log("ARU_HOST_CREATE_REPLAY_SMOKE_OK");

const claudeCreate = {};
await host.route({ method: "POST", body: { displayName: "Claude", driverId: "claude-code" } }, claudeCreate,
  "/aru/v1/hosted-collaborators", () => ({ deviceId: "phone-create" }), () => {});
assert.equal(claudeCreate.body.driverId, "claude-code");
assert.equal(host.driverInventory().drivers.find((driver) => driver.id === "claude-code").executesTurns, true);
await assert.rejects(
  host.route({ method: "POST", body: { displayName: "Unknown", driverId: "unknown-driver" } }, {},
    "/aru/v1/hosted-collaborators", () => ({ deviceId: "phone-create" }), () => {}),
  (error) => error.status === 400,
);
console.log("ARU_HOST_CLAUDE_CODE_DRIVER_SMOKE_OK");
