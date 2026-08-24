#!/usr/bin/env node
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function sealWakeEvent(bundle, content, eventId = randomUUID()) {
  if (bundle?.schema !== "aru.wake-bridge.sender-bundle.v2"
      || typeof bundle.triggerId !== "string" || bundle.triggerId.length === 0
      || typeof bundle.submitURL !== "string" || !bundle.submitURL.startsWith("https://")
      || typeof bundle.submitToken !== "string" || bundle.submitToken.length === 0) {
    throw new Error("invalid sender bundle");
  }
  const key = Buffer.from(bundle.encryptionKey ?? "", "base64");
  if (key.length !== 32) throw new Error("invalid encryption key");
  const normalizedContent = String(content ?? "").trim();
  if (normalizedContent.length === 0) throw new Error("event content is empty");

  const payload = Buffer.from(JSON.stringify({
    schema: "aru.wake-bridge.payload.v2",
    eventId,
    triggerId: bundle.triggerId,
    content: normalizedContent,
  }), "utf8");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    schema: "aru.wake-bridge.sealed-event.v1",
    eventId,
    sealedPayload: Buffer.concat([nonce, ciphertext, tag]).toString("base64"),
  };
}

export async function submitWakeEvent(bundle, content, fetchImpl = fetch) {
  const envelope = sealWakeEvent(bundle, content);
  const response = await fetchImpl(bundle.submitURL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bundle.submitToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(envelope),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`wake submission failed: HTTP ${response.status}`);
  return envelope.eventId;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const bundleFlag = process.argv.indexOf("--bundle");
  if (bundleFlag < 0 || !process.argv[bundleFlag + 1]) {
    throw new Error("usage: printf 'event text' | node wake-send.mjs --bundle sender.json");
  }
  const bundle = JSON.parse(await readFile(process.argv[bundleFlag + 1], "utf8"));
  const eventId = await submitWakeEvent(bundle, await readStdin());
  process.stdout.write(`${eventId}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
