#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectAPIDriver } from "../direct-api-driver.mjs";

const profile = {
  profileId: "provider_test",
  protocol: "openai-compatible",
  baseURL: "https://example.test/",
  path: "v1/chat/completions",
  model: "test-model",
  authMode: "bearer",
  hasSecret: true,
};
const requests = [];
const responses = [
  {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_one",
          type: "function",
          function: { name: "remember", arguments: "{\"value\":\"hello\"}" },
        }],
      },
    }],
  },
  { choices: [{ message: { role: "assistant", content: "已经记住啦", tool_calls: [] } }] },
];
const fetchImpl = async (url, init) => {
  requests.push({ url, init, body: JSON.parse(init.body) });
  return new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const driver = createDirectAPIDriver({
  profileForId: () => profile,
  readSecret: () => "secret-test-value",
  fetchImpl,
}).forProfile(profile.profileId);
driver.validateAttachments([{ kind: "image", filename: "photo.png" }]);
assert.throws(
  () => driver.validateAttachments([{ kind: "file", filename: "notes.pdf" }]),
  /只能原生接收图片/,
);

const notifications = [];
const calls = [];
const completed = new Promise((resolve, reject) => {
  driver.startTurn({
    threadId: null,
    instructions: "You are a test collaborator.",
    historyMessages: [{ role: "user", content: "Earlier" }, { role: "assistant", content: "Yes" }],
    tools: [{ name: "remember", description: "Remember a value", inputSchema: { type: "object" } }],
    text: "Remember hello",
    handler: {
      async onToolCall(call) {
        calls.push(call);
        return { saved: true };
      },
      async onNotification(method, params) {
        notifications.push({ method, params });
        if (method === "turn/completed") {
          if (params.turn.status === "completed") resolve();
          else reject(new Error(params.turn.error?.message ?? params.turn.status));
        }
      },
    },
  }).catch(reject);
});

await completed;
assert.equal(requests.length, 2);
assert.equal(requests[0].url, "https://example.test/v1/chat/completions");
assert.equal(requests[0].init.headers.authorization, "Bearer secret-test-value");
assert.equal(requests[0].init.redirect, "manual");
assert.equal(JSON.stringify(requests).includes("secret-test-value"), true);
assert.equal(calls.length, 1);
assert.equal(calls[0].tool, "remember");
assert.deepEqual(calls[0].arguments, { value: "hello" });
assert.equal(requests[1].body.messages.at(-1).role, "tool");
assert.equal(requests[1].body.messages.at(-1).tool_call_id, "call_one");
assert.equal(
  notifications.find((item) => item.method === "item/agentMessage/delta")?.params.delta,
  "已经记住啦",
);
assert.equal(notifications.at(-1).method, "turn/completed");

const limitedProfile = { ...profile, maxToolRounds: 1 };
const limitedResponses = ["limited_one", "limited_two"].map((id) => ({
  choices: [{
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id,
        type: "function",
        function: { name: "remember", arguments: "{\"value\":\"again\"}" },
      }],
    },
  }],
}));
let limitedRequestCount = 0;
let limitedToolCallCount = 0;
const limitedDriver = createDirectAPIDriver({
  profileForId: () => limitedProfile,
  readSecret: () => "limited-key",
  fetchImpl: async () => {
    limitedRequestCount += 1;
    return new Response(JSON.stringify(limitedResponses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}).forProfile(limitedProfile.profileId);
const limitedCompletion = await new Promise((resolve, reject) => {
  limitedDriver.startTurn({
    threadId: null,
    instructions: "Limit tools",
    historyMessages: [],
    tools: [{ name: "remember", description: "Remember", inputSchema: { type: "object" } }],
    text: "Keep using tools",
    handler: {
      async onToolCall() {
        limitedToolCallCount += 1;
        return { saved: true };
      },
      async onNotification(method, params) {
        if (method === "turn/completed") resolve(params.turn);
      },
    },
  }).catch(reject);
});
assert.equal(limitedCompletion.status, "failed");
assert.match(limitedCompletion.error.message, /1 回合/);
assert.equal(limitedRequestCount, 2);
assert.equal(limitedToolCallCount, 1);

let escapedFetchCalled = false;
const escapingDriver = createDirectAPIDriver({
  profileForId: () => ({ ...profile, path: "http://169.254.169.254/latest/meta-data/" }),
  readSecret: () => "must-stay-local",
  fetchImpl: async () => {
    escapedFetchCalled = true;
    return new Response("{}", { status: 200 });
  },
});
await assert.rejects(
  () => escapingDriver.testProfile(profile.profileId),
  /不能离开配置的 baseURL/,
);
assert.equal(escapedFetchCalled, false);

const redirectingDriver = createDirectAPIDriver({
  profileForId: () => profile,
  readSecret: () => "redirect-key",
  fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, "manual");
    return new Response("", {
      status: 307,
      headers: { location: "https://elsewhere.example/steal" },
    });
  },
});
await assert.rejects(
  () => redirectingDriver.testProfile(profile.profileId),
  /没有继续请求/,
);

const echoingDriver = createDirectAPIDriver({
  profileForId: () => profile,
  readSecret: () => "echoed-secret-key",
  fetchImpl: async () => new Response(JSON.stringify({
    error: { message: "upstream echoed echoed-secret-key" },
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  }),
});
await assert.rejects(
  () => echoingDriver.testProfile(profile.profileId),
  (error) => !error.message.includes("echoed-secret-key") && error.message.includes("[REDACTED]"),
);

const streamEvents = [
  { choices: [{ delta: { role: "assistant", content: "流式" } }] },
  { choices: [{ delta: { content: "回复" } }] },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
const streamDriver = createDirectAPIDriver({
  profileForId: () => profile,
  readSecret: () => "secret-test-value",
  fetchImpl: async () => new Response(streamEvents, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }),
}).forProfile(profile.profileId);
const streamedDeltas = [];
await new Promise((resolve, reject) => {
  streamDriver.startTurn({
    threadId: null,
    instructions: "Stream",
    historyMessages: [],
    tools: [],
    text: "Reply",
    handler: {
      async onToolCall() { throw new Error("unexpected tool"); },
      async onNotification(method, params) {
        if (method === "item/agentMessage/delta") streamedDeltas.push(params.delta);
        if (method === "turn/completed") {
          if (params.turn.status === "completed") resolve();
          else reject(new Error(params.turn.error?.message ?? params.turn.status));
        }
      },
    },
  }).catch(reject);
});
assert.deepEqual(streamedDeltas, ["流式", "回复"]);

const anthropicProfile = {
  ...profile,
  protocol: "anthropic-messages",
  path: "v1/messages",
  authMode: "x-api-key",
  maxOutputTokens: 32_768,
};
const anthropicRequests = [];
const anthropicResponses = [
  [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_one", name: "remember" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"value\":\"anthropic\"}" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ],
  [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "安" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
    { type: "message_stop" },
  ],
].map((events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
const anthropicDriver = createDirectAPIDriver({
  profileForId: () => anthropicProfile,
  readSecret: () => "anthropic-test-key",
  fetchImpl: async (url, init) => {
    anthropicRequests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(anthropicResponses.shift(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  },
}).forProfile(anthropicProfile.profileId);
const anthropicDeltas = [];
const anthropicCalls = [];
await new Promise((resolve, reject) => {
  anthropicDriver.startTurn({
    threadId: null,
    instructions: "Anthropic stream",
    historyMessages: [],
    tools: [{ name: "remember", description: "Remember", inputSchema: { type: "object" } }],
    text: "Remember anthropic",
    handler: {
      async onToolCall(call) {
        anthropicCalls.push(call);
        return { saved: true };
      },
      async onNotification(method, params) {
        if (method === "item/agentMessage/delta") anthropicDeltas.push(params.delta);
        if (method === "turn/completed") {
          if (params.turn.status === "completed") resolve();
          else reject(new Error(params.turn.error?.message ?? params.turn.status));
        }
      },
    },
  }).catch(reject);
});
assert.equal(anthropicRequests.length, 2);
assert.equal(anthropicRequests[0].headers["x-api-key"], "anthropic-test-key");
assert.equal(anthropicRequests[0].headers["anthropic-version"], "2023-06-01");
assert.equal(anthropicRequests[0].body.max_tokens, 32_768);
assert.deepEqual(anthropicCalls[0].arguments, { value: "anthropic" });
assert.equal(anthropicRequests[1].body.messages.at(-1).content[0].type, "tool_result");
assert.deepEqual(anthropicDeltas, ["安", "好"]);
anthropicDriver.validateAttachments([
  { kind: "file", mimeType: "application/pdf", filename: "paper.pdf" },
]);
assert.throws(
  () => anthropicDriver.validateAttachments([
    { kind: "audio", mimeType: "audio/mpeg", filename: "voice.mp3" },
  ]),
  /不能接收/,
);

const imageRoot = mkdtempSync(join(tmpdir(), "aru-direct-image-"));
const imagePath = join(imageRoot, "tiny.png");
writeFileSync(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
let imageRequest;
const imageDriver = createDirectAPIDriver({
  profileForId: () => profile,
  readSecret: () => "image-key",
  fetchImpl: async (_url, init) => {
    imageRequest = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "看到了", tool_calls: [] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
}).forProfile(profile.profileId);
await new Promise((resolve, reject) => imageDriver.startTurn({
  instructions: "See image", historyMessages: [], tools: [], text: "看看",
  attachments: [{ kind: "image", filename: "tiny.png", mimeType: "image/png", path: imagePath }],
  handler: {
    async onToolCall() {},
    async onNotification(method, params) {
      if (method === "turn/completed") params.turn.status === "completed" ? resolve() : reject(params.turn.error);
    },
  },
}).catch(reject));
assert.match(imageRequest.messages.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);

// --- Tool-argument robustness ------------------------------------------------
// A relay may return arguments already as an object, or as an empty string for
// a no-argument tool. Neither is "unreadable".
function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
function sseResponse(events, terminator = "") {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + terminator;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function runTurn(driver, tools, onToolCall) {
  const seen = { requests: [], deltas: [], items: [] };
  const done = new Promise((resolve) => {
    driver.startTurn({
      threadId: null, instructions: "Robustness", historyMessages: [], tools, text: "调用工具",
      handler: {
        onToolCall,
        async onNotification(method, params) {
          if (method === "item/agentMessage/delta") seen.deltas.push(params.delta);
          if (method === "item/started" || method === "item/completed") seen.items.push(method);
          if (method === "turn/completed") resolve(params.turn);
        },
      },
    });
  });
  return { seen, done };
}
const rememberTool = [{ name: "remember", description: "Remember", inputSchema: { type: "object" } }];

const objectArgumentsResponses = [
  { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
    { id: "call_object", type: "function", function: { name: "remember", arguments: { value: "object" } } },
    { id: "call_empty", type: "function", function: { name: "remember", arguments: "" } },
  ] } }] },
  { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "两个都执行了", tool_calls: [] } }] },
];
const objectRequests = [];
const objectDriver = createDirectAPIDriver({
  profileForId: () => profile,
  readSecret: () => "object-key",
  fetchImpl: async (_url, init) => { objectRequests.push(JSON.parse(init.body)); return jsonResponse(objectArgumentsResponses.shift()); },
}).forProfile(profile.profileId);
const objectCalls = [];
const objectRun = runTurn(objectDriver, rememberTool, async (call) => { objectCalls.push(call); return { saved: true }; });
const objectTurn = await objectRun.done;
assert.equal(objectTurn.status, "completed", objectTurn.error?.message);
assert.deepEqual(objectCalls.map((call) => call.arguments), [{ value: "object" }, {}]);
assert.equal(objectRequests[1].messages.at(-3).tool_calls[0].function.arguments, "{\"value\":\"object\"}");

// Unreadable JSON that was NOT cut off: the model receives a tool error and
// gets to re-issue the call; the turn is not ended and the tool never ran.
const brokenStreamResponses = [
  sseResponse([
    { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_broken", function: { name: "remember", arguments: "{\"value\":" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"oops\"" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"value\":\"oops\"}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ], "data: [DONE]\n\n"),
  sseResponse([
    { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_fixed", function: { name: "remember", arguments: "{\"value\":\"fixed\"}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ], "data: [DONE]\n\n"),
  sseResponse([{ choices: [{ delta: { content: "修好了" }, finish_reason: "stop" }] }], "data: [DONE]\n\n"),
];
const brokenRequests = [];
const brokenDriver = createDirectAPIDriver({
  profileForId: () => profile,
  readSecret: () => "broken-key",
  fetchImpl: async (_url, init) => { brokenRequests.push(JSON.parse(init.body)); return brokenStreamResponses.shift(); },
}).forProfile(profile.profileId);
const brokenCalls = [];
const brokenRun = runTurn(brokenDriver, rememberTool, async (call) => { brokenCalls.push(call); return { saved: true }; });
const brokenTurn = await brokenRun.done;
assert.equal(brokenTurn.status, "completed", brokenTurn.error?.message);
assert.deepEqual(brokenCalls.map((call) => call.callId), ["call_fixed"]);
const brokenToolMessage = brokenRequests[1].messages.at(-1);
assert.equal(brokenToolMessage.role, "tool");
assert.equal(brokenToolMessage.tool_call_id, "call_broken");
assert.match(JSON.parse(brokenToolMessage.content).error, /不是有效的 JSON.*重新发起工具调用/);
assert.equal(brokenRequests[1].messages.at(-2).tool_calls[0].function.arguments, "{\"value\":\"oops\"{\"value\":\"oops\"}");
assert.deepEqual(brokenRun.seen.items, ["item/started", "item/completed", "item/started", "item/completed"]);
assert.deepEqual(brokenRun.seen.deltas, ["修好了"]);

// Arguments cut off by the reply budget: retrying would cut off again, so the
// turn fails with the real cause and no tool runs.
const truncatedAnthropicDriver = createDirectAPIDriver({
  profileForId: () => anthropicProfile,
  readSecret: () => "truncated-key",
  fetchImpl: async () => sseResponse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_complete", name: "read" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_cut", name: "remember" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"value\":\"a very long" } },
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 32768 } },
    { type: "message_stop" },
  ]),
}).forProfile(anthropicProfile.profileId);
const truncatedAnthropicRun = runTurn(truncatedAnthropicDriver, rememberTool, async () => { throw new Error("must not run"); });
const truncatedAnthropicTurn = await truncatedAnthropicRun.done;
assert.equal(truncatedAnthropicTurn.status, "failed");
assert.match(truncatedAnthropicTurn.error.message, /remember.*截断.*最大输出 token/);
assert.deepEqual(truncatedAnthropicRun.seen.items, []);

const truncatedOpenAIDriver = createDirectAPIDriver({
  profileForId: () => profile,
  readSecret: () => "truncated-key",
  fetchImpl: async () => sseResponse([
    { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_cut", function: { name: "remember", arguments: "{\"value\":\"a very" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "length" }] },
  ], "data: [DONE]\n\n"),
}).forProfile(profile.profileId);
const truncatedOpenAIRun = runTurn(truncatedOpenAIDriver, rememberTool, async () => { throw new Error("must not run"); });
const truncatedOpenAITurn = await truncatedOpenAIRun.done;
assert.equal(truncatedOpenAITurn.status, "failed");
assert.match(truncatedOpenAITurn.error.message, /截断.*接口方/);
assert.deepEqual(truncatedOpenAIRun.seen.items, []);

// Anthropic non-stream: input is already an object; a non-object input is an
// error handed back to the model rather than a silently emptied call.
const anthropicJSONResponses = [
  { stop_reason: "tool_use", content: [
    { type: "tool_use", id: "tool_obj", name: "remember", input: { value: "plain" } },
    { type: "tool_use", id: "tool_bad", name: "remember", input: ["not", "an", "object"] },
  ] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "好" }] },
];
const anthropicJSONRequests = [];
const anthropicJSONDriver = createDirectAPIDriver({
  profileForId: () => anthropicProfile,
  readSecret: () => "anthropic-json-key",
  fetchImpl: async (_url, init) => { anthropicJSONRequests.push(JSON.parse(init.body)); return jsonResponse(anthropicJSONResponses.shift()); },
}).forProfile(anthropicProfile.profileId);
const anthropicJSONCalls = [];
const anthropicJSONRun = runTurn(anthropicJSONDriver, rememberTool, async (call) => { anthropicJSONCalls.push(call.callId); return { saved: true }; });
const anthropicJSONTurn = await anthropicJSONRun.done;
assert.equal(anthropicJSONTurn.status, "completed", anthropicJSONTurn.error?.message);
assert.deepEqual(anthropicJSONCalls, ["tool_obj"]);
const anthropicResults = anthropicJSONRequests[1].messages.at(-1).content;
assert.equal(anthropicResults[1].tool_use_id, "tool_bad");
assert.equal(anthropicResults[1].is_error, true);
assert.match(JSON.parse(anthropicResults[1].content).error, /JSON object/);

// A model that never produces readable JSON must not spin forever on a
// profile without a tool-round limit: three consecutive unreadable rounds stop
// the turn with the parser's reason, and no tool ever runs.
let stubbornRequestCount = 0;
const stubbornDriver = createDirectAPIDriver({
  profileForId: () => profile,
  readSecret: () => "stubborn-key",
  fetchImpl: async () => {
    stubbornRequestCount += 1;
    return jsonResponse({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
      { id: `call_stubborn_${stubbornRequestCount}`, type: "function", function: { name: "remember", arguments: "{value: nope}" } },
    ] } }] });
  },
}).forProfile(profile.profileId);
const stubbornRun = runTurn(stubbornDriver, rememberTool, async () => { throw new Error("must not run"); });
const stubbornTurn = await stubbornRun.done;
assert.equal(stubbornTurn.status, "failed");
assert.match(stubbornTurn.error.message, /连续 3 轮.*无法读取的工具参数/);
assert.equal(stubbornRequestCount, 3);
assert.equal(stubbornRun.seen.items.length, 4);

