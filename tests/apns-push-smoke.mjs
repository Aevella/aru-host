import assert from "node:assert/strict";
import { createAPNsPushHost } from "../apns-push.mjs";

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

state.devices[1].revokedAt = ++clock;
await host.deliverHostedCollaboratorTurn(completedEvent());
assert.equal(deliveries.length, 3);
assert.equal(deliveries.at(-1).registration.deviceId, "phone_one");

await host.deliverHostedCollaboratorTurn({ ...completedEvent(), turn: { source: "client" } });
assert.equal(deliveries.length, 3);
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
