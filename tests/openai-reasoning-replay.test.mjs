import test from "node:test";
import assert from "node:assert/strict";
import { createDirectAPIDriver } from "../direct-api-driver.mjs";

const profile = { profileId: "provider_reasoning_fixture", protocol: "openai-compatible",
  baseURL: "https://example.test/", path: "v1/chat/completions", model: "fixture", authMode: "none" };
const tools = [{ name: "lookup", description: "Read fixture", inputSchema: { type: "object" } }];
const call = id => ({ id, type: "function", function: { name: "lookup", arguments: "{}" } });
function response(message, streaming) {
  if (!streaming) return new Response(JSON.stringify({ choices: [{ message }] }),
    { headers: { "content-type": "application/json" } });
  const deltas = [];
  if (Object.hasOwn(message, "reasoning_content")) {
    const text = message.reasoning_content;
    deltas.push({ reasoning_content: text.slice(0, 3) }, { reasoning_content: text.slice(3) });
  }
  if (message.content) deltas.push({ content: message.content });
  if (message.tool_calls) deltas.push({ tool_calls: message.tool_calls.map((c, index) => ({ ...c, index })) });
  return new Response(deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}
async function run(driver) {
  let executions = 0;
  const visible = [];
  await new Promise((resolve, reject) => {
    driver.startTurn({ threadId: null, instructions: "Fixture", historyMessages: [], text: "Read twice", tools,
      handler: {
        onToolCall: async () => { executions++; return { value: "fixture" }; },
        onNotification: async (method, params) => {
          if (method === "item/agentMessage/delta") visible.push(params.delta);
          if (method === "turn/completed") params.turn.status === "completed" ? resolve() : reject(new Error(params.turn.error?.message));
        },
      },
    }).catch(reject);
  });
  return { executions, visible: visible.join("") };
}
for (const streaming of [false, true]) {
  test(`${streaming ? "SSE" : "JSON"} reasoning survives two tool continuations without entering dialogue`, async () => {
    let round = 0;
    const driver = createDirectAPIDriver({ profileForId: () => profile, readSecret: () => null,
      fetchImpl: async (_url, init) => {
        const messages = JSON.parse(init.body).messages;
        const assistants = messages.filter(m => m.role === "assistant");
        assert.equal(assistants.length, round);
        for (let i = 0; i < round; i++) {
          assert.equal(assistants[i].reasoning_content, `Private protocol ${i}`);
          assert.equal(assistants[i].tool_calls[0].id, `call_${i}`);
        }
        const current = round++;
        return response(current < 2 ? { role: "assistant", content: null,
          reasoning_content: `Private protocol ${current}`, tool_calls: [call(`call_${current}`)] }
          : { role: "assistant", content: "Done.", reasoning_content: "Final protocol" }, streaming);
      },
    }).forProfile(profile.profileId);
    assert.deepEqual(await run(driver), { executions: 2, visible: "Done." });
    round = 0;
    assert.deepEqual(await run(driver), { executions: 2, visible: "Done." });
  });
  test(`${streaming ? "SSE" : "JSON"} absent reasoning stays absent and an explicit empty string survives`, async () => {
    for (const reasoning of [undefined, ""]) {
      let round = 0;
      const driver = createDirectAPIDriver({ profileForId: () => profile, readSecret: () => null,
        fetchImpl: async (_url, init) => {
          if (round++ === 0) return response({ role: "assistant", content: null,
            ...(reasoning === undefined ? {} : { reasoning_content: reasoning }), tool_calls: [call("call_empty")] }, streaming);
          const assistant = JSON.parse(init.body).messages.find(m => m.role === "assistant");
          assert.equal(Object.hasOwn(assistant, "reasoning_content"), reasoning !== undefined);
          assert.equal(assistant.reasoning_content, reasoning);
          return response({ role: "assistant", content: "Done." }, streaming);
        },
      }).forProfile(profile.profileId);
      assert.deepEqual(await run(driver), { executions: 1, visible: "Done." });
    }
  });
}
