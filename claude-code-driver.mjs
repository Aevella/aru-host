import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  CLAUDE_CODE_MCP_SERVER_NAME,
  CLAUDE_CODE_PERMISSION_TOOL,
  claudeCodeAllowedMCPTools,
  createClaudeCodeHostBridge,
} from "./claude-code-host-bridge.mjs";

const MAX_ERROR_BYTES = 32 * 1024;

// npm's Windows .cmd shim cannot be spawned directly. Invoke the package
// entry with Host's Node instead of routing model-controlled arguments through
// cmd.exe. Native installations continue to execute their .exe directly.
export function claudeCodeInvocation(command, args, platform = process.platform, nodeExecutable = process.execPath) {
  if (platform === "win32" && /\.cmd$/i.test(command)) {
    return { command: nodeExecutable, args: [win32.join(win32.dirname(command),
      "node_modules", "@anthropic-ai", "claude-code", "cli.js"), ...args] };
  }
  return { command, args };
}

export function createClaudeCodeDriver({
  executable,
  resolveExecutable,
  nodeExecutable = process.execPath,
  bridgeScript = join(dirname(fileURLToPath(import.meta.url)), "claude-code-mcp-bridge.mjs"),
  spawnProcess = spawn,
  log = () => {},
} = {}) {
  let knownExecutable = executable ?? null;
  const activeTurns = new Map();
  const sessionToolGrants = new Map();

  function status() {
    if (activeTurns.size > 0) return "running";
    return knownExecutable ? "ready" : "unavailable";
  }

  function refreshExecutable() {
    if (typeof resolveExecutable === "function") {
      knownExecutable = resolveExecutable() ?? null;
    }
    return knownExecutable;
  }

  async function ensureConnected() {
    const command = refreshExecutable();
    if (!command) throw new Error("claude executable is unavailable");
  }

  async function startTurn({
    threadId,
    cwd,
    instructions,
    historyContext,
    tools,
    text,
    attachments = [],
    handler,
  }) {
    await ensureConnected();
    validateAttachments(attachments);
    const turnId = `claudeturn_${randomUUID()}`;
    const context = {
      turnId,
      requestedThreadId: threadId ?? null,
      sessionId: threadId ?? null,
      cwd,
      tools,
      handler,
      child: null,
      bridge: null,
      temporaryDirectory: null,
      stderr: "",
      textEmitted: false,
      currentAssistantText: "",
      terminalEventSent: false,
      interrupted: false,
      startedSettled: false,
    };
    activeTurns.set(turnId, context);
    try {
      context.bridge = await createClaudeCodeHostBridge(context, sessionToolGrants);
      context.temporaryDirectory = createTurnFiles({
        nodeExecutable,
        bridgeScript,
        bridgeURL: context.bridge.url,
        bridgeToken: context.bridge.token,
        instructions,
      });
      return await launchClaudeTurn(context, {
        command: knownExecutable,
        threadId,
        prompt: claudeUserPrompt(text, attachments, threadId ? "" : historyContext),
        spawnProcess,
        log,
        activeTurns,
      });
    } catch (error) {
      cleanupTurn(context, activeTurns);
      throw error;
    }
  }

  async function interrupt(_threadId, turnId) {
    const context = activeTurns.get(turnId);
    if (!context) return;
    context.interrupted = true;
    context.child?.kill("SIGTERM");
  }

  return {
    status,
    refreshExecutable,
    ensureConnected,
    startTurn,
    interrupt,
    validateAttachments,
  };
}

function launchClaudeTurn(context, { command, threadId, prompt, spawnProcess, log, activeTurns }) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "default",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", join(context.temporaryDirectory, "mcp.json"),
    "--permission-prompt-tool", `mcp__${CLAUDE_CODE_MCP_SERVER_NAME}__${CLAUDE_CODE_PERMISSION_TOOL}`,
    "--allowedTools", claudeCodeAllowedMCPTools(context.tools).join(","),
    "--disallowedTools", "AskUserQuestion",
    "--append-system-prompt-file", join(context.temporaryDirectory, "instructions.txt"),
  ];
  if (threadId) args.push("--resume", threadId);
  const invocation = claudeCodeInvocation(command, args);
  const child = spawnProcess(invocation.command, invocation.args, {
    cwd: context.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  context.child = child;
  let stdoutBuffer = "";
  let eventQueue = Promise.resolve();
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  const settleStarted = (error = null) => {
    if (context.startedSettled) return;
    context.startedSettled = true;
    if (error) rejectStarted(error);
    else resolveStarted({ threadId: context.sessionId, turnId: context.turnId });
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    while (stdoutBuffer.includes("\n")) {
      const index = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      eventQueue = eventQueue.then(() => handleClaudeLine(context, line, settleStarted));
    }
  });
  child.stderr.on("data", (chunk) => {
    context.stderr = `${context.stderr}${String(chunk)}`.slice(-MAX_ERROR_BYTES);
  });
  child.on("error", (error) => {
    settleStarted(error);
    context.terminalEventSent = true;
    context.handler.onDisconnect?.(error);
  });
  child.on("close", (code, signal) => {
    eventQueue = eventQueue.then(async () => {
      if (stdoutBuffer.trim()) await handleClaudeLine(context, stdoutBuffer, settleStarted);
      if (!context.startedSettled) {
        settleStarted(new Error(claudeExitMessage(context, code, signal)));
      } else if (!context.terminalEventSent && !context.interrupted) {
        context.handler.onNotification?.("turn/completed", {
          threadId: context.sessionId,
          turnId: context.turnId,
          turn: { status: "failed", error: { message: claudeExitMessage(context, code, signal) } },
        });
      }
      cleanupTurn(context, activeTurns);
    }).catch((error) => {
      if (!context.startedSettled) settleStarted(error);
      else context.handler.onDisconnect?.(error);
      cleanupTurn(context, activeTurns);
    });
  });
  child.stdin.end(prompt);
  log("computer collaborator Claude Code turn started");
  return started;
}

