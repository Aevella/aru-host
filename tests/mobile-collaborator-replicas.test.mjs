import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMobileCollaboratorReplicaHost } from "../mobile-collaborator-replicas.mjs";

import { createCollaboratorConversationHost } from "../collaborator-conversations.mjs";

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
  assert.equal(readable.value.memories, undefined);
  assert.equal(readable.value.references, undefined);
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

test("a recurring phone rule continues from the Host's own unsynced deliveries while the phone is away", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-mobile-replica-chain-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const hour = 60 * 60 * 1000;
  let clock = 1_000;
  let triggered = null;
  const host = createMobileCollaboratorReplicaHost({
    dataDir: directory,
    readJSONBody: async (request) => request.body,
    sendJSON: () => {},
    HttpError,
    collaboratorForId: (id) => ({ collaboratorId: id, displayName: "Computer", driverId: "codex" }),
    maximumRequestBytes: 64 * 1024 * 1024,
    trigger(executor, replica, rule, deliveryId) { triggered = { replica, deliveryId }; },
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const hello = { messageId: "phone_message", role: "user", content: "hello", createdAt: 900, updatedAt: 900 };
  const replica = (revision, messages) => ({
    schema: "aru.selfhost.mobile-collaborator-replica.v1",
    sourceCollaboratorId: "phone_aru", displayName: "Aru", systemPrompt: "", memories: [], references: [],
    conversations: [{ conversationId: "phone_conversation", title: "Us",
      baseMessageId: messages.at(-1).messageId, messages }],
    rules: [{ ruleId: "hourly", conversationMode: "fixed", conversationId: "phone_conversation", title: "Hourly",
      goal: "Say hi", instructions: "", nextFireAt: 1_000, scheduleKind: "interval", recurrenceMinutes: 60,
      dailyTimeMinutes: null, scheduleTimeZoneIdentifier: null, notificationsEnabled: true, enabled: true,
      updatedAt: 940, sourceVersion: "v1" }],
    readerHostCollaboratorIds: ["hostcol_reader"], executorHostCollaboratorId: "hostcol_reader",
    epoch: 1, revision, generatedAt: 950,
  });
  const upload = (value) => host.route({ method: "PUT", body: value, url: "/aru/v1/mobile-collaborator-replicas/phone_aru" },
    {}, "/aru/v1/mobile-collaborator-replicas/phone_aru", () => ({ deviceId: "phone" }));
  await upload(replica(1, [hello]));
  host.start();

  const deliveries = [];
  for (let turn = 1; turn <= 3; turn++) {
    await host.runDue();
    const context = triggered.replica.conversations[0];
    assert.deepEqual(context.messages.slice(1).map((message) => message.content), deliveries.map((d) => d.content),
      `turn ${turn} continues from every earlier Host message`);
    assert.equal(context.baseMessageId, context.messages.at(-1).messageId);
    await host.settle({
      outcome: "completed",
      turn: { source: "mobile-replica-proactive", sourceCollaboratorId: "phone_aru",
        sourceConversationId: "phone_conversation", baseMessageId: context.baseMessageId,
        basisMessages: context.messages, executionEpoch: 1, ruleId: "hourly", ruleVersion: "v1",
        deliveryId: triggered.deliveryId },
      assistantMessage: { content: `message ${turn}` },
    });
    deliveries.push({ id: `hostmessage_${triggered.deliveryId}`, content: `message ${turn}` });
    clock += hour;
  }

  // The phone comes back, imports all three, and uploads a replica that has them.
  await upload(replica(2, [hello, ...deliveries.map((d, index) => ({
    messageId: d.id, role: "assistant", content: d.content, createdAt: 2_000 + index, updatedAt: 2_000 + index }))]));
  await host.runDue();
  const ids = triggered.replica.conversations[0].messages.map((message) => message.messageId);
  assert.equal(new Set(ids).size, ids.length, "synced deliveries are not added twice");
  assert.equal(ids.length, 4);
});

test("saved delivery survives notification failure, restart and duplicate acknowledgement", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-mobile-replica-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1_000;
  const triggered = [];
  let response = null;
  const collaborators = new Map([
    ["hostcol_reader", { collaboratorId: "hostcol_reader", displayName: "Computer Aru", driverId: "codex" }],
    ["hostcol_other", { collaboratorId: "hostcol_other", displayName: "Other", driverId: "codex" }],
  ]);
  const options = {
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
      triggered.push({ executor, replica, rule, deliveryId });
    },
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
    onDelivery: async () => { throw new Error("offline"); },
  };
  let host = createMobileCollaboratorReplicaHost(options);
  const replica = {
    schema: "aru.selfhost.mobile-collaborator-replica.v1",
    sourceCollaboratorId: "phone_aru",
    displayName: "Aru",
    systemPrompt: "Stay close.",
    memories: [{ title: "Memory", content: "AA likes clarity." }],
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
      recurrenceMinutes: 1,
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
  assert.equal(triggered[0].executor.collaboratorId, "hostcol_reader");
  assert.equal(triggered[0].replica.sourceCollaboratorId, "phone_aru");
  assert.match(triggered[0].deliveryId, /^mobiledelivery_/);


  const event = { outcome: "completed", assistantMessage: { content: "durable reply" },
    turn: { source: "mobile-replica-proactive", sourceCollaboratorId: "phone_aru",
      executionEpoch: 1, ruleId: "rule_one", deliveryId: triggered[0].deliveryId,
      sourceConversationId: "phone_conversation", basisMessages: [] } };
  await assert.doesNotReject(host.settle(event));
  host.stop();
  host = createMobileCollaboratorReplicaHost(options);
  const path = "/aru/v1/mobile-collaborator-replicas/phone_aru/deliveries";
  const fetch = () => host.route({ method: "GET", url: `${path}?epoch=1` }, {}, path, () => ({}));
  await fetch();
  assert.equal(response.value.deliveries.length, 1);
  assert.equal(response.value.deliveries[0].deliveryId, event.turn.deliveryId);
  assert.equal(response.value.deliveries[0].assistantContent, "durable reply");
  await host.settle(event); // A duplicate completion cannot create another delivery.
  await fetch();
  assert.equal(response.value.deliveries.length, 1);
  const ack = `${path}/acknowledge`;
  for (let index = 0; index < 2; index++) {
    await host.route({ method: "POST", url: ack, body: { epoch: 1, deliveryId: event.turn.deliveryId } }, {}, ack, () => ({}));
  }
  host.stop();
  host = createMobileCollaboratorReplicaHost(options);
  await fetch();
  assert.equal(response.value.deliveries.length, 0);
  host.stop();
});

