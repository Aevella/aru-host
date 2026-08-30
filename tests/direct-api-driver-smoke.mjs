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
console.log("ARU_DIRECT_API_DRIVER_SMOKE_OK");
