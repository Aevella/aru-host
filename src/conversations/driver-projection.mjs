import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
function replicaInstructions(replica) {
  return [
    `You are ${replica.displayName}, the phone collaborator whose read-only execution replica is running on Aru Host.`,
    "Speak as this phone collaborator. The phone remains the durable authority for identity, conversations, memory, and rules.",
    "This Host run may produce one proactive reply, but it must never rewrite the phone replica or the independent computer collaborator.",
    String(replica.systemPrompt ?? "").trim(),
    replica.memories?.length ? `Memories:\n${replica.memories.map((item) => `- ${item.content}`).join("\n")}` : "",
    replica.references?.length ? `References:\n${replica.references.map((item) => `## ${item.title}\n${item.content}`).join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

function proactiveReplicaSeed(rule, triggeredAt, replicaGeneratedAt) {
  const clock = {
    triggered_at: isoTimestamp(triggeredAt),
    triggered_at_unix_ms: triggeredAt,
    time_zone: String(rule.scheduleTimeZoneIdentifier ?? "UTC"),
    replica_generated_at: isoTimestamp(replicaGeneratedAt),
    replica_generated_at_unix_ms: replicaGeneratedAt,
  };
  return [
    `<runtime_clock>${JSON.stringify(clock)}</runtime_clock>`,
    "This is a scheduled proactive turn. Decide what is genuinely worth saying now and reply directly to the user.",
    rule.title ? `Rule: ${rule.title}` : "",
    rule.goal ? `Goal: ${rule.goal}` : "",
    rule.instructions ? `Instructions: ${rule.instructions}` : "",
  ].filter(Boolean).join("\n");
}

function messageContentWithTime(message, content = message.content) {
  const metadata = {
    sent_at: isoTimestamp(message.createdAt),
    sent_at_unix_ms: Number(message.createdAt),
    updated_at: isoTimestamp(message.updatedAt),
    updated_at_unix_ms: Number(message.updatedAt),
  };
  return `<message_meta>${JSON.stringify(metadata)}</message_meta>\n${String(content ?? "")}`;
}

function historyRoleLabel(role) {
  return ({ user: "User", assistant: "Assistant", system: "System", tool: "Tool" })[role]
    ?? "Unknown";
}

function isoTimestamp(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  return new Date(milliseconds).toISOString();
}

function validatedReplicaRole(value) {
  const role = String(value ?? "").trim();
  return ["user", "assistant", "system", "tool"].includes(role) ? role : "user";
}

function dynamicTool(tool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    inputSchema: tool.inputSchema ?? { type: "object" },
  };
}

function driverConfigurationFingerprint(collaborator, tools, cognitionRevision) {
  return JSON.stringify({
    driverId: collaborator.driverId,
    providerProfileId: collaborator.providerProfileId ?? null,
    collaboratorRevision: collaborator.revision,
    cognitionRevision,
    tools: tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema ?? null })),
  });
}

function collaboratorInstructions(collaborator) {
  return [
    `You are ${collaborator.displayName}, a computer-hosted collaborator inside Aru.`,
    "This computer is the durable authority for your conversations. The phone is only a synchronized client.",
    "Work inside the provided managed workspace. Use Aru tools for product data and user-visible actions.",
    "Your collaborator surface tools are already bound to your own pages. Never ask for, guess, or send a collaborator id when using them.",
    "For substantial phone interfaces, keep a normal multi-file web project in this workspace, build it, then publish the build directory with aru_collaborator_surface_publish_project. Use the inline surface tool only for genuinely small single-file pages.",
    "Never ask the user to configure sockets, copy credentials, or edit MCP JSON for this connection.",
  ].join("\n");
}

function driverApprovalKind(method) {
  if (method.includes("commandExecution")) return "command";
  if (method.includes("fileChange")) return "fileChange";
  return "permissions";
}

function driverApprovalTitle(method) {
  if (method.includes("commandExecution")) return "允许在电脑上运行命令？";
  if (method.includes("fileChange")) return "允许修改电脑工作区文件？";
  return "允许扩大这次回合的访问范围？";
}

function publicApprovalDetail(method, params) {
  if (method.includes("commandExecution")) {
    return {
      command: params.command ?? null,
      reason: params.reason ?? null,
      cwd: params.cwd ?? null,
    };
  }
  if (method.includes("fileChange")) {
    return { reason: params.reason ?? null, cwd: params.cwd ?? null };
  }
  return { reason: params.reason ?? null, permissions: params.permissions ?? {} };
}

function driverApprovalResponse(method, params, decision) {
  if (method.includes("permissions")) {
    const allowed = decision === "allowOnce" || decision === "allowSession";
    return {
      permissions: allowed ? params.permissions : {},
      scope: decision === "allowSession" ? "session" : "turn",
    };
  }
  const value = {
    allowOnce: "accept",
    allowSession: "acceptForSession",
    deny: "decline",
    cancel: "cancel",
  }[decision];
  return { decision: value };
}

function publicDriverItem(item, workspace) {
  const value = {
    id: item.id ?? null,
    type: item.type ?? "unknown",
    status: item.status ?? null,
  };
  if (item.type === "commandExecution") {
    value.command = String(item.command ?? "").slice(0, 600) || null;
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.map((part) => String(part ?? "").trim()).filter(Boolean)
      : [];
    value.summary = summary.join("\n") || null;
  }
  if (item.type === "mcpToolCall") {
    value.server = String(item.server ?? "").trim() || null;
    value.tool = String(item.tool ?? "").trim() || null;
  }
  if (item.type === "dynamicToolCall") value.tool = item.tool ?? null;
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    value.paths = changes
      .map((change) => change?.path ?? change?.filePath ?? null)
      .filter(Boolean)
      .map((path) => publicWorkspacePath(path, workspace));
  }
  return value;
}

function publicWorkspacePath(value, workspace) {
  const path = String(value ?? "");
  if (!path) return "";
  if (!isAbsolute(path)) return path.replaceAll("\\", "/");
  const difference = relative(resolve(workspace), resolve(path));
  if (difference && difference !== ".." && !difference.startsWith("../")) {
    return difference.replaceAll("\\", "/");
  }
  return basename(path);
}


export { replicaInstructions, proactiveReplicaSeed, messageContentWithTime, historyRoleLabel, isoTimestamp, validatedReplicaRole, dynamicTool, driverConfigurationFingerprint, collaboratorInstructions, driverApprovalKind, driverApprovalTitle, publicApprovalDetail, driverApprovalResponse, publicDriverItem, publicWorkspacePath };
