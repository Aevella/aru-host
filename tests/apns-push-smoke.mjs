import assert from "node:assert/strict";
import { createAPNsCredentialStore, createAPNsPushHost, encodedPayload } from "../apns-push.mjs";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const state = {
  devices: [
    { deviceId: "phone_one", revokedAt: null },
    { deviceId: "phone_two", revokedAt: null },
  ],
};
let clock = 10_000;
let saves = 0;
const deliveries = [];
const liveActivityDeliveries = [];
const credentialStore = {
  availability: () => ({ supported: true, storage: "test" }),
  read: () => ({ teamId: "TEAMID0000", keyId: "AAAAAAAAAA", privateKey: "test" }),
};
const host = createAPNsPushHost({
  state,
  saveState: () => { saves += 1; },
  readJSONBody: async (req) => req.body,
  sendJSON(res, status, body) { res.status = status; res.body = body; },
  HttpError,
  serverId: "server_test",
  credentialStore,
  sendPush: async (value) => { deliveries.push(value); },
  sendLiveActivity: async (value) => { liveActivityDeliveries.push(value); },
  now: () => ++clock,
});

await register("phone_one", "aa".repeat(32), "sandbox");
await register("phone_two", "bb".repeat(32), "production");
assert.equal(state.remotePushRegistrations.length, 2);
assert.equal(saves, 2);

const status = await call("GET", {}, "phone_one");
assert.equal(status.body.providerConfigured, true);
assert.equal(status.body.registrations.length, 1);
assert.equal("deviceToken" in status.body.registrations[0], false);

await assert.rejects(
  call("PUT", {
    schema: "aru.selfhost.remote-push-registration.v1",
    deviceToken: "not-a-token",
    environment: "sandbox",
    topic: "cn.aelion.aru",
  }, "phone_one"),
  (error) => error instanceof HttpError
    && error.status === 400
    && error.code === "push.registration_invalid",
);

await host.deliverHostedCollaboratorTurn(completedEvent());
assert.equal(deliveries.length, 2);
assert.deepEqual(new Set(deliveries.map((item) => item.registration.environment)),
                 new Set(["sandbox", "production"]));
assert.equal(deliveries[0].payload.route.conversationId, "hostconv_test");
const backgroundAlert = JSON.parse(encodedPayload(deliveries[0].payload));
assert.equal(backgroundAlert.aps["content-available"], 1);
assert.equal(backgroundAlert.aru.messageId, "hostmsg_test");

state.devices[1].revokedAt = ++clock;
await host.deliverHostedCollaboratorTurn(completedEvent());
assert.equal(deliveries.length, 3);
assert.equal(deliveries.at(-1).registration.deviceId, "phone_one");

await host.deliverHostedCollaboratorTurn({ ...completedEvent(), turn: { source: "client" } });
assert.equal(deliveries.length, 3);

const linuxSecretCalls = [];
const linuxCredentialStore = createAPNsCredentialStore({
  platform: "linux",
  run: (command, args) => {
    linuxSecretCalls.push({ command, args });
    if (args[0] === "--version") return { status: 2, stdout: "", stderr: "usage: secret-tool ..." };
    return { status: 1, stdout: "", stderr: "" };
  },
});
assert.deepEqual(linuxCredentialStore.availability(), {
  supported: true,
  storage: "linux-secret-service",
});
assert.equal(linuxCredentialStore.read(), null);
assert.ok(linuxSecretCalls.every((call) => !call.args.includes("--version")));

await registerLiveActivity("phone_one", "cc".repeat(32), "sandbox");
await host.deliverConversationTurnRelayUpdate({
  deviceId: "phone_one",
  conversationId: "conversation-local",
  state: "running",
  providerStatus: null,
});
assert.equal(liveActivityDeliveries.length, 1);
assert.equal(liveActivityDeliveries[0].payload.event, "update");
assert.equal(liveActivityDeliveries[0].payload.phase, "thinking");

await host.deliverConversationTurnRelayUpdate({
  deviceId: "phone_one",
  conversationId: "conversation-local",
  state: "running",
  providerStatus: 200,
});
assert.equal(liveActivityDeliveries.at(-1).payload.phase, "responding");

await host.deliverConversationTurnRelayUpdate({
  deviceId: "phone_one",
  conversationId: "conversation-local",
  state: "succeeded",
  providerStatus: 200,
});
assert.equal(liveActivityDeliveries.at(-1).payload.event, "end");
assert.deepEqual(liveActivityDeliveries.at(-1).payload.alert, {
  title: "Example Collaborator",
  body: "Reply ready",
});
const relayedTurn = (overrides = {}) => ({
  turnId: "turn_result_1", deviceId: "phone_one", conversationId: "conversation-local",
  state: "succeeded", providerStatus: 200, acknowledgedAt: null, ...overrides,
});
const directCount = deliveries.length;
await host.deliverConversationTurnRelayResult(relayedTurn({ state: "running" }));
assert.equal(deliveries.length, directCount, "non-terminal turns do not wake the phone");
await host.deliverConversationTurnRelayResult(relayedTurn({ acknowledgedAt: 1 }));
assert.equal(deliveries.length, directCount, "an acknowledged turn was already fetched");
await host.deliverConversationTurnRelayResult(relayedTurn({ deviceId: "phone_two" }));
assert.equal(deliveries.length, directCount, "revoked device receives nothing");
await host.deliverConversationTurnRelayResult(relayedTurn());
assert.equal(deliveries.length, directCount + 1);
assert.equal(deliveries.at(-1).registration.deviceId, "phone_one");
const relayedAlert = JSON.parse(encodedPayload(deliveries.at(-1).payload));
assert.equal(relayedAlert.aps.alert["loc-key"], "polaris.host.relayedReply.notification.body");
assert.equal("body" in relayedAlert.aps.alert, false);
assert.equal(relayedAlert.aps["content-available"], 1);
assert.deepEqual(relayedAlert.aru, {
  schema: "aru.conversation-turn-relay-route.v1", serverId: "server_test",
  conversationId: "conversation-local", turnId: "turn_result_1",
});
for (const failedState of ["failed", "interrupted", "cancelled"]) {
  await host.deliverConversationTurnRelayResult(relayedTurn({ turnId: `turn_${failedState}`, state: failedState }));
  const silent = JSON.parse(encodedPayload(deliveries.at(-1).payload));
  assert.equal(deliveries.at(-1).payload.silent, true, `${failedState} syncs silently`);
  assert.equal("alert" in silent.aps, false, `${failedState} shows no reply notice`);
  assert.equal(silent.aps["content-available"], 1);
  assert.equal(silent.aru.turnId, `turn_${failedState}`);
}
console.log("ARU_APNS_PUSH_SMOKE_OK");

