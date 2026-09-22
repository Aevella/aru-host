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
      conversationMode: "fixed",
      conversationId: "phone_conversation",
      title: "Check in",
      goal: "Say something useful",
      instructions: "Be direct",
      nextFireAt: 1_000,
      scheduleKind: "one_time",
      recurrenceMinutes: null,
      dailyTimeMinutes: null,
      scheduleTimeZoneIdentifier: null,
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

test("daily phone rule keeps its wall-clock schedule and resolved target", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-mobile-replica-daily-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const firstFire = Date.parse("2026-08-13T13:00:00Z"); // 21:00 Asia/Shanghai
  let clock = firstFire;
  let triggered = null;
  const host = createMobileCollaboratorReplicaHost({
    dataDir: directory,
    readJSONBody: async (request) => request.body,
    sendJSON: () => {},
    HttpError,
    collaboratorForId: (id) => ({ collaboratorId: id, displayName: "Computer", driverId: "codex" }),
    maximumRequestBytes: 64 * 1024 * 1024,
    trigger(_executor, _replica, rule, deliveryId) { triggered = { rule, deliveryId }; },
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const replica = {
    schema: "aru.selfhost.mobile-collaborator-replica.v1",
    sourceCollaboratorId: "phone_aru",
    displayName: "Aru",
    systemPrompt: "Stay close.",
    memories: [],
    references: [],
    conversations: [{
      conversationId: "latest_phone_conversation",
      title: "Us",
      baseMessageId: null,
      messages: [],
    }],
    rules: [{
      ruleId: "daily_rule",
      conversationMode: "follow_latest",
      conversationId: "latest_phone_conversation",
      title: "Evening",
      goal: "Check in",
      instructions: "Be direct",
      nextFireAt: firstFire,
      scheduleKind: "daily",
      recurrenceMinutes: null,
      dailyTimeMinutes: 21 * 60,
      scheduleTimeZoneIdentifier: "Asia/Shanghai",
      notificationsEnabled: true,
      enabled: true,
      updatedAt: firstFire - 1_000,
      sourceVersion: "daily-version-1",
    }],
    readerHostCollaboratorIds: ["hostcol_reader"],
    executorHostCollaboratorId: "hostcol_reader",
    epoch: 1,
    revision: 1,
    generatedAt: firstFire - 500,
  };

  await host.route(
    { method: "PUT", body: replica, url: "/aru/v1/mobile-collaborator-replicas/phone_aru" },
    {},
    "/aru/v1/mobile-collaborator-replicas/phone_aru",
    () => ({ deviceId: "phone" }),
  );
  host.start();
  await host.runDue();

  assert.equal(triggered.rule.conversationId, "latest_phone_conversation");
  assert.equal(triggered.rule.nextFireAt, Date.parse("2026-08-14T13:00:00Z"));
  host.stop();
});

test("revoking phone execution stops the Host scheduler, drops late results, and blocks stale re-sync", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-mobile-replica-revoke-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1_000;
  let triggered = [];
  let response = null;
  const options = {
    dataDir: directory,
    readJSONBody: async (request) => request.body,
    sendJSON: (_response, status, value) => { response = { status, value }; },
    HttpError,
    collaboratorForId: (id) => ({ collaboratorId: id, displayName: "Computer", driverId: "codex" }),
    maximumRequestBytes: 64 * 1024 * 1024,
    trigger(_executor, replica, rule, deliveryId) { triggered.push({ epoch: replica.epoch, rule, deliveryId }); },
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
  };
  const host = createMobileCollaboratorReplicaHost(options);
  const rule = (ruleId, nextFireAt) => ({
    ruleId,
    conversationMode: "fixed",
    conversationId: "phone_conversation",
    title: ruleId,
    goal: "Check in",
    instructions: "Be direct",
    nextFireAt,
    scheduleKind: "one_time",
    recurrenceMinutes: null,
    dailyTimeMinutes: null,
    scheduleTimeZoneIdentifier: null,
    notificationsEnabled: true,
    enabled: true,
    updatedAt: 940,
    sourceVersion: `${ruleId}-version-1`,
  });
  const replica = (epoch, revision) => ({
    schema: "aru.selfhost.mobile-collaborator-replica.v1",
    sourceCollaboratorId: "phone_aru",
    displayName: "Aru",
    systemPrompt: "Stay close.",
    memories: [],
    references: [],
    conversations: [{ conversationId: "phone_conversation", title: "Us", baseMessageId: null, messages: [] }],
    rules: [rule("rule_now", 1_000), rule("rule_later", 2_000)],
    readerHostCollaboratorIds: ["hostcol_reader"],
    executorHostCollaboratorId: "hostcol_reader",
    epoch,
    revision,
    generatedAt: 950,
  });
  const path = "/aru/v1/mobile-collaborator-replicas/phone_aru";
  const device = () => ({ deviceId: "phone" });
  const send = (method, suffix, body) => host.route({ method, body, url: path + suffix }, {}, path + suffix.split("?")[0], device);

  await send("PUT", "", replica(1, 1));
  assert.equal(response.status, 200);
  host.start();
  await host.runDue();
  assert.equal(triggered.length, 1);
  const inFlight = triggered[0];

  await send("POST", "/revoke", { epoch: 1 });
  assert.deepEqual(response, {
    status: 200,
    value: { schema: "aru.selfhost.mobile-collaborator-revoke-receipt.v1", sourceCollaboratorId: "phone_aru", epoch: 1 },
  });

  // A task that was already running may finish, but its result is no longer accepted as a delivery.
  clock = 1_100;
  await host.settle({
    outcome: "completed",
    turn: {
      source: "mobile-replica-proactive",
      sourceCollaboratorId: "phone_aru",
      sourceConversationId: "phone_conversation",
      baseMessageId: null,
      basisMessages: [],
      executionEpoch: 1,
      ruleId: "rule_now",
      ruleVersion: "rule_now-version-1",
      deliveryId: inFlight.deliveryId,
    },
    assistantMessage: { content: "Late result." },
  });
  await send("GET", "/deliveries?epoch=1");
  assert.equal(response.value.deliveries.length, 0);

  // The revoked epoch no longer fires and cannot be re-enabled by an old sync.
  clock = 2_500;
  await host.runDue();
  assert.equal(triggered.length, 1);
  await assert.rejects(send("PUT", "", replica(1, 2)),
    (error) => error instanceof HttpError && error.status === 409 && error.code === "mobile_replica.epoch_revoked");

  // Revocation survives a Host restart.
  host.stop();
  const restarted = createMobileCollaboratorReplicaHost(options);
  restarted.start();
  await restarted.runDue();
  assert.equal(triggered.length, 1);

  // A fresh grant with a higher epoch takes over again; an old revoke cannot clear it.
  await restarted.route({ method: "PUT", body: replica(2, 1), url: path }, {}, path, device);
  assert.equal(response.status, 200);
  await restarted.runDue();
  assert.equal(triggered.length, 3);
  assert.ok(triggered.slice(1).every((item) => item.epoch === 2));
  await assert.rejects(
    restarted.route({ method: "POST", body: { epoch: 1 }, url: `${path}/revoke` }, {}, `${path}/revoke`, device),
    (error) => error instanceof HttpError && error.status === 409 && error.code === "mobile_replica.epoch_stale");
  restarted.stop();
});
