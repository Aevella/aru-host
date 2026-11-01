#!/usr/bin/env node
import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

export async function runClaudeCodeMCPBridge({
  bridgeURL = process.env.ARU_CLAUDE_BRIDGE_URL,
  bridgeToken = process.env.ARU_CLAUDE_BRIDGE_TOKEN,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  fetchImpl = localBridgeRequest,
} = {}) {
  if (!bridgeURL || !bridgeToken) {
    throw new Error("Aru Claude Code MCP bridge configuration is unavailable");
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Map();
  const lifetime = new AbortController();
  const close = () => {
    lifetime.abort();
    for (const { controller } of pending.values()) controller.abort();
  };
  lines.once("close", close);
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === "notifications/cancelled") {
        pending.get(message.params?.requestId)?.controller.abort();
        continue;
      }
      if (message.id === undefined) continue;
      const controller = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      const task = (async () => {
        try {
          const result = await handleRequest(message, { bridgeURL, bridgeToken, fetchImpl, signal });
          if (!signal.aborted) output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        } catch (error) {
          if (signal.aborted) return;
          const detail = `Aru Host bridge request failed: ${safeMessage(error)}`;
          errorOutput.write(`${detail}\n`);
          output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id,
            error: { code: -32603, message: detail } })}\n`);
        }
      })();
      pending.set(message.id, { controller, task });
      void task.finally(() => {
        if (pending.get(message.id)?.task === task) pending.delete(message.id);
      });
    }
  } finally {
    close();
    await Promise.all([...pending.values()].map(({ task }) => task));
  }
}

async function handleRequest(message, context) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "aru-host", version: "1" },
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") {
    return parentRequest(context, { action: "listTools" });
  }
  if (message.method === "tools/call") {
    return parentRequest(context, {
      action: "callTool",
      name: message.params?.name,
      arguments: message.params?.arguments ?? {},
    });
  }
  throw new Error(`Unsupported MCP request: ${message.method}`);
}

async function parentRequest({ bridgeURL, bridgeToken, fetchImpl, signal }, body) {
  const response = await fetchImpl(bridgeURL, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Aru Host returned an invalid MCP bridge response");
  }
  if (!response.ok) throw new Error(value?.error ?? "Aru Host rejected the MCP bridge request");
  return value;
}

// This authenticated loopback request may wait for a human approval. Its lifetime
// is owned by MCP cancellation/stdio close and the originating Host turn, not
// fetch's implicit response-header deadline. Never retry an uncertain tool call.
function localBridgeRequest(url, { headers, body, signal }) {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    throw new Error("Expected a local Aru Host bridge");
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { method: "POST", headers, signal, agent: false }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        text: async () => Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function safeMessage(error) {
  return String(error?.message ?? error ?? "MCP bridge failed").slice(0, 600);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runClaudeCodeMCPBridge().catch((error) => {
    process.stderr.write(`${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}
