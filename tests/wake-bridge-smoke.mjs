import assert from "node:assert/strict";
import { createWakeBridge } from "../wake-bridge.mjs";

const state = {
  wakeBridgeEndpoints: [{
    endpointId: "legacy-phone", fetchTokenHash: "old", submitTokenHash: "old",
    encryptionKeyFingerprint: "0123456789abcdef01234567",
    deviceToken: "a".repeat(64), environment: "sandbox", topic: "cn.aelion.aru",
  }],
};
const responses = [];
let body;
const relayRequests = [];
let failNextRelayRequest = false;
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const bridge = createWakeBridge({
  state,
  saveState() {},
  async readJSONBody() { return body; },
  sendJSON(_res, status, value) { responses.push({ status, value }); },
  HttpError,
  relayBaseURL: "https://wake.example",
  async fetchImpl(url, options) {
    relayRequests.push({ url, options });
    if (failNextRelayRequest) {
      failNextRelayRequest = false;
      return { ok: false, status: 503 };
    }
    return { ok: true, status: 202 };
  },
  now: (() => { let value = 10; return () => value++; })(),
});
assert.equal(Object.hasOwn(state.wakeBridgeEndpoints[0], "deviceToken"), false);
assert.equal(state.wakeBridgeEndpoints[0].relayRouteId, "");
state.wakeBridgeEndpoints = [];
const token = "f".repeat(64);
const submit = "s".repeat(64);
const relayWake = "w".repeat(64);
const relayRouteId = "11111111-1111-4111-8111-111111111111";
const request = (method, authorization) => ({ method, headers: { authorization: `Bearer ${authorization}` } });

body = {
  schema: "aru.wake-bridge.registration.v2", endpointId: "phone-1",
  fetchToken: token, submitToken: submit, encryptionKeyFingerprint: "0123456789abcdef01234567",
  relayRouteId, relayWakeToken: relayWake,
};
assert.equal(await bridge.route(request("PUT", ""), {}, "/aru/v1/wake-bridge/endpoints/current"), true);
// Authenticated malformed payloads must use the server's recognized HTTP error.
for (const invalidPayload of [undefined, "", "x".repeat(192 * 1024 + 1)]) {
  body = { schema: "aru.wake-bridge.sealed-event.v1", eventId: "bad-event", sealedPayload: invalidPayload };
  await assert.rejects(
    bridge.route(request("POST", submit), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events"),
    (error) => error instanceof HttpError && error.status === 400
      && error.code === "wake.invalid_request" && error.message === "sealedPayload is invalid",
  );
  assert.equal(state.wakeBridgeEvents.length, 0);
}
body = { schema: "aru.wake-bridge.sealed-event.v1", eventId: "bad-event" };
await assert.rejects(
  bridge.route(request("POST", "wrong-token"), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events"),
  (error) => error instanceof HttpError && error.status === 401,
);
body = { schema: "aru.wake-bridge.sealed-event.v1", eventId: "event-1", sealedPayload: "ciphertext" };
await bridge.route(request("POST", submit), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
await bridge.route(request("POST", submit), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(state.wakeBridgeEvents.length, 1);
assert.equal(relayRequests.length, 1);
assert.equal(relayRequests[0].url, `https://wake.example/aru/v1/wake-relay/routes/${relayRouteId}/requests`);
assert.equal(relayRequests[0].options.headers.authorization, `Bearer ${relayWake}`);
const relayBody = JSON.parse(relayRequests[0].options.body);
assert.equal(relayBody.schema, "aru.wake-relay.request.v1");
assert.equal(typeof relayBody.requestId, "string");
assert.equal(relayRequests[0].options.body.includes("ciphertext"), false);
failNextRelayRequest = true;
body = { schema: "aru.wake-bridge.sealed-event.v1", eventId: "event-2", sealedPayload: "ciphertext-2" };
await bridge.route(request("POST", submit), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
await new Promise((resolve) => setImmediate(resolve));
assert.match(state.wakeBridgeEndpoints[0].lastFailure, /HTTP 503/);
await bridge.route(request("POST", submit), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(relayRequests.length, 3);
assert.equal(JSON.parse(relayRequests[1].options.body).requestId,
  JSON.parse(relayRequests[2].options.body).requestId);
assert.equal(state.wakeBridgeEndpoints[0].lastFailure, null);
await bridge.route(request("GET", token), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
assert.equal(responses.at(-1).value.events.length, 2);
// Only the receiver can discard one rejected event. Other events and registration survive.
await assert.rejects(
  bridge.route(request("DELETE", submit), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events/event-1"),
  error => error.status === 401);
assert.equal(state.wakeBridgeEvents.length, 2);
state.wakeBridgeEvents.push({ endpointId: "other-phone", eventId: "event-1", sealedPayload: "unrelated", createdAt: 1, acknowledgedAt: null });
await bridge.route(request("DELETE", token), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events/event-1");
assert.ok(state.wakeBridgeEvents.some(event => event.endpointId === "other-phone"));
state.wakeBridgeEvents = state.wakeBridgeEvents.filter(event => event.endpointId !== "other-phone");
assert.deepEqual(state.wakeBridgeEvents.map(event => event.eventId), ["event-2"]);
assert.equal(state.wakeBridgeEndpoints.length, 1);
await bridge.route(request("DELETE", token), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events/event-1");
assert.equal(state.wakeBridgeEvents.length, 1);
await bridge.route(request("POST", token), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events/event-1/ack");
await bridge.route(request("POST", token), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events/event-2/ack");
await bridge.route(request("GET", token), {}, "/aru/v1/wake-bridge/endpoints/phone-1/events");
assert.equal(responses.at(-1).value.events.length, 0);
// A failed ACK on the oldest page must not hide newer events. Cursor identity
// survives deletion of the last event in the previous page.
for (let i = 0; i < 35; i++) {
  state.wakeBridgeEvents.push({ endpointId: "phone-1", eventId: `page-${String(i).padStart(3, "0")}`,
    sealedPayload: "ciphertext", createdAt: 10000 + i, acknowledgedAt: null });
}
const pagePath = "/aru/v1/wake-bridge/endpoints/phone-1/events";
await bridge.route(request("GET", token), {}, pagePath);
const page = responses.at(-1).value;
assert.ok(page.nextCursor);
const lastId = page.events.at(-1).eventId;
await bridge.route(request("DELETE", token), {}, `${pagePath}/${lastId}`);
await bridge.route({ ...request("GET", token), url: `${pagePath}?after=${encodeURIComponent(page.nextCursor)}` }, {}, pagePath);
assert.ok(responses.at(-1).value.events.some(event => event.eventId === "page-034"));
assert.ok(!responses.at(-1).value.events.some(event => event.eventId === lastId));

await bridge.route(request("DELETE", token), {}, "/aru/v1/wake-bridge/endpoints/current");
assert.equal(state.wakeBridgeEndpoints.length, 0);
assert.equal(state.wakeBridgeEvents.length, 0);

console.log("wake bridge smoke passed");
