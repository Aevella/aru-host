import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export const CLAUDE_CODE_PERMISSION_TOOL = "permission_prompt";
export const CLAUDE_CODE_MCP_SERVER_NAME = "aru_host";
const MAX_BRIDGE_REQUEST_BYTES = 4 * 1024 * 1024;

export async function createClaudeCodeHostBridge(context, sessionToolGrants) {
  const token = randomUUID();
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
        sendBridgeJSON(response, 404, { error: "not found" });
        return;
      }
      const body = await readBridgeBody(request);
      if (body.action === "listTools") {
        sendBridgeJSON(response, 200, { tools: bridgeTools(context.tools) });
        return;
      }
      if (body.action === "callTool") {
        const value = body.name === CLAUDE_CODE_PERMISSION_TOOL
          ? await requestPermission(context, body.arguments ?? {}, sessionToolGrants)
          : await requestHostTool(context, body.name, body.arguments ?? {});
        sendBridgeJSON(response, 200, value);
        return;
      }
      sendBridgeJSON(response, 400, { error: "unknown bridge action" });
    } catch (error) {
      sendBridgeJSON(response, 500, { error: String(error?.message ?? error).slice(0, 600) });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    token,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

export function claudeCodeAllowedMCPTools(tools) {
  return [
    ...tools.map((tool) => `mcp__${CLAUDE_CODE_MCP_SERVER_NAME}__${tool.name}`),
    `mcp__${CLAUDE_CODE_MCP_SERVER_NAME}__${CLAUDE_CODE_PERMISSION_TOOL}`,
  ];
}

function bridgeTools(tools) {
  return [
    ...tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: tool.annotations ?? undefined,
    })),
    {
      name: CLAUDE_CODE_PERMISSION_TOOL,
      title: "Aru Host approval",
      description: "Ask the paired Aru client to approve a Claude Code computer action.",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: { type: "string" },
          input: { type: "object" },
          suggestions: { type: "array", items: { type: "object" } },
        },
        required: ["tool_name", "input"],
        additionalProperties: true,
      },
      annotations: { readOnlyHint: false },
    },
  ];
}

async function requestHostTool(context, name, argumentsValue) {
  if (!context.tools.some((tool) => tool.name === name)) {
    return mcpError(`工具 ${name} 不属于这个协作者`);
  }
  try {
    const value = await context.handler.onToolCall({ tool: name, arguments: argumentsValue });
    return normalizeMCPResult(value);
  } catch (error) {
    return mcpError(error?.message ?? "Tool call failed");
  }
}

async function requestPermission(context, value, sessionToolGrants) {
  const toolName = String(value.tool_name ?? "").trim();
  const input = value.input && typeof value.input === "object" && !Array.isArray(value.input)
    ? value.input
    : {};
  const sessionId = context.sessionId ?? context.requestedThreadId ?? context.turnId;
  const grants = sessionToolGrants.get(sessionId) ?? new Set();
  const grantKey = permissionGrantKey(toolName, input);
  if (grants.has(grantKey)) return mcpText({ behavior: "allow", updatedInput: input });
  const response = await new Promise((resolve) => {
    context.handler.onApproval({
      method: approvalMethod(toolName),
      params: approvalParams(toolName, input),
      respond: resolve,
    });
  });
  if (response?.decision === "accept" || response?.decision === "acceptForSession") {
    if (response.decision === "acceptForSession") {
      grants.add(grantKey);
      sessionToolGrants.set(sessionId, grants);
    }
    const updatedPermissions = permissionSuggestions(value);
    return mcpText({
      behavior: "allow",
      updatedInput: input,
      ...(response.decision === "acceptForSession" && updatedPermissions.length
        ? { updatedPermissions }
        : {}),
    });
  }
  return mcpText({
    behavior: "deny",
    message: response?.decision === "cancel" ? "User cancelled this turn" : "User denied this action",
  });
}

function permissionSuggestions(value) {
  const suggestions = value.suggestions ?? value.permission_suggestions;
  return Array.isArray(suggestions)
    ? suggestions.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function permissionGrantKey(toolName, input) {
  return `${toolName}\u0000${stableJSON(input)}`;
}

function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function approvalMethod(toolName) {
  if (toolName === "Bash") return "item/commandExecution/requestApproval";
  if (["Edit", "Write", "NotebookEdit"].includes(toolName)) {
    return "item/fileChange/requestApproval";
  }
  return "item/permissions/requestApproval";
}

function approvalParams(toolName, input) {
  if (toolName === "Bash") {
    return {
      command: input.command ?? null,
      reason: input.description ?? null,
      cwd: null,
    };
  }
  if (["Edit", "Write", "NotebookEdit"].includes(toolName)) {
    return {
      reason: `Claude Code wants to use ${toolName}`,
      cwd: null,
      path: input.file_path ?? input.notebook_path ?? null,
    };
  }
  return {
    reason: `Claude Code wants to use ${toolName}`,
    permissions: { toolName, input },
  };
}

function normalizeMCPResult(value) {
  if (value && typeof value === "object" && Array.isArray(value.content)) return value;
  return mcpText(value);
}

function mcpText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function mcpError(value) {
  return { content: [{ type: "text", text: String(value).slice(0, 2_000) }], isError: true };
}

function sendBridgeJSON(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function readBridgeBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteCount = 0;
    request.on("data", (chunk) => {
      byteCount += chunk.length;
      if (byteCount > MAX_BRIDGE_REQUEST_BYTES) {
        reject(new Error("MCP bridge request is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("MCP bridge request is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}