// A truncated round must never execute, even before the first argument byte or
// after a syntactically complete argument object. Cover stream and JSON paths.
for (const protocol of ["openai-compatible", "anthropic-messages"]) {
  for (const streaming of [false, true]) {
    for (const value of ["", "{}", '{"value":"complete"}']) {
      let requestCount = 0;
      let executed = 0;
      const selectedProfile = protocol === "anthropic-messages" ? anthropicProfile : profile;
      const blockedDriver = createDirectAPIDriver({
        profileForId: () => selectedProfile,
        readSecret: () => "fixture-key",
        fetchImpl: async () => {
          requestCount += 1;
          assert.equal(requestCount, 1, "truncation must not retry");
          if (protocol === "openai-compatible") {
            const call = { id: "cut", type: "function", function: { name: "remember", arguments: value } };
            return streaming ? sseResponse([
              { choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] },
              { choices: [{ delta: {}, finish_reason: "length" }] },
            ], "data: [DONE]\n\n") : jsonResponse({ choices: [{
              finish_reason: "length", message: { role: "assistant", tool_calls: [call] },
            }] });
          }
          const block = { type: "tool_use", id: "cut", name: "remember", input: value ? JSON.parse(value) : {} };
          return streaming ? sseResponse([
            { type: "content_block_start", index: 0, content_block: { ...block, input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: value } },
            { type: "message_delta", delta: { stop_reason: "max_tokens" } },
            { type: "message_stop" },
          ]) : jsonResponse({ stop_reason: "max_tokens", content: [block] });
        },
      }).forProfile(selectedProfile.profileId);
      const blocked = await runTurn(blockedDriver, rememberTool, async () => { executed += 1; return {}; }).done;
      assert.equal(blocked.status, "failed");
      assert.match(blocked.error.message, /截断/);
      assert.equal(executed, 0, `${protocol} stream=${streaming} arguments=${value}`);
      assert.equal(requestCount, 1);
    }
  }
}