for (const outcome of ["completed", "failed", "interrupted"]) {
test(`restart reconciles ${outcome} conversation before clearing pending delivery`, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-mobile-replica-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1_000;
  const triggered = [];
  let response = null;
  const collaborators = new Map([
    ["hostcol_reader", { collaboratorId: "hostcol_reader", displayName: "Computer Aru", driverId: "codex" }],
    ["hostcol_other", { collaboratorId: "hostcol_other", displayName: "Other", driverId: "codex" }],
  ]);
  const options = {
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
      triggered.push({ executor, replica, rule, deliveryId });
    },
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
    onDelivery: async () => { throw new Error("offline"); },
  };
  let host = createMobileCollaboratorReplicaHost(options);
  const replica = {
    schema: "aru.selfhost.mobile-collaborator-replica.v1",
    sourceCollaboratorId: "phone_aru",
    displayName: "Aru",
    systemPrompt: "Stay close.",
    memories: [{ title: "Memory", content: "AA likes clarity." }],
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
      recurrenceMinutes: 1,
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
  assert.equal(triggered[0].executor.collaboratorId, "hostcol_reader");
  assert.equal(triggered[0].replica.sourceCollaboratorId, "phone_aru");
  assert.match(triggered[0].deliveryId, /^mobiledelivery_/);


  host.stop();
  const turn = { source: "mobile-replica-proactive", sourceCollaboratorId: "phone_aru",
    executionEpoch: 1, ruleId: "rule_one", ruleVersion: "rule-version-1",
    deliveryId: triggered[0].deliveryId, sourceConversationId: "phone_conversation",
    basisMessages: [], state: outcome, turnId: "turn", assistantMessageId: "reply" };
  const owner = "mobilereplica_phone_aru";
  const folder = join(directory, "collaborator-conversations", owner);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "hostconv_recovery.json"), JSON.stringify({
    conversationId: "hostconv_recovery", collaboratorId: owner, revision: 1,
    createdAt: 1000, updatedAt: 1100, activeTurn: turn, events: [], approvals: [],
    messages: [{ messageId: "reply", status: "completed", role: "assistant", content: "saved before crash" }],
  }));
  const conversations = createCollaboratorConversationHost({
    dataDir: directory, HttpError, readJSONBody: options.readJSONBody,
    sendJSON: options.sendJSON, collaboratorForId: options.collaboratorForId,
    driverForCollaborator: () => { throw new Error("recovery must not execute a model"); },
    toolCatalog: () => [], executeTool: () => { throw new Error("no tool replay"); },
  });
  assert.equal(conversations.recoverReplicaDelivery("phone_aru", turn.deliveryId, 2), null);
  assert.equal(conversations.recoverReplicaDelivery("another_phone", turn.deliveryId, 1), null);
  writeFileSync(join(folder, "hostconv_broken.json"), "{broken");
  assert.throws(() => conversations.recoverReplicaDelivery("phone_aru", turn.deliveryId, 1));
  rmSync(join(folder, "hostconv_broken.json"));
  const recoveryOptions = { ...options, recoverDelivery: conversations.recoverReplicaDelivery };
  host = createMobileCollaboratorReplicaHost(recoveryOptions);
  // A second crash after loading evidence but before start must not consume it.
  host.stop();
  host = createMobileCollaboratorReplicaHost(recoveryOptions);
  await host.start();
  const path = "/aru/v1/mobile-collaborator-replicas/phone_aru/deliveries";
  const fetch = () => host.route({ method: "GET", url: `${path}?epoch=1` }, {}, path, () => ({}));
  await fetch();
  assert.equal(response.value.deliveries.length, outcome === "completed" ? 1 : 0);
  if (outcome === "completed") {
    assert.equal(response.value.deliveries[0].deliveryId, turn.deliveryId);
    assert.equal(response.value.deliveries[0].assistantContent, "saved before crash");
  }
  await host.route({ method: "GET", url: "/aru/v1/mobile-collaborator-replicas/phone_aru/executions?epoch=1" }, {},
    "/aru/v1/mobile-collaborator-replicas/phone_aru/executions", () => ({}));
  assert.equal(response.value.executions[0].state, outcome === "interrupted" ? "uncertain" : outcome);
  assert.equal(response.value.executions[0].content, "saved before crash");
  assert.equal(triggered.length, 1);
  host.stop();
  host = createMobileCollaboratorReplicaHost(recoveryOptions);
  await host.start();
  await fetch();
  assert.equal(response.value.deliveries.length, outcome === "completed" ? 1 : 0);
  assert.equal(triggered.length, 1);
  host.stop();
});
}

