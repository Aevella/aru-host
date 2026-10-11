import assert from "node:assert/strict";
import test from "node:test";
import { createDirectAPIDriver } from "../direct-api-driver.mjs";

test("JSON tool continuation retains signed blocks and drops only empty text", async () => {
  const profile = { profileId: "test", protocol: "anthropic-messages",
    baseURL: "https://example.test", path: "v1/messages", model: "test",
    authMode: "none", maxOutputTokens: 32768 };
  const requests = [];
  const blocks = [
    { type: "thinking", thinking: "Plan", signature: "signature" },
    { type: "redacted_thinking", data: "opaque" },
    { type: "text", text: "" },
    { type: "text", text: "I will check." },
    { type: "tool_use", id: "call_one", name: "read", input: {} },
  ];
  const driver = createDirectAPIDriver({ profileForId: () => profile,
    readSecret: () => null,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ content: requests.length === 1 ? blocks : [{ type: "text", text: "Done." }] });
    },
  }).forProfile("test");
  let calls = 0;
  const deltas = [];
  await new Promise((resolve, reject) => {
    driver.startTurn({ instructions: "Test", historyMessages: [], text: "Check",
      tools: [{ name: "read", inputSchema: { type: "object" } }],
      handler: {
        onToolCall: async () => { calls++; return { found: true }; },
        onNotification: async (method, params) => {
          if (method === "item/agentMessage/delta") deltas.push(params.delta);
          if (method === "turn/completed") {
            if (params.turn.status === "completed") resolve();
            else reject(new Error(params.turn.error?.message ?? params.turn.status));
          }
        },
      },
    }).catch(reject);
  });
  assert.equal(calls, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.at(-2).content, blocks.filter(block => block.type !== "text" || block.text));
  assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, "call_one");
  assert.deepEqual(deltas, ["I will check.", "Done."]);
});
