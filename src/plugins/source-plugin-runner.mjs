#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const RESULT_PREFIX = "ARU_SOURCE_PLUGIN_RESULT_JSON=";

try {
  const entryPath = process.argv[2];
  if (!entryPath) throw new Error("plugin entry path is required");
  const request = JSON.parse(await readStdin());
  const plugin = await import(`${pathToFileURL(entryPath).href}?aru=${Date.now()}`);
  const tools = validateTools(plugin.tools);

  if (request.action === "catalog") {
    emit({ ok: true, tools });
  } else if (request.action === "call") {
    if (typeof plugin.callTool !== "function") {
      throw new Error("plugin must export async function callTool(name, arguments, context)");
    }
    const tool = tools.find((candidate) => candidate.name === request.toolName);
    if (!tool) throw new Error(`unknown plugin tool: ${request.toolName}`);
    const value = await plugin.callTool(request.toolName, request.arguments ?? {}, {
      dataDirectory: request.dataDirectory ?? null,
    });
    emit({ ok: true, value: value ?? null });
  } else {
    throw new Error("unsupported plugin runner action");
  }
} catch (error) {
  emit({ ok: false, error: String(error?.message ?? error) });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function validateTools(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("plugin must export a non-empty tools array");
  }
  const names = new Set();
  return value.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      throw new Error("each plugin tool must be an object");
    }
    if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(tool.name)) {
      throw new Error("plugin tool names must use lowercase letters, numbers, _ or -");
    }
    if (names.has(tool.name)) throw new Error(`duplicate plugin tool: ${tool.name}`);
    names.add(tool.name);
    if (typeof tool.description !== "string" || tool.description.trim() === "") {
      throw new Error(`plugin tool ${tool.name} needs a description`);
    }
    const inputSchema = tool.inputSchema ?? { type: "object", properties: {} };
    if (inputSchema?.type !== "object" || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
      throw new Error(`plugin tool ${tool.name} inputSchema must be an object schema`);
    }
    return {
      name: tool.name,
      title: typeof tool.title === "string" && tool.title.trim() ? tool.title.trim() : tool.name,
      description: tool.description.trim(),
      inputSchema: { ...inputSchema, additionalProperties: inputSchema.additionalProperties ?? false },
    };
  });
}

function emit(value) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(value)}\n`);
}