for (const recurrenceMinutes of [null, 1]) {
 for (const editInFlight of [false, true]) {
  test(`changed phone revision cannot re-arm a consumed occurrence (${recurrenceMinutes}, editing=${editInFlight})`, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "aru-occurrence-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    let clock = 1_000;
    const triggered = [];
    const deliveries = [];
    const options = {
      dataDir: directory, readJSONBody: async (req) => req.body,
      sendJSON: () => {}, HttpError, maximumRequestBytes: 1_000_000,
      collaboratorForId: () => ({ collaboratorId: "executor" }),
      trigger: (_executor, _replica, rule, deliveryId) => triggered.push({ ruleId: rule.ruleId, deliveryId }),
      onDelivery: async ({ mobileDelivery }) => deliveries.push(mobileDelivery),
      now: () => clock, setTimer: () => 1, clearTimer: () => {},
    };
    let host = createMobileCollaboratorReplicaHost(options);
    const path = "/aru/v1/mobile-collaborator-replicas/phone";
    const snapshot = (revision, nextFireAt = 1_000, epoch = 1) => ({
      schema: "aru.selfhost.mobile-collaborator-replica.v1", sourceCollaboratorId: "phone",
      displayName: "Phone", systemPrompt: "", memories: [], references: [], conversations: [],
      readerHostCollaboratorIds: ["executor"], executorHostCollaboratorId: "executor",
      epoch, revision, generatedAt: clock,
      rules: [{ ruleId: "rule", title: "rule", goal: "hello", instructions: "",
        nextFireAt, recurrenceMinutes, enabled: true, notificationsEnabled: false,
        updatedAt: clock, sourceVersion: `version-${revision}` }],
    });
    const put = (body) => host.route({ method: "PUT", url: path, body }, {}, path, () => ({ deviceId: "phone" }));
    await put(snapshot(1));
    await host.runDue();
    assert.equal(triggered.length, 1);
    // The phone edits while the admitted attempt is still running.
    if (editInFlight) await put(snapshot(2));
    clock = 1_100;
    await host.settle({ outcome: "completed", assistantMessage: { content: "hello" },
      turn: { source: "mobile-replica-proactive", sourceCollaboratorId: "phone", executionEpoch: 1,
        ruleId: "rule", deliveryId: triggered[0].deliveryId, basisMessages: [] } });
    assert.equal(deliveries[0].ruleVersion, "version-1");
    await host.route({ method: "POST", url: `${path}/deliveries/acknowledge`, body: {
      schema: "aru.selfhost.mobile-collaborator-delivery-ack.v1", epoch: 1,
      deliveryId: triggered[0].deliveryId,
    } }, {}, `${path}/deliveries/acknowledge`, () => ({ deviceId: "phone" }));
    await put(snapshot(3));
    await host.runDue();
    assert.equal(triggered.length, 1, "stale occurrence must not fire again after acknowledgement");
    host.stop();
    host = createMobileCollaboratorReplicaHost(options);
    await put(snapshot(4));
    await host.runDue();
    assert.equal(triggered.length, 1, "restart retains occurrence progress");
    clock = 61_000;
    await put(snapshot(5, 61_000));
    await host.runDue();
    assert.equal(triggered.length, 2, "a genuinely new scheduled occurrence may run");
    await put(snapshot(1, 1_000, 2));
    await host.runDue();
    assert.equal(triggered.length, 3, "a new execution grant has its own occurrence history");
    host.stop();
  });
}
}

