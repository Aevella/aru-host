#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollaboratorConversationHost } from "../collaborator-conversations.mjs";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const collaborator = {
  collaboratorId: "hostcol_test",
  displayName: "Test Collaborator",
  driverId: "codex",
  toolAccess: { mode: "all", toolNames: [] },
};
const device = { deviceId: "device_test" };
const root = mkdtempSync(join(tmpdir(), "aru-collaborator-conversation-"));
let clock = 1_000;
let toolExecutions = 0;
let toolCatalogCollaborator = null;
let executionCollaborator = null;
const deferred = [];

const driver = {
  calls: [],
  status: () => "ready",
  async startTurn(options) {
    const { handler } = options;
    this.calls.push(options);
    queueMicrotask(async () => {
      await requestApproval(handler, "item/commandExecution/requestApproval", {
        threadId: "thread_test",
        turnId: "driver_turn_test",
        itemId: "item_command",
        command: "printf hello",
        cwd: root,
      });
      await requestApproval(handler, "item/fileChange/requestApproval", {
        threadId: "thread_test",
        turnId: "driver_turn_test",
        itemId: "item_file",
        reason: "write result",
        cwd: root,
      });
      await handler.onToolCall({ tool: "test_write", arguments: { value: 1 } });
      await handler.onToolCall({ tool: "test_write", arguments: { value: 2 } });
      await handler.onNotification("item/agentMessage/delta", {
        threadId: "thread_test",
        turnId: "driver_turn_test",
        itemId: "assistant_test",
        delta: "hello from computer",
      });
      await handler.onNotification("turn/completed", {
        threadId: "thread_test",
        turn: { id: "driver_turn_test", status: "completed", items: [] },
      });
    });
    return { threadId: "thread_test", turnId: "driver_turn_test" };
  },
  async interrupt() {},
};

const host = createCollaboratorConversationHost({
  dataDir: root,
  driverForCollaborator: () => driver,
  collaboratorForId(id) {
    assert.equal(id, collaborator.collaboratorId);
    return collaborator;
  },
  readJSONBody: async (req) => req.body,
  sendJSON(res, status, body) {
    res.status = status;
    res.body = body;
  },
  HttpError,
  toolCatalog: (owner) => {
    toolCatalogCollaborator = owner;
    return [{
    name: "test_write",
    title: "Test write",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: false },
    }];
  },
  executeTool: async (_name, _args, _device, owner) => {
    toolExecutions += 1;
    executionCollaborator = owner;
    return {};
  },
  now: () => ++clock,
  defer: (operation) => deferred.push(operation),
});

const created = await call("POST", `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/conversations`, {
  title: "Persistent test",
});
assert.equal(created.status, 201);
const conversationId = created.body.conversationId;

const accepted = await call(
  "POST",
  `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/conversations/${conversationId}/messages`,
  { clientRequestId: "client_test_1", text: "Say hello" },
);
assert.equal(accepted.status, 202);
assert.equal(accepted.body.activeTurn.state, "queued");
assert.equal(deferred.length, 1);
deferred.shift()();

let detail = await waitFor((value) => value.pendingApprovalCount === 1);
assert.equal(detail.activeTurn.state, "waitingApproval");
assert.equal(detail.approvals[0].kind, "command");
await decide(detail.approvals[0].approvalId, "allowOnce");

detail = await waitFor((value) => value.pendingApprovalCount === 1 && value.approvals.length === 2);
assert.equal(detail.approvals[1].kind, "fileChange");
await decide(detail.approvals[1].approvalId, "allowOnce");

detail = await waitFor((value) => value.pendingApprovalCount === 1 && value.approvals.length === 3);
assert.equal(detail.approvals[2].kind, "tool");
await decide(detail.approvals[2].approvalId, "allowSession");

detail = await waitFor((value) => value.activeTurn.state === "completed");
assert.equal(detail.messages.at(-1).content, "hello from computer");
assert.equal(detail.approvals.every((approval) => approval.state === "resolved"), true);
assert.equal(driver.calls[0].historyContext, "");
assert.equal(toolExecutions, 2);
assert.equal(toolCatalogCollaborator, collaborator);
assert.equal(executionCollaborator, collaborator);

const second = await call(
  "POST",
  `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/conversations/${conversationId}/messages`,
  { clientRequestId: "client_test_2", text: "Say hello again" },
);
assert.equal(second.status, 202);
assert.equal(deferred.length, 1);
deferred.shift()();
detail = await waitFor((value) => value.activeTurn.state === "waitingApproval");
assert.match(driver.calls[1].historyContext, /User: Say hello/);
assert.match(driver.calls[1].historyContext, /Assistant: hello from computer/);
await decide(detail.approvals.find((approval) => approval.state === "pending").approvalId, "allowOnce");
detail = await waitFor((value) => value.pendingApprovalCount === 1);
await decide(detail.approvals.find((approval) => approval.state === "pending").approvalId, "allowOnce");
detail = await waitFor((value) => value.activeTurn.state === "completed");
assert.equal(toolExecutions, 4);

const events = await call(
  "GET",
  `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/conversations/${conversationId}/events?after=0`,
);
assert.equal(events.body.events.filter((event) => event.kind === "approval.requested").length, 5);
assert.equal(events.body.events.at(-1).kind, "turn.completed");

const ledger = JSON.parse(readFileSync(
  join(root, "collaborator-conversations", collaborator.collaboratorId, `${conversationId}.json`),
  "utf8",
));
assert.equal(ledger.activeTurn.state, "completed");
assert.equal(ledger.messages.at(-1).content, "hello from computer");
console.log("ARU_COLLABORATOR_CONVERSATION_SMOKE_OK");

async function decide(approvalId, decision) {
  const response = await call(
    "POST",
    `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/conversations/${conversationId}/approvals/${approvalId}`,
    { decision },
  );
  assert.equal(response.status, 200);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await call(
      "GET",
      `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/conversations/${conversationId}`,
    );
    if (predicate(response.body)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("conversation state did not advance");
}

async function call(method, rawPath, body = undefined) {
  const url = new URL(rawPath, "http://aru.local");
  const req = { method, url: rawPath, body };
  const res = {};
  const matched = await host.route(req, res, url.pathname, () => device);
  assert.equal(matched, true);
  return res;
}

function requestApproval(handler, method, params) {
  return new Promise((resolve) => {
    handler.onApproval({ method, params, respond: () => resolve() });
  });
}
