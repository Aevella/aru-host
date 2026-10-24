import test from "node:test";
import assert from "node:assert/strict";
import { assistantDeliveryContent } from "../src/host/assistant-delivery-content.mjs";

const fields = { sent_at: "2026-10-24T01:00:00.000Z", sent_at_unix_ms: Date.parse("2026-10-24T01:00:00Z"),
  updated_at: "2026-10-24T01:00:00.000Z", updated_at_unix_ms: Date.parse("2026-10-24T01:00:00Z") };
const tag = `<message_meta>${JSON.stringify(fields)}</message_meta>`;

test("only the standalone Host timestamp echo is removed", () => {
  assert.equal(assistantDeliveryContent(`${tag}\r\nHello.\n   ${tag}\nStill here.`), "Hello.\nStill here.");
  assert.equal(assistantDeliveryContent(tag), "");
});

test("examples, thought prose, malformed and unknown envelopes remain authored", () => {
  for (const source of [
    `Example: ${tag}`, `\`${tag}\``, `    ${tag}`, `\t${tag}`,
    `\`\`\`xml\n${tag}\n\`\`\``, `~~~~xml\n${tag}\n~~~\n${tag}\n~~~~`,
    `<thinking>Keep the user's authored text.</thinking>`,
    `<message_meta>{broken}</message_meta>`,
    `<message_meta>${JSON.stringify({ ...fields, note: "authored" })}</message_meta>`,
    `<message_meta>${JSON.stringify({ ...fields, sent_at_unix_ms: 1 })}</message_meta>`,
    `<message_meta>${JSON.stringify({ ...fields, sent_at_unix_ms: true })}</message_meta>`,
  ]) assert.equal(assistantDeliveryContent(source), source.trim());
});