async function register(deviceId, deviceToken, environment) {
  const response = await call("PUT", {
    schema: "aru.selfhost.remote-push-registration.v1",
    deviceToken,
    environment,
    topic: "cn.aelion.aru",
  }, deviceId);
  assert.equal(response.status, 200);
}

async function registerLiveActivity(deviceId, activityToken, environment) {
  const req = {
    method: "PUT",
    body: {
      schema: "aru.selfhost.live-activity-registration.v1",
      activityToken,
      activityId: "activity-one",
      conversationId: "conversation-local",
      collaboratorName: "Example Collaborator",
      completionBody: "Reply ready",
      environment,
      topic: "cn.aelion.aru",
    },
  };
  const res = {};
  const matched = await host.route(
    req, res, "/aru/v1/live-activities/current", () => ({ deviceId }),
  );
  assert.equal(matched, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.providerConfigured, true);
}

async function call(method, body, deviceId) {
  const req = { method, body };
  const res = {};
  const matched = await host.route(
    req, res, "/aru/v1/push-devices/current", () => ({ deviceId }),
  );
  assert.equal(matched, true);
  return res;
}

function completedEvent() {
  return {
    outcome: "completed",
    collaborator: { collaboratorId: "hostcol_test", displayName: "Example Collaborator" },
    conversation: { conversationId: "hostconv_test" },
    turn: { source: "proactive" },
    assistantMessage: { messageId: "hostmsg_test", content: "我从电脑醒来啦。" },
  };
}

const relayState = { devices: [{ deviceId: "relay_phone", revokedAt: null }] };
const relayCalls = [];
const relayOptions = {
  state: relayState, saveState() {}, readJSONBody: async (req) => req.body,
  sendJSON(res, status, body) { res.status = status; res.body = body; }, HttpError,
  serverId: "server_test", credentialStore: { availability: () => ({ supported: false }), read: () => null },
  relayBaseURL: "https://wake.example.test",
  fetchImpl: async (url, init) => { relayCalls.push({ url: String(url), body: JSON.parse(init.body) }); return { status: 202, json: async () => ({ schema: "aru.wake-relay.receipt.v1", requestId: "hostmsg_test", accepted: true }) }; },
};
let relayHost = createAPNsPushHost(relayOptions);
const relayResponse = {};
await relayHost.route({ method: "PUT", body: {
  schema: "aru.selfhost.remote-push-registration.v1", environment: "sandbox", topic: "cn.aelion.aru",
  relayRouteId: "22222222-2222-4222-8222-222222222222", relayWakeToken: "w".repeat(64),
} }, relayResponse, "/aru/v1/push-devices/current", () => relayState.devices[0]);
assert.equal(relayResponse.body.providerConfigured, true);
assert.equal(relayState.remotePushRegistrations[0].deviceToken, null);
relayHost = createAPNsPushHost(relayOptions); // durable registration survives Host restart
await relayHost.deliverHostedCollaboratorTurn(completedEvent());
assert.equal(relayCalls.length, 1);
assert.equal(relayCalls[0].body.notificationRoute.messageId, "hostmsg_test");
assert.equal("body" in relayCalls[0].body.notificationRoute, false);
await relayHost.deliverConversationTurnRelayResult({
  turnId: "turn_relay_1", deviceId: "relay_phone", conversationId: "conversation-local",
  state: "succeeded", providerStatus: 200, acknowledgedAt: null,
});
assert.equal(relayCalls.length, 2);
assert.equal(relayCalls[1].body.requestId, "turn_relay_1");
assert.deepEqual(relayCalls[1].body.notificationRoute, {
  schema: "aru.conversation-turn-relay-route.v1", serverId: "server_test",
  conversationId: "conversation-local", turnId: "turn_relay_1",
});
await relayHost.deliverConversationTurnRelayResult({
  turnId: "turn_relay_failed", deviceId: "relay_phone", conversationId: "conversation-local",
  state: "failed", providerStatus: 500, acknowledgedAt: null,
});
assert.equal(relayCalls.length, 2, "a failed turn never becomes a visible relay alert");
relayState.devices[0].revokedAt = Date.now();
await relayHost.deliverHostedCollaboratorTurn(completedEvent());
assert.equal(relayCalls.length, 2);
console.log("ARU_HOST_NOTIFICATION_RELAY_SMOKE_OK");
