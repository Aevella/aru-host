#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createCollaboratorConversationHost } from "../collaborator-conversations.mjs";

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const root = mkdtempSync(join(tmpdir(), "aru-collaborator-attachment-"));
const collaborator = {
  collaboratorId: "hostcol_attachment", displayName: "Attachment Test", driverId: "codex",
  toolAccess: { mode: "all", toolNames: [] }, revision: 1,
};
const device = { deviceId: "device_attachment" };
const deferred = [];
const calls = [];
const driver = {
  validateAttachments(values) { assert.equal(values.length, 1); },
  async startTurn(options) {
    calls.push(options);
    queueMicrotask(() => options.handler.onNotification("turn/completed", {
      threadId: "thread_attachment", turn: { id: "turn_attachment", status: "completed" },
    }));
    return { threadId: "thread_attachment", turnId: "turn_attachment" };
  },
  async interrupt() {},
};
const host = createCollaboratorConversationHost({
  dataDir: root,
  driverForCollaborator: () => driver,
  collaboratorForId: () => collaborator,
  readJSONBody: async (req) => req.body,
  sendJSON(res, status, body) { res.status = status; res.body = body; },
  HttpError,
  toolCatalog: () => [],
  executeTool: async () => ({}),
  defer: (operation) => deferred.push(operation),
});

const created = await call("POST", base(), { title: "attachments" });
const conversationId = created.body.conversationId;
const bytes = Buffer.from("hello attachment\n");
const admitted = await call("POST", `${base()}/${conversationId}/attachments`, {
  clientUploadId: "upload_one",
  filename: "hello.txt",
  mimeType: "text/plain",
  kind: "file",
  byteCount: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
assert.equal(admitted.status, 201);
const attachmentId = admitted.body.attachmentId;
const uploaded = await rawUpload(`${base()}/${conversationId}/attachments/${attachmentId}/content`, bytes);
assert.equal(uploaded.body.state, "ready");

const accepted = await call("POST", `${base()}/${conversationId}/messages`, {
  clientRequestId: "request_attachment", text: "", attachmentIds: [attachmentId],
});
assert.equal(accepted.status, 202);
assert.equal(accepted.body.messages[0].content, "📎 hello.txt");
assert.equal(accepted.body.messages[0].attachments[0].state, "bound");
const deletion = await assert.rejects(
  () => call("DELETE", `${base()}/${conversationId}/attachments/${attachmentId}`),
  (error) => error.code === "attachment.bound",
);
assert.equal(deletion, undefined);
deferred.shift()();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls[0].attachments[0].filename, "hello.txt");
assert.equal(readFileSync(calls[0].attachments[0].path, "utf8"), bytes.toString());

const workspaceFile = join(root, "collaborator-workspaces", collaborator.collaboratorId, "answer.txt");
writeFileSync(workspaceFile, "assistant output");
console.log("ARU_COLLABORATOR_CONVERSATION_ATTACHMENT_SMOKE_OK");

function base() {
  return `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/conversations`;
}

async function call(method, rawPath, body = undefined) {
  const req = { method, url: rawPath, body, headers: {} };
  const res = {};
  const matched = await host.route(req, res, new URL(rawPath, "http://aru.local").pathname, () => device);
  assert.equal(matched, true);
  return res;
}

async function rawUpload(rawPath, bytes) {
  const req = Readable.from([bytes]);
  req.method = "PUT"; req.url = rawPath; req.headers = { "content-length": String(bytes.length) };
  const res = {};
  const matched = await host.route(req, res, new URL(rawPath, "http://aru.local").pathname, () => device);
  assert.equal(matched, true);
  return res;
}
