import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMobileCollaboratorReplicaHost } from "../mobile-collaborator-replicas.mjs";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

test("computer collaborator reads a phone replica without owning it and Host settles one delivery", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-mobile-replica-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1_000;
  let triggered = null;
  let response = null;
  const collaborators = new Map([
    ["hostcol_reader", { collaboratorId: "hostcol_reader", displayName: "Computer Aru", driverId: "codex" }],
    ["hostcol_other", { collaboratorId: "hostcol_other", displayName: "Other", driverId: "codex" }],
  ]);
  const host = createMobileCollaboratorReplicaHost({
    dataDir: directory,
    readJSONBody: async (request) => request.body,
    sendJSON: (_response, status, value) => { response = { status, value }; },
    HttpError,
    collaboratorForId(id) {
      const collaborator = collaborators.get(id);
      if (!collaborator) throw new HttpError(404, "unknown", "unknown collaborator");
      return collaborator;
    },
    maximumRequestBytes: 64 * 1024 * 1024,
    trigger(executor, replica, rule, deliveryId) {
      triggered = { executor, replica, rule, deliveryId };
    },
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const replica = {
    schema: "aru.selfhost.mobile-collaborator-replica.v1",
    sourceCollaboratorId: "phone_aru",
    displayName: "Aru",
    systemPrompt: "Stay close.",
    memories: [{ title: "Memory", content: "The user likes clarity." }],
    references: [],
    conversations: [{
      conversationId: "phone_conversation",
      title: "Us",
      baseMessageId: "phone_message",
      messages: [{
        messageId: "phone_message",
        role: "user",
        content: "hello",
        createdAt: 900,
        updatedAt: 900,
      }],
    }],
    rules: [{
      ruleId: "rule_one",
      conversationId: "phone_conversation",
      title: "Check in",
      goal: "Say something useful",
      instructions: "Be direct",
      nextFireAt: 1_000,
      recurrenceMinutes: null,
      notificationsEnabled: true,
      enabled: true,
      updatedAt: 940,
      sourceVersion: "rule-version-1",
    }],
    readerHostCollaboratorIds: ["hostcol_reader"],
    executorHostCollaboratorId: "hostcol_reader",
    epoch: 1,
    revision: 1,
    generatedAt: 950,
  };

  await host.route(
    { method: "PUT", body: replica, url: "/aru/v1/mobile-collaborator-replicas/phone_aru" },
    {},
    "/aru/v1/mobile-collaborator-replicas/phone_aru",
    () => ({ deviceId: "phone" }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.value.sourceCollaboratorId, "phone_aru");

  host.start();
  await host.runDue();
  assert.equal(triggered.executor.collaboratorId, "hostcol_reader");
  assert.equal(triggered.replica.sourceCollaboratorId, "phone_aru");
  assert.match(triggered.deliveryId, /^mobiledelivery_/);

  clock = 1_100;
  await host.settle({
    outcome: "completed",
    turn: {
      source: "mobile-replica-proactive",
      sourceCollaboratorId: "phone_aru",
      sourceConversationId: "phone_conversation",
      baseMessageId: "phone_message",
      basisMessages: replica.conversations[0].messages,
      executionEpoch: 1,
      ruleId: "rule_one",
      ruleVersion: "rule-version-1",
      deliveryId: triggered.deliveryId,
    },
    assistantMessage: { content: "I am here." },
  });
  await host.route(
    { method: "GET", url: "/aru/v1/mobile-collaborator-replicas/phone_aru/deliveries?epoch=1" },
    {},
    "/aru/v1/mobile-collaborator-replicas/phone_aru/deliveries",
    () => ({ deviceId: "phone" }),
  );
  assert.equal(response.value.deliveries.length, 1);
  assert.equal(response.value.deliveries[0].assistantContent, "I am here.");
  assert.equal(response.value.deliveries[0].baseMessageId, "phone_message");
  assert.equal(response.value.deliveries[0].ruleVersion, "rule-version-1");
  assert.deepEqual(response.value.deliveries[0].basisMessages, replica.conversations[0].messages);

  const tools = host.selfTools();
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === true));
  const readable = host.callSelfTool(
    "aru_mobile_replica_read",
    { sourceCollaboratorId: "phone_aru" },
    {},
    collaborators.get("hostcol_reader"),
  );
  assert.equal(readable.value.systemPrompt, "Stay close.");
  assert.throws(() => host.callSelfTool(
    "aru_mobile_replica_read",
    { sourceCollaboratorId: "phone_aru" },
    {},
    collaborators.get("hostcol_other"),
  ), (error) => error instanceof HttpError && error.status === 403);
  host.stop();
});
