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

test('ordinary conversation pages and sync clean assistant envelopes without rewriting ledger or user examples', async () => {
  const { messagePage, syncProjection, publicMessage } = await import('../src/conversations/conversation-sync.mjs');
  const ms = 1793280949131;
  const tag = `<message_meta>${JSON.stringify({sent_at:new Date(ms).toISOString(),sent_at_unix_ms:ms,updated_at:new Date(ms).toISOString(),updated_at_unix_ms:ms})}</message_meta>`;
  const conversation = { messages: [
    {messageId:'u',role:'user',content:tag},
    {messageId:'a',role:'assistant',content:tag+'\nHello'}
  ], events:[], approvals:[] };
  assert.equal(publicMessage(conversation.messages[1]).content, 'Hello');
  assert.equal(messagePage(conversation).messages[0].content, tag);
  assert.equal(messagePage(conversation).messages[1].content, 'Hello');
  assert.equal(syncProjection(conversation, {}, 1, null).conversation.messages[1].content, 'Hello');
  assert.equal(conversation.messages[1].content, tag+'\nHello');
});

 test('streaming projection holds split envelope but preserves completed examples and whitespace', async () => {
  const { publicMessage } = await import('../src/conversations/conversation-sync.mjs');
  assert.equal(publicMessage({role:'assistant',status:'streaming',content:'Hello\n<message_me'}).content, 'Hello\n');
  assert.equal(publicMessage({role:'assistant',status:'completed',content:'Hello\n<message_me'}).content, 'Hello\n<message_me');
  assert.equal(publicMessage({role:'assistant',content:'  prose\n\n'}).content, '  prose\n\n');
});
