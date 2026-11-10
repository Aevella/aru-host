import assert from "node:assert/strict";
import test from "node:test";
import { replicaContextMessages, REPLICA_HISTORY_BYTES } from "../src/conversations/replica-context.mjs";
import { messageContentWithTime, historyRoleLabel } from "../src/conversations/driver-projection.mjs";

const row = (content, role = "user") => ({ messageId: "opaque:id/1", role, content, createdAt: 1000, updatedAt: 2000 });
function projectedBytes(rows) {
  return Math.max(
    Buffer.byteLength(JSON.stringify(rows.map(item => ({ role: item.role, content: messageContentWithTime(item) })))),
    Buffer.byteLength(rows.map(item => `${historyRoleLabel(item.role)}: ${messageContentWithTime(item)}`).join("\n\n")),
  );
}

test("short history preserves roles, times and source without mutation", () => {
  const source = [row("background", "system"), row("hello"), row("result", "tool"), row("reply", "assistant")];
  const before = structuredClone(source);
  const result = replicaContextMessages(source, 3000);
  assert.deepEqual(result, source.map(({ messageId, ...item }) => item));
  assert.deepEqual(source, before);
  assert.deepEqual(replicaContextMessages([], 3000), []);
  assert.deepEqual(replicaContextMessages([row(" \n ")], 3000), []);
});

test("exact boundary admits a full row; one byte less cannot admit that older row", () => {
  const newest = row("newest", "assistant");
  const older = row("older");
  const cost = item => Math.max(
    Buffer.byteLength(JSON.stringify({ role: item.role, content: messageContentWithTime(item) })) + 1,
    Buffer.byteLength(`${historyRoleLabel(item.role)}: ${messageContentWithTime(item)}\n\n`),
  );
  const budget = 2 + cost(older) + cost(newest);
  assert.equal(replicaContextMessages([older, newest], 3000, budget).length, 2);
  assert.deepEqual(replicaContextMessages([older, newest], 3000, budget - 1).map(x => x.content), ["newest"]);
  assert.deepEqual(replicaContextMessages([newest], 3000, 0), []);
});

test("10,001 messages select a chronological recent suffix within both driver projections", () => {
  const source = Array.from({ length: 10001 }, (_, i) => row(`${i}: ${"conversation 中文 ".repeat(30)}`, i % 2 ? "assistant" : "user"));
  const result = replicaContextMessages(source, 3000);
  assert.ok(result.length > 1 && result.length < source.length);
  assert.ok(projectedBytes(result) <= REPLICA_HISTORY_BYTES);
  assert.deepEqual(result.map(x => x.content), source.slice(-result.length).map(x => x.content.trim()));
});

test("newest oversized Unicode and escaped message keeps a valid marked tail", () => {
  const content = "old-prefix" + '中文😀\n"\\'.repeat(20000) + "recent-tail";
  const source = [row("older"), row(content, "assistant")];
  const [result] = replicaContextMessages(source, 3000);
  assert.match(result.content, /^\[Earlier content of this message omitted from model context\.\]/);
  assert.ok(result.content.endsWith("recent-tail"));
  assert.ok(!result.content.includes("old-prefix"));
  assert.ok(!result.content.includes("\ufffd"));
  assert.equal(result.role, "assistant");
  assert.equal(result.updatedAt, 2000);
  assert.ok(projectedBytes([result]) <= REPLICA_HISTORY_BYTES);
  assert.equal(source[1].content, content);
});

test("a large intervening row does not admit disconnected older history", () => {
  const source = [row("old"), row("x".repeat(REPLICA_HISTORY_BYTES)), row("latest")];
  assert.deepEqual(replicaContextMessages(source, 3000).map(x => x.content), ["latest"]);
});