async function handleClaudeLine(context, line, settleStarted) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "system" && message.subtype === "init") {
    context.sessionId = String(message.session_id ?? context.sessionId ?? "").trim() || null;
    if (!context.sessionId) throw new Error("Claude Code did not return a session id");
    settleStarted();
    return;
  }
  if (message.type === "stream_event") {
    const event = message.event ?? {};
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const delta = String(event.delta.text ?? "");
      if (!delta) return;
      context.textEmitted = true;
      context.currentAssistantText += delta;
      await context.handler.onNotification?.("item/agentMessage/delta", {
        threadId: context.sessionId,
        turnId: context.turnId,
        delta,
      });
    }
    return;
  }
  if (message.type === "assistant") {
    const text = assistantText(message.message?.content);
    const streamed = context.currentAssistantText;
    const missing = !streamed ? text : (text.startsWith(streamed) ? text.slice(streamed.length) : "");
    context.currentAssistantText = "";
    if (missing) {
      context.textEmitted = true;
      await context.handler.onNotification?.("item/agentMessage/delta", {
        threadId: context.sessionId,
        turnId: context.turnId,
        delta: missing,
      });
    }
    return;
  }
  if (message.type !== "result") return;
  context.sessionId = String(message.session_id ?? context.sessionId ?? "").trim() || context.sessionId;
  if (!context.startedSettled && context.sessionId) settleStarted();
  if (!context.textEmitted && typeof message.result === "string" && message.result) {
    context.textEmitted = true;
    await context.handler.onNotification?.("item/agentMessage/delta", {
      threadId: context.sessionId,
      turnId: context.turnId,
      delta: message.result,
    });
  }
  const succeeded = message.subtype === "success" && message.is_error !== true;
  context.terminalEventSent = true;
  await context.handler.onNotification?.("turn/completed", {
    threadId: context.sessionId,
    turnId: context.turnId,
    turn: succeeded
      ? { status: "completed" }
      : { status: "failed", error: { message: claudeResultMessage(message) } },
  });
}

function createTurnFiles({
  nodeExecutable,
  bridgeScript,
  bridgeURL,
  bridgeToken,
  instructions,
}) {
  const directory = mkdtempSync(join(tmpdir(), "aru-claude-code-"));
  writeFileSync(join(directory, "instructions.txt"), String(instructions ?? ""), { mode: 0o600 });
  writeFileSync(join(directory, "mcp.json"), `${JSON.stringify({
    mcpServers: {
      [CLAUDE_CODE_MCP_SERVER_NAME]: {
        type: "stdio",
        command: nodeExecutable,
        args: [bridgeScript],
        env: {
          ARU_CLAUDE_BRIDGE_URL: bridgeURL,
          ARU_CLAUDE_BRIDGE_TOKEN: bridgeToken,
        },
      },
    },
  })}\n`, { mode: 0o600 });
  return directory;
}

function claudeUserPrompt(text, attachments, historyContext) {
  const sections = [];
  if (historyContext) {
    sections.push([
      "The Claude Code transport session was recreated. The following transcript is the durable Aru Host ledger; continue from it without claiming these messages are new:",
      historyContext,
    ].join("\n\n"));
  }
  if (text) sections.push(text);
  if (attachments.length) {
    sections.push([
      "The user attached these immutable files in this collaborator workspace. Read them from the listed local paths when needed:",
      ...attachments.map((item) => `- ${item.filename} (${item.mimeType}, ${item.byteCount} bytes): ${item.path}`),
    ].join("\n"));
  }
  return sections.join("\n\n") || "Continue.";
}

function assistantText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function validateAttachments(attachments) {
  for (const attachment of attachments) {
    if (!["image", "audio", "file", "video"].includes(attachment.kind)) {
      throw new Error(`Claude Code 不支持这种附件：${attachment.filename}`);
    }
  }
}

function claudeResultMessage(message) {
  if (typeof message.result === "string" && message.result.trim()) return message.result.trim().slice(0, 1_000);
  if (Array.isArray(message.errors) && message.errors.length) {
    return message.errors.map((item) => String(item)).join("; ").slice(0, 1_000);
  }
  return `Claude Code turn failed (${message.subtype ?? "unknown"})`;
}

function claudeExitMessage(context, code, signal) {
  const detail = context.stderr.trim().split("\n").slice(-4).join("\n");
  if (detail) return detail.slice(0, 1_000);
  if (signal) return `Claude Code stopped with signal ${signal}`;
  return `Claude Code exited with code ${code ?? "unknown"}`;
}

function cleanupTurn(context, activeTurns) {
  context.bridge?.server.close();
  if (context.temporaryDirectory) {
    rmSync(context.temporaryDirectory, { recursive: true, force: true });
    context.temporaryDirectory = null;
  }
  activeTurns?.delete(context.turnId);
}
