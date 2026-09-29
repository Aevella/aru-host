import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCollaboratorConversationHost } from "../collaborator-conversations.mjs";

test("phone replica proactive requests preserve message and trigger time", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-replica-context-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const deferred = [];
  const driverCalls = [];
  const triggeredAt = Date.parse("2026-09-02T03:00:00Z");
  const driver = {
    async startTurn(options) {
      driverCalls.push(options);
      return { threadId: "thread_replica", turnId: "turn_replica" };
    },
    async interrupt() {},
  };
  const executor = {
    collaboratorId: "hostcol_reader",
    displayName: "Computer Aru",
    driverId: "direct-api",
    toolAccess: { mode: "all", toolNames: [] },
  };
  const host = createCollaboratorConversationHost({
    dataDir: directory,
    driverForCollaborator: () => driver,
    collaboratorForId: () => executor,
    readJSONBody: async (request) => request.body,
    sendJSON: () => {},
    HttpError: Error,
    toolCatalog: () => [],
    executeTool: async () => ({}),
    now: () => triggeredAt,
    defer: (operation) => deferred.push(operation),
  });
  const replica = {
    sourceCollaboratorId: "phone_aru",
    displayName: "Aru",
    systemPrompt: "Stay close.",
    memories: [],
    references: [],
    revision: 7,
    epoch: 2,
    generatedAt: Date.parse("2026-09-02T02:55:00Z"),
    conversations: [{
      conversationId: "phone_conversation",
      title: "Us",
      baseMessageId: "assistant_midday",
      messages: [{
        messageId: "system_context",
        role: "system",
        content: "这是昨天的对话背景",
        createdAt: Date.parse("2026-09-01T03:59:00Z"),
        updatedAt: Date.parse("2026-09-01T03:59:00Z"),
      }, {
        messageId: "user_midday",
        role: "user",
        content: "中午说的事",
        createdAt: Date.parse("2026-09-01T04:00:00Z"),
        updatedAt: Date.parse("2026-09-01T04:00:00Z"),
      }, {
        messageId: "assistant_midday",
        role: "assistant",
        content: "已经替你完成了",
        createdAt: Date.parse("2026-09-01T04:01:00Z"),
        updatedAt: Date.parse("2026-09-01T04:02:00Z"),
      }],
    }],
  };
  const rule = {
    ruleId: "rule_one",
    conversationId: "phone_conversation",
    title: "醒来看看",
    goal: "自然接着聊",
    instructions: "不要重说已经完成的事",
    scheduleTimeZoneIdentifier: "Asia/Shanghai",
    sourceVersion: "rule-version-1",
  };

  host.runReplicaProactive(executor, replica, rule, "delivery_one");
  assert.equal(deferred.length, 1);
  await deferred.shift()();

  assert.equal(driverCalls.length, 1);
  const request = driverCalls[0];
  assert.equal(request.historyMessages[0].role, "system");
  assert.match(request.historyMessages[0].content, /这是昨天的对话背景/);
  assert.match(request.historyMessages[1].content, /2026-09-01T04:00:00\.000Z/);
  assert.match(request.historyMessages[1].content, /中午说的事/);
  assert.match(request.historyMessages[2].content, /2026-09-01T04:01:00\.000Z/);
  assert.match(request.historyMessages[2].content, /2026-09-01T04:02:00\.000Z/);
  assert.match(request.historyMessages[2].content, /已经替你完成了/);
  assert.match(request.historyContext, /System: <message_meta>/);
  assert.match(request.text, /<runtime_clock>/);
  assert.match(request.text, /2026-09-02T03:00:00\.000Z/);
  assert.match(request.text, /Asia\/Shanghai/);
  assert.match(request.text, /2026-09-02T02:55:00\.000Z/);
  assert.match(request.text, /<message_meta>/);
});