test("interrupted execution remains visible after restart without replay and rejects late completion", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-execution-state-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  let response;
  let deliveryId;
  const options = { dataDir: directory, readJSONBody: async req => req.body,
    sendJSON: (_res, _status, body) => { response = body; }, HttpError,
    collaboratorForId: () => ({ collaboratorId: "executor" }), maximumRequestBytes: 100000,
    trigger: (_executor, _replica, _rule, id) => { calls++; deliveryId = id; },
    now: () => 1000, setTimer: () => 1, clearTimer: () => {} };
  let host = createMobileCollaboratorReplicaHost(options);
  const path = "/aru/v1/mobile-collaborator-replicas/phone";
  await host.route({ method: "PUT", url: path, body: {
    schema: "aru.selfhost.mobile-collaborator-replica.v1", sourceCollaboratorId: "phone",
    displayName: "Aru", memories: [], references: [], conversations: [],
    readerHostCollaboratorIds: ["executor"], executorHostCollaboratorId: "executor",
    epoch: 1, revision: 1, generatedAt: 1000,
    rules: [{ ruleId: "rule", title: "Check in", goal: "hello", instructions: "",
      nextFireAt: 1000, enabled: true, updatedAt: 1000, sourceVersion: "v1" }],
  } }, {}, path, () => ({}));
  await host.runDue();
  const check = () => host.route({ method: "GET", url: `${path}/executions?epoch=1` }, {}, `${path}/executions`, () => ({}));
  await check();
  assert.equal(response.executions[0].state, "running");
  host.stop();
  host = createMobileCollaboratorReplicaHost(options);
  await host.start();
  await check();
  assert.equal(response.executions[0].state, "uncertain");
  assert.equal(response.executions[0].deliveryId, deliveryId);
  await host.settle({ outcome: "completed", assistantMessage: { content: "late" }, turn: {
    source: "mobile-replica-proactive", sourceCollaboratorId: "phone", executionEpoch: 1,
    ruleId: "rule", deliveryId, basisMessages: [] } });
  await check();
  assert.equal(response.executions[0].state, "uncertain");
  await host.runDue();
  assert.equal(calls, 1);
  await assert.rejects(host.route({ method: "GET", url: `${path}/executions?epoch=2` }, {}, `${path}/executions`, () => ({})));
  host.stop();
});

