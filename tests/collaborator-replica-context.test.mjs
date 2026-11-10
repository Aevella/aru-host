import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCollaboratorConversationHost } from "../collaborator-conversations.mjs";
import { createMobileCollaboratorReplicaHost } from "../mobile-collaborator-replicas.mjs";
import { REPLICA_HISTORY_BYTES } from "../src/conversations/replica-context.mjs";

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

for (const oversizedTail of [false, true]) {
test(`long replica execution retains complete delivery basis across failure, restart, ack and next occurrence (oversized tail: ${oversizedTail})`, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-replica-long-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1000;
  let fail = true;
  let response;
  const deferred = [], calls = [], events = [], settlements = [], admitted = [];
  const executor = { collaboratorId: "hostcol_reader", displayName: "Computer", driverId: "direct-api" };
  const common = {
    dataDir: directory, now: () => clock, readJSONBody: async req => req.body,
    sendJSON: (_res, _status, value) => { response = value; },
    HttpError: Error, collaboratorForId: () => executor,
  };
  const conversationOptions = {
    ...common, toolCatalog: () => [], executeTool: async () => ({}),
    requestInstructions: collaborator => collaborator.mobileInstructions,
    defer: operation => deferred.push(operation),
    driverForCollaborator: () => ({
      async startTurn(options) {
        calls.push(options);
        if (fail) throw new Error("synthetic provider failure");
        return { threadId: "thread", turnId: "turn" };
      },
      async interrupt() {},
    }),
    onTurnSettled: event => {
      events.push(event);
      const settled = mobile.settle(event);
      settlements.push(settled);
      return settled;
    },
  };
  let conversations = createCollaboratorConversationHost(conversationOptions);
  const mobileOptions = {
    ...common, maximumRequestBytes: 64 * 1024 * 1024,
    setTimer: () => 1, clearTimer: () => {},
    trigger(executor, replica, rule, deliveryId) {
      admitted.push(conversations.runReplicaProactive(executor, replica, rule, deliveryId));
    },
  };
  let mobile = createMobileCollaboratorReplicaHost(mobileOptions);
  context.after(() => mobile.stop());
  const messages = Array.from({ length: 10001 }, (_, index) => ({
    messageId: `phone:message/${index}`, role: index % 2 ? "assistant" : "user",
    content: `${index}: ${"historical content 中文 ".repeat(24)}`, createdAt: 900, updatedAt: 900,
  }));
  if (oversizedTail) messages.at(-1).content = "old-prefix" + "中文😀".repeat(30000) + "recent-tail";
  const replica = {
    schema: "aru.selfhost.mobile-collaborator-replica.v1",
    sourceCollaboratorId: "phone_source", displayName: "Phone", systemPrompt: "Keep identity.",
    memories: [], references: [], epoch: 1, revision: 1, generatedAt: 950,
    readerHostCollaboratorIds: [executor.collaboratorId], executorHostCollaboratorId: executor.collaboratorId,
    conversations: [{ conversationId: "phone_window", title: "Long window", baseMessageId: messages.at(-1).messageId, messages }],
    rules: [{ ruleId: "hourly", conversationMode: "fixed", conversationId: "phone_window", title: "Check in",
      goal: "Continue", instructions: "Use recent context", nextFireAt: 1000, scheduleKind: "interval",
      recurrenceMinutes: 60, enabled: true, notificationsEnabled: false, updatedAt: 940, sourceVersion: "v1" }],
  };
  const path = "/aru/v1/mobile-collaborator-replicas/phone_source";
  async function send(method, suffix, body) {
    await mobile.route({ method, body, url: path + suffix + (method === "GET" ? "?epoch=1" : "") },
      {}, path + suffix, () => ({ deviceId: "phone" }));
    return response;
  }
  async function fire() {
    await mobile.runDue();
    await mobile.runDue(); // the same due occurrence must not dispatch twice
    assert.equal(deferred.length, 1);
    await deferred.shift()();
    await Promise.all(settlements);
    const request = calls.at(-1);
    assert.ok(Buffer.byteLength(request.historyContext) <= REPLICA_HISTORY_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(request.historyMessages)) <= REPLICA_HISTORY_BYTES);
    assert.ok(request.historyMessages.length < messages.length);
    assert.match(request.instructions, /Keep identity/);
    assert.match(request.text, /Use recent context/);
  }
  await send("PUT", "", replica);
  mobile.start();
  await fire();
  assert.equal(calls.length, 1);
  assert.equal(events[0].outcome, "failed");
  assert.equal(events[0].turn.baseMessageId, messages.at(-1).messageId);
  assert.deepEqual(events[0].turn.basisMessages, messages);
  assert.equal((await send("GET", "/deliveries")).deliveries.length, 0);
  await mobile.runDue();
  assert.equal(deferred.length, 0, "failure does not replay a consumed occurrence");

  fail = false;
  clock += 3600000;
  await fire();
  const request = calls.at(-1);
  assert.ok(request.historyMessages.at(-1).content.endsWith(oversizedTail ? "recent-tail" : messages.at(-1).content.trim()));
  if (oversizedTail) assert.match(request.historyMessages.at(-1).content, /Earlier content of this message omitted/);
  request.handler.onNotification("item/agentMessage/delta", { delta: "saved reply" });
  request.handler.onNotification("turn/completed", { turn: { status: "completed" } });
  await Promise.all(settlements);
  await mobile.settle(events.at(-1)); // duplicate terminal notification
  let deliveries = (await send("GET", "/deliveries")).deliveries;
  assert.equal(deliveries.length, 1);
  const delivery = deliveries[0];
  assert.equal(delivery.baseMessageId, messages.at(-1).messageId);
  assert.deepEqual(delivery.basisMessages, messages);

  mobile.stop();
  conversations = createCollaboratorConversationHost(conversationOptions);
  const recovered = conversations.recoverReplicaDelivery("phone_source", delivery.deliveryId, 1);
  assert.deepEqual(recovered.turn.basisMessages, messages, "execution evidence survives disk reopen");
  mobile = createMobileCollaboratorReplicaHost(mobileOptions);
  mobile.start();
  deliveries = (await send("GET", "/deliveries")).deliveries;
  assert.deepEqual(deliveries, [delivery]);
  const ack = { epoch: 1, deliveryId: delivery.deliveryId };
  await send("POST", "/deliveries/acknowledge", ack);
  await send("POST", "/deliveries/acknowledge", ack);
  assert.equal((await send("GET", "/deliveries")).deliveries.length, 0);

  clock += 3600000;
  await fire();
  assert.equal(calls.length, 3);
  assert.match(calls.at(-1).historyMessages.at(-1).content, /saved reply/);
  const next = admitted.at(-1).activeTurn;
  assert.equal(next.baseMessageId, `hostmessage_${delivery.deliveryId}`);
  assert.deepEqual(next.basisMessages.slice(0, -1), messages);
  assert.equal(next.basisMessages.at(-1).messageId, next.baseMessageId);
  calls.at(-1).handler.onNotification("turn/completed", { turn: { status: "failed", error: { message: "fixture cleanup" } } });
  await Promise.all(settlements);
  assert.deepEqual(replica.conversations[0].messages, messages);
});
}
