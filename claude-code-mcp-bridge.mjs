#!/usr/bin/env node
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
  fetchImpl = fetch,
} = {}) {
  if (!bridgeURL || !bridgeToken) {
    throw new Error("Aru Claude Code MCP bridge configuration is unavailable");
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    try {
      const result = await handleRequest(message, { bridgeURL, bridgeToken, fetchImpl });
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    } catch (error) {
      errorOutput.write(`Aru Claude Code MCP bridge: ${safeMessage(error)}\n`);
      output.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: safeMessage(error) },
      })}\n`);
    }
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

async function parentRequest({ bridgeURL, bridgeToken, fetchImpl }, body) {
  const response = await fetchImpl(bridgeURL, {
    method: "POST",
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
