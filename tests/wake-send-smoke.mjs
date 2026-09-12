import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
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

// A paired LAN or Tailscale Host is served over plain HTTP, so its bundle seals
// the same way; anything that is not an HTTP(S) endpoint stays rejected.
const lanBundle = {
  ...bundle,
  submitURL: "http://home-mac.local:8787/aru/v1/wake-bridge/endpoints/e/events",
};
assert.equal(sealWakeEvent(lanBundle, "lan reply", "event-2").eventId, "event-2");
assert.throws(
  () => sealWakeEvent({ ...bundle, submitURL: "file:///tmp/events" }, "nope"),
  /invalid sender bundle/,
);
let received;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  received = { authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("utf8") };
  response.writeHead(202).end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const submitURL = `http://127.0.0.1:${server.address().port}/aru/v1/wake-bridge/endpoints/e/events`;
  const sentId = await submitWakeEvent({ ...lanBundle, submitURL }, "private LAN event");
  assert.equal(received.authorization, `Bearer ${bundle.submitToken}`);
  assert.equal(JSON.parse(received.body).eventId, sentId);
  assert.equal(received.body.includes("private LAN event"), false);
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log("wake sender smoke passed (including real HTTP submission)");
