import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { sealWakeEvent, submitWakeEvent } from "../wake-send.mjs";

const key = randomBytes(32);
const bundle = {
  schema: "aru.wake-bridge.sender-bundle.v2",
  triggerId: "trigger-1",
  submitURL: "https://host.example/aru/v1/wake-bridge/endpoints/e/events",
  submitToken: "submit-secret",
  encryptionKey: key.toString("base64"),
};
const envelope = sealWakeEvent(bundle, "garden reply", "event-1");
const combined = Buffer.from(envelope.sealedPayload, "base64");
const decipher = createDecipheriv("aes-256-gcm", key, combined.subarray(0, 12));
decipher.setAuthTag(combined.subarray(combined.length - 16));
const plaintext = Buffer.concat([
  decipher.update(combined.subarray(12, combined.length - 16)),
  decipher.final(),
]);
const payload = JSON.parse(plaintext.toString("utf8"));
assert.equal(payload.schema, "aru.wake-bridge.payload.v2");
assert.equal(payload.triggerId, "trigger-1");
assert.equal(payload.content, "garden reply");
assert.equal(payload.collaboratorId, undefined);
assert.equal(payload.conversationId, undefined);

let posted;
const eventId = await submitWakeEvent(bundle, "new event", async (url, options) => {
  posted = { url, options };
  return { ok: true, status: 202 };
});
assert.equal(posted.url, bundle.submitURL);
assert.equal(posted.options.headers.authorization, `Bearer ${bundle.submitToken}`);
assert.equal(JSON.parse(posted.options.body).eventId, eventId);
console.log("wake sender smoke passed");
