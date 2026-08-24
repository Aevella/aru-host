import assert from "node:assert/strict";
import { createWakeBridge } from "../wake-bridge.mjs";

const state = {};
const responses = [];
let body;
let pushes = 0;
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const bridge = createWakeBridge({
  state,
  saveState() {},
  async readJSONBody() { return body; },
  sendJSON(_res, status, value) { responses.push({ status, value }); },
  HttpError,
  credentialStore: { read: () => ({ key: "fixture" }) },
  async sendPush() { pushes += 1; },
  now: (() => { let value = 10; return () => value++; })(),
});
const token = "f".repeat(64);
const submit = "s".repeat(64);
const request = (method, authorization) => ({ method, headers: { authorization: `Bearer ${authorization}` } });

body = {
  schema: "aru.wake-bridge.registration.v1", endpointId: "phone-1",
  fetchToken: token, submitToken: submit, encryptionKeyFingerprint: "0123456789abcdef01234567",
  deviceToken: "a".repeat(64), environment: "sandbox", topic: "cn.aelion.aru",
};
assert.equal(await bridge.route(request("PUT", ""), {}, "/aru/v1/wake-bridge/endpoints/current"), true);
body = { schema: "aru.wake-bridge.sealed-event.v1", eventId: "event-1", sealedPayload: "ciphertext" };
await bridge.route(request("POST", submit), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
await bridge.route(request("POST", submit), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(state.wakeBridgeEvents.length, 1);
assert.equal(pushes, 1);
await bridge.route(request("GET", token), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
assert.equal(responses.at(-1).value.events.length, 1);
await bridge.route(request("POST", token), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events/event-1/ack");
await bridge.route(request("GET", token), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
assert.equal(responses.at(-1).value.events.length, 0);
await bridge.route(request("DELETE", token), {}, "/aru/v1/wake-bridge/endpoints/current");
assert.equal(state.wakeBridgeEndpoints.length, 0);
assert.equal(state.wakeBridgeEvents.length, 0);
console.log("wake bridge smoke passed");
