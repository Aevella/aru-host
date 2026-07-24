#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollaboratorHost } from "../collaborator-host.mjs";

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
const secretStore = {
  availability: () => ({ supported: true, storage: "test", failure: null }),
  read: () => { secretReadCount += 1; return "test-key"; },
  write() {},
  remove() {},
};
const root = mkdtempSync(join(tmpdir(), "aru-collaborator-host-"));
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
  now: () => 20,
});

const claudeOnly = host.driverInventory();
assert.equal(claudeOnly.drivers.find((driver) => driver.id === "claude-code").status, "ready");
assert.equal(claudeOnly.execution.enabled, false);

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