test("removing a rule does not discard its already admitted result", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-mobile-replica-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1_000;
  const triggered = [];
  let response = null;
  const collaborators = new Map([
    ["hostcol_reader", { collaboratorId: "hostcol_reader", displayName: "Computer Aru", driverId: "codex" }],
    ["hostcol_other", { collaboratorId: "hostcol_other", displayName: "Other", driverId: "codex" }],
  ]);
  const options = {
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
      triggered.push({ executor, replica, rule, deliveryId });
    },
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
    onDelivery: async () => { throw new Error("offline"); },
  };
  let host = createMobileCollaboratorReplicaHost(options);
  const replica = {
    schema: "aru.selfhost.mobile-collaborator-replica.v1",
    sourceCollaboratorId: "phone_aru",
    displayName: "Aru",
    systemPrompt: "Stay close.",
    memories: [{ title: "Memory", content: "AA likes clarity." }],
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
      recurrenceMinutes: 1,
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
  assert.equal(triggered[0].executor.collaboratorId, "hostcol_reader");
  assert.equal(triggered[0].replica.sourceCollaboratorId, "phone_aru");
  assert.match(triggered[0].deliveryId, /^mobiledelivery_/);



  const path = "/aru/v1/mobile-collaborator-replicas/phone_aru";
  await host.route({ method: "PUT", url: path, body: { ...replica, revision: 2, rules: [] } }, {}, path, () => ({}));
  await host.settle({ outcome: "completed", assistantMessage: { content: "finished original attempt" },
    turn: { source: "mobile-replica-proactive", sourceCollaboratorId: "phone_aru", executionEpoch: 1,
      ruleId: "rule_one", deliveryId: triggered[0].deliveryId, basisMessages: [] } });
  await host.route({ method: "GET", url: `${path}/deliveries?epoch=1` }, {}, `${path}/deliveries`, () => ({}));
  assert.equal(response.value.deliveries.length, 1);
  assert.equal(response.value.deliveries[0].ruleVersion, "rule-version-1");
  await host.route({ method: "GET", url: `${path}/executions?epoch=1` }, {}, `${path}/executions`, () => ({}));
  assert.equal(response.value.executions[0].state, "completed");
  host.stop();
});

test("execution history pages preserve identity and exclude unrelated grants", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "aru-execution-page-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const folder = join(directory, "mobile-collaborator-replicas");
  mkdirSync(folder, { recursive: true });
  const executions = Array.from({ length: 51 }, (_, index) => ({ deliveryId: `delivery_${index}`,
    sourceCollaboratorId: "phone", epoch: 1, ruleId: "rule", title: "Check in", state: "failed",
    createdAt: index + 1000, updatedAt: index + 1000 }));
  writeFileSync(join(folder, "ledger.json"), JSON.stringify({ replicas: [{ sourceCollaboratorId: "phone", epoch: 1, rules: [] }],
    deliveries: [], executions: [...executions, { ...executions[0], sourceCollaboratorId: "other" }] }));
  let body;
  const host = createMobileCollaboratorReplicaHost({ dataDir: directory, HttpError,
    sendJSON: (_res, _status, value) => { body = value; }, now: () => 2000 });
  const path = "/aru/v1/mobile-collaborator-replicas/phone/executions";
  const read = after => host.route({ method: "GET", url: `${path}?epoch=1${after ? `&after=${after}` : ""}` }, {}, path, () => ({}));
  await read();
  assert.equal(body.executions.length, 50);
  const ids = new Set(body.executions.map(item => item.deliveryId));
  await read(body.nextCursor);
  assert.equal(body.executions.length, 1);
  assert.equal(ids.has(body.executions[0].deliveryId), false);
  assert.equal(body.nextCursor, null);
  await assert.rejects(read("missing"));
  host.stop();
});
