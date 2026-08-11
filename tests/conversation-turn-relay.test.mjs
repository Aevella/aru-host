import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationTurnRelay } from "../conversation-turn-relay.mjs";

test("durable turn submission is idempotent and never persists provider secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "aru-turn-relay-"));
  const statePath = join(root, "state.json");
  const state = { conversationTurns: [] };
  const responses = [];
  let fetchCount = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    fetchCount += 1;
    assert.equal(request.headers.authorization, "Bearer secret-for-one-request");
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\n'));
        setTimeout(() => {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }, 35);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const relay = createConversationTurnRelay({
      dataDir: root,
      state,
      saveState: () => writeFileSync(statePath, JSON.stringify(state)),
      readJSONBody: async (request) => request.body,
      sendJSON: (_response, status, body) => responses.push({ status, body }),
      HttpError: class HttpError extends Error {
        constructor(status, code, message) {
          super(message); this.status = status; this.code = code;
        }
      },
      maximumRequestBytes: 1024 * 1024,
      log: () => {},
    });
    const device = { deviceId: "device-one" };
    const request = {
      method: "POST",
      body: {
        clientTurnId: "assistant-one",
        conversationId: "conversation-one",
        protocolId: "openai-compatible",
        request: {
          endpoint: "https://provider.example/v1/chat/completions",
          headers: { authorization: "Bearer secret-for-one-request" },
          bodyBase64: Buffer.from('{"stream":true}').toString("base64"),
        },
      },
    };

    await relay.route(request, {}, "/aru/v1/conversation-turns", () => device);
    await relay.route(request, {}, "/aru/v1/conversation-turns", () => device);
    assert.equal(responses[0].status, 202);
    assert.equal(responses[1].body.turnId, responses[0].body.turnId);
    const statusPath = `/aru/v1/conversation-turns/${responses[0].body.turnId}`;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await relay.route({ method: "GET" }, {}, statusPath, () => device);
    assert.equal(responses.at(-1).body.state, "running");
    assert.match(Buffer.from(responses.at(-1).body.resultBase64, "base64").toString(), /好/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fetchCount, 1);
    assert.equal(state.conversationTurns[0].state, "succeeded");
    assert.equal(readFileSync(statePath, "utf8").includes("secret-for-one-request"), false);

    await relay.route({ method: "GET" }, {}, statusPath, () => device);
    assert.match(Buffer.from(responses.at(-1).body.resultBase64, "base64").toString(), /好/);
    await relay.route(
      { method: "POST" }, {}, `${statusPath}/acknowledge`, () => device);
    await relay.route({ method: "GET" }, {}, statusPath, () => device);
    assert.equal(responses.at(-1).body.resultBase64, undefined);
    assert.ok(responses.at(-1).body.acknowledgedAt);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed provider bodies at the device boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "aru-turn-relay-invalid-"));
  const state = { conversationTurns: [] };
  class HttpError extends Error {
    constructor(status, code, message) {
      super(message); this.status = status; this.code = code;
    }
  }
  try {
    const relay = createConversationTurnRelay({
      dataDir: root,
      state,
      saveState: () => {},
      readJSONBody: async (request) => request.body,
      sendJSON: () => {},
      HttpError,
      maximumRequestBytes: 1024,
      log: () => {},
    });
    await assert.rejects(
      relay.route({
        method: "POST",
        body: {
          clientTurnId: "assistant-invalid",
          conversationId: "conversation-invalid",
          protocolId: "openai-compatible",
          request: {
            endpoint: "https://provider.example/v1/chat/completions",
            headers: {},
            bodyBase64: "not-base64!",
          },
        },
      }, {}, "/aru/v1/conversation-turns", () => ({ deviceId: "device-one" })),
      (error) => error instanceof HttpError
        && error.status === 400
        && error.code === "conversation_turn.invalid_request");
    assert.equal(state.conversationTurns.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider failures retain a bounded redacted diagnostic", async () => {
  const root = mkdtempSync(join(tmpdir(), "aru-turn-relay-provider-failure-"));
  const state = { conversationTurns: [] };
  const responses = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: "system messages must be first; key sk-private-token-value-1234567890",
    },
  }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

  try {
    const relay = createConversationTurnRelay({
      dataDir: root,
      state,
      saveState: () => {},
      readJSONBody: async (request) => request.body,
      sendJSON: (_response, status, body) => responses.push({ status, body }),
      HttpError: class HttpError extends Error {},
      maximumRequestBytes: 1024,
      log: () => {},
    });
    const device = { deviceId: "device-one" };
    await relay.route({
      method: "POST",
      body: {
        clientTurnId: "assistant-failure",
        conversationId: "conversation-failure",
        protocolId: "openai-compatible",
        request: {
          endpoint: "https://provider.example/v1/chat/completions",
          headers: {},
          bodyBase64: Buffer.from('{"stream":true}').toString("base64"),
        },
      },
    }, {}, "/aru/v1/conversation-turns", () => device);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.conversationTurns[0].state, "failed");
    assert.match(state.conversationTurns[0].failureMessage, /system messages must be first/);
    assert.match(state.conversationTurns[0].failureMessage, /\[redacted\]/);
    assert.doesNotMatch(state.conversationTurns[0].failureMessage, /private-token/);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
