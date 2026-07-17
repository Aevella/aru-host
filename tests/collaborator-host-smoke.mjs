#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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

const published = await conversationOptions.executeTool(
  "aru_collaborator_surface_publish",
  { title: "My page", sourceHTML: "<!doctype html><title>Mine</title>" },
  { deviceId: `hosted-collaborator:${owner.collaboratorId}` },
  owner,
);
assert.equal(published.collaboratorId, owner.collaboratorId);
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