// Non-object values cannot become empty arguments via String([]), String(null),
// or falsey SSE fragment checks. Anthropic replay must itself remain valid.
for (const protocol of ["openai-compatible", "anthropic-messages"]) {
  for (const value of [[], ["wrong"], null, false, 0, "[]", "null"]) {
    const modes = protocol === "openai-compatible" ? [false, true] : [false];
    for (const streaming of modes) {
      let requestCount = 0;
      let executed = 0;
      const selectedProfile = protocol === "anthropic-messages" ? anthropicProfile : profile;
      const invalidDriver = createDirectAPIDriver({
        profileForId: () => selectedProfile,
        readSecret: () => "fixture-key",
        fetchImpl: async (_url, init) => {
          requestCount += 1;
          if (requestCount === 1) {
            if (protocol === "anthropic-messages") return jsonResponse({ stop_reason: "tool_use", content: [
              { type: "text", text: "Preparing" },
              { type: "tool_use", id: "invalid", name: "remember", input: value },
            ] });
            const call = { id: "invalid", type: "function", function: { name: "remember", arguments: value } };
            return streaming ? sseResponse([
              { choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ], "data: [DONE]\n\n") : jsonResponse({ choices: [{ message: { role: "assistant", tool_calls: [call] } }] });
          }
          assert.equal(requestCount, 2);
          const body = JSON.parse(init.body);
          if (protocol === "anthropic-messages") {
            const assistant = body.messages.at(-2).content;
            assert.deepEqual(assistant[0], { type: "text", text: "Preparing" });
            assert.deepEqual(assistant[1], { type: "tool_use", id: "invalid", name: "remember", input: {} });
            const result = body.messages.at(-1).content[0];
            assert.equal(result.tool_use_id, "invalid");
            assert.equal(result.is_error, true);
            return jsonResponse({ content: [{ type: "text", text: "Retry received" }], stop_reason: "end_turn" });
          }
          const result = body.messages.at(-1);
          assert.equal(result.tool_call_id, "invalid");
          assert.match(JSON.parse(result.content).error, /JSON/);
          assert.equal(typeof body.messages.at(-2).tool_calls[0].function.arguments, "string");
          return jsonResponse({ choices: [{ message: { role: "assistant", content: "Retry received" } }] });
        },
      }).forProfile(selectedProfile.profileId);
      const invalid = await runTurn(invalidDriver, rememberTool, async () => { executed += 1; return {}; }).done;
      assert.equal(invalid.status, "completed", invalid.error?.message);
      assert.equal(executed, 0, `${protocol} stream=${streaming} input=${JSON.stringify(value)}`);
      assert.equal(requestCount, 2);
    }
  }
}

console.log("ARU_DIRECT_API_DRIVER_SMOKE_OK");

let noAuthRequest;
const noAuthDriver = createDirectAPIDriver({
  profileForId: () => ({ ...profile, authMode: "none", hasSecret: false }),
  readSecret: () => null,
  fetchImpl: async (_, init) => {
    noAuthRequest = init;
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  },
});
await noAuthDriver.testProfile("provider_test");
assert.equal(noAuthRequest.headers.authorization, undefined);
assert.equal(noAuthRequest.headers["x-api-key"], undefined);
console.log("ARU_DIRECT_API_NO_AUTH_SMOKE_OK");
