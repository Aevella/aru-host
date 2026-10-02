import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollaboratorConversationHost } from "../src/conversations/collaborator-conversations.mjs";
import { messagePage, syncProjection } from "../src/conversations/conversation-sync.mjs";
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const messages = count => Array.from({ length: count }, (_, i) => ({ messageId: `m${i}`, role: i % 2 ? "assistant" : "user",
  content: `message ${i}`, status: "completed", createdAt: i, updatedAt: i, clientRequestId: "private", driverText: "private" }));
const ledger = count => ({ collaboratorId: "aru", conversationId: "chat", messages: messages(count), approvals: [], events: [], activeTurn: null });

test("history uses stable anchors, bounded pages and never exposes private driver input", () => {
  const value = ledger(150);
  const latest = messagePage(value, null, HttpError);
  assert.equal(latest.messages.length, 64); assert.equal(latest.before, "m86"); assert.equal(latest.hasMore, true);
  const older = messagePage(value, latest.before, HttpError);
  assert.equal(older.before, "m22"); assert.equal(older.messages.at(-1).messageId, "m85");
  value.messages.push(...messages(2).map((item, i) => ({ ...item, messageId: `new${i}` })));
  assert.deepEqual(messagePage(value, latest.before, HttpError), older);
  assert.equal(messagePage(value, "m22", HttpError).hasMore, false);
  assert.equal("driverText" in latest.messages[0], false);
  assert.throws(() => messagePage(value, "missing", HttpError), { code: "conversation.anchor_unknown" });
});

test("incremental pages drain a backlog without transferring historical messages; final old turns update too", () => {
  const value = ledger(1000);
  value.events = [{ sequence: 1, kind: "message.accepted", payload: { turnId: "old", userMessageId: "m996", assistantMessageId: "m997" } },
    ...Array.from({ length: 260 }, (_, i) => ({ sequence: i + 2, kind: "assistant.delta", payload: { turnId: "old", messageId: "m997", delta: "x" } })),
    { sequence: 262, kind: "turn.completed", payload: { turnId: "old" } }];
  value.activeTurn = { turnId: "new", userMessageId: "m998", assistantMessageId: "m999" };
  let cursor = 1;
  let pages = 0;
  do {
    const page = syncProjection(value, {}, "v", cursor);
    assert.ok(page.conversation.messages.length <= 4);
    assert.equal(page.events.some(e => e.kind === "assistant.delta"), false);
    assert.ok(page.cursor > cursor);
    cursor = page.cursor; pages++;
    if (!page.hasMore) {
      assert.ok(page.conversation.messages.some(m => m.messageId === "m997")); break;
    }
  } while (pages < 10);
  assert.equal(cursor, 262); assert.equal(pages, 3);
  const reset = syncProjection(value, {}, "v", 999);
  assert.equal(reset.reset, true); assert.equal(reset.conversation.messages.length, 64);
});

test("authorized unchanged sync avoids ledger reads; read errors and missing conversations remain errors", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "aru-sync-"));
  const host = createCollaboratorConversationHost({ dataDir: dir, driverForCollaborator: () => ({}),
    collaboratorForId: id => ({ collaboratorId: id, driverId: "codex", displayName: "Aru" }),
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, { status, body }), HttpError,
    toolCatalog: () => [], executeTool: async () => ({}) });
  const originalRead = fs.readFileSync;
  try {
    const directory = join(dir, "collaborator-conversations", "aru"); fs.mkdirSync(directory);
    const path = join(directory, "chat.json");
    const value = { ...ledger(5000), schema: "aru.selfhost.collaborator-conversation.v1", revision: 1,
      title: "Chat", createdAt: 1, updatedAt: 1, archivedAt: null, attachments: [] };
    fs.writeFileSync(path, JSON.stringify(value));
    let reads = 0;
    fs.readFileSync = (...args) => { if (args[0] === path) reads++; return originalRead(...args); };
    syncBuiltinESMExports();
    const request = async (query = "", auth = () => ({ deviceId: "phone" })) => {
      const res = {}; await host.route({ method: "GET", url: `/aru/v1/hosted-collaborators/aru/conversations/chat/sync${query}` },
        res, "/aru/v1/hosted-collaborators/aru/conversations/chat/sync", auth); return res.body;
    };
    const first = await request(); assert.equal(first.conversation.messages.length, 64); assert.equal(reads, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < Buffer.byteLength(JSON.stringify(value)) / 10);
    for (let i = 0; i < 20; i++) assert.equal((await request(`?version=${first.version}`)).unchanged, true);
    assert.equal(reads, 1);
    const full = {}, window = {};
    const detailPath = "/aru/v1/hosted-collaborators/aru/conversations/chat";
    await host.route({ method: "GET", url: detailPath }, full, detailPath, () => ({ deviceId: "phone" }));
    await host.route({ method: "GET", url: detailPath + "?window=1" }, window, detailPath, () => ({ deviceId: "phone" }));
    assert.equal(full.body.messages.length, 5000); assert.equal(window.body.messages.length, 64);
    await assert.rejects(request(`?version=${first.version}`, () => { throw new HttpError(401, "auth", "no"); }), { status: 401 });
    fs.writeFileSync(path, "broken");
    await assert.rejects(request(`?version=${first.version}`), { code: "conversation.unreadable" });
    fs.rmSync(path);
    await assert.rejects(request(`?version=${first.version}`), { code: "conversation.unknown" });
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
});
