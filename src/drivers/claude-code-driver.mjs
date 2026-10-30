import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  CLAUDE_CODE_MCP_SERVER_NAME,
  CLAUDE_CODE_PERMISSION_TOOL,
  claudeCodeAllowedMCPTools,
  createClaudeCodeHostBridge,
} from "./claude-code-host-bridge.mjs";

// `command` is a bare executable path or the launch spec from
// collaborator-host's driverLaunchSpec (an npm shim on Windows resolves to
// `node <entry.js>`). Claude arguments carry session ids and file paths, so a
// launch that would route them through cmd.exe is refused rather than quoted.
export function claudeCodeLaunch(command, args) {
  const launch = typeof command === "string"
    ? { file: command, args: [], shell: false }
    : command;
  if (launch?.shell === true || typeof launch?.file !== "string") {
    throw new Error("claude executable cannot be launched without a shell");
  }
  return { command: launch.file, args: [...(launch.args ?? []), ...args] };
}

export function createClaudeCodeDriver({
  executable,
  resolveExecutable,
  nodeExecutable = process.execPath,
  bridgeScript = join(dirname(fileURLToPath(import.meta.url)), "claude-code-mcp-bridge.mjs"),
  spawnProcess = spawn,
  // Idle processes hold memory and a local bridge. Releasing them does not
  // delete their Claude session; the next message resumes its durable id.
  idleTimeoutMs = 30 * 60 * 1_000,
  startupTimeoutMs = 120_000,
  log = () => {},
} = {}) {
  let knownExecutable = executable ?? null;
  let disposed = false;
  const activeTurns = new Map();
  const sessions = new Map();
  const reservations = new Set();
  const sessionToolGrants = new Map();

  function status() {
    if (activeTurns.size > 0) return "running";
    return knownExecutable && !disposed ? "ready" : "unavailable";
  }
  function refreshExecutable() {
    if (typeof resolveExecutable === "function") knownExecutable = resolveExecutable() ?? null;
    return knownExecutable;
  }
  async function ensureConnected() {
    if (disposed) throw new Error("Claude Code driver is closed");
    if (!refreshExecutable()) throw new Error("claude executable is unavailable");
  }
  function releaseTurn(session, turn) {
    activeTurns.delete(turn.turnId);
    turn.signal?.removeEventListener("abort", turn.onAbort);
    if (session.transport?.turn === turn) session.transport.turn = null;
    turn.closed = true;
    turn.lifetime.abort();
    if (!session.retired && !session.transport?.closed) {
      session.idleTimer = setTimeout(() => { void retire(session); }, idleTimeoutMs);
      session.idleTimer.unref?.();
    }
  }
  async function retire(session) {
    session.retired = true;
    clearTimeout(session.idleTimer);
    if (session.transport) await session.transport.stop();
    if (sessions.get(session.id) === session) sessions.delete(session.id);
    session.bridge?.server.close();
    if (session.directory) {
      rmSync(session.directory, { recursive: true, force: true });
      session.directory = null;
    }
  }
  async function startTurn({ threadId, cwd, instructions, historyContext, tools, text,
    attachments = [], handler, signal }) {
    const id = threadId || randomUUID();
    if (reservations.has(id) || sessions.get(id)?.transport?.turn) {
      throw new Error("Claude Code session already has an active turn");
    }
    reservations.add(id);
    let session;
    let turn;
    try {
      await ensureConnected();
      signal?.throwIfAborted();
      validateAttachments(attachments);
      const fingerprint = JSON.stringify([knownExecutable, cwd, instructions ?? "", tools]);
      session = sessions.get(id);
      if (session && (session.fingerprint !== fingerprint || session.transport.closed)) {
        await retire(session);
        sessionToolGrants.delete(id);
        session = null;
      }
      signal?.throwIfAborted();
      if (!session) {
        session = { id, fingerprint, tools, retired: false, transport: null, bridge: null, directory: null };
        sessions.set(id, session);
      }
      clearTimeout(session.idleTimer);
      let resolveStarted;
      let rejectStarted;
      const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
      // A setup failure can precede returning this promise to the caller.
      started.catch(() => {});
      const lifetime = new AbortController();
      turn = {
        lifetime, lifetimeSignal: lifetime.signal,
        turnId: `claudeturn_${randomUUID()}`, requestedThreadId: threadId ?? null,
        sessionId: id, tools, handler, signal, textEmitted: false,
        currentAssistantText: "", terminalEventSent: false, interrupted: false,
        startedSettled: false, closed: false,
        settleStarted(error = null) {
          if (turn.startedSettled) return;
          turn.startedSettled = true;
          clearTimeout(turn.startupTimer);
          if (error) rejectStarted(error);
          else resolveStarted({ threadId: id, turnId: turn.turnId });
        },
        fail(error) {
          if (turn.closed || turn.terminalEventSent) return;
          turn.settleStarted(error);
          turn.terminalEventSent = true;
          releaseTurn(session, turn);
          handler.onDisconnect?.(error);
        },
      };
      turn.startupTimer = setTimeout(() => {
        turn.fail(new Error("Claude Code session initialization timed out"));
        void retire(session);
      }, startupTimeoutMs);
      turn.startupTimer.unref?.();
      activeTurns.set(turn.turnId, { session, turn });
      turn.onAbort = () => { void interrupt(id, turn.turnId); };
      signal?.addEventListener("abort", turn.onAbort, { once: true });
      if (!session.transport) {
        session.bridge = await createClaudeCodeHostBridge(() => session.transport?.turn ?? null, sessionToolGrants);
        signal?.throwIfAborted();
        if (session.retired || turn.interrupted) throw new Error("Claude Code turn cancelled");
        session.directory = createTurnFiles({ nodeExecutable, bridgeScript,
          bridgeURL: session.bridge.url, bridgeToken: session.bridge.token, instructions });
        const args = [
          "-p", "--input-format", "stream-json", "--output-format", "stream-json",
          "--verbose", "--include-partial-messages", "--permission-mode", "default",
          "--setting-sources", "", "--strict-mcp-config",
          "--mcp-config", join(session.directory, "mcp.json"),
          "--permission-prompt-tool", `mcp__${CLAUDE_CODE_MCP_SERVER_NAME}__${CLAUDE_CODE_PERMISSION_TOOL}`,
          "--allowedTools", claudeCodeAllowedMCPTools(tools).join(","),
          "--disallowedTools", "AskUserQuestion",
          "--append-system-prompt-file", join(session.directory, "instructions.txt"),
          ...(threadId ? ["--resume", threadId] : ["--session-id", id]),
        ];
        session.transport = createClaudeCodeSession({
          invocation: claudeCodeLaunch(knownExecutable, args), cwd, spawnProcess,
          async onLine(captured, line) {
            if (!captured || captured.closed || captured.interrupted || session.retired) return;
            await handleClaudeLine(captured, line, captured.settleStarted, () => releaseTurn(session, captured));
          },
          async onClose(captured, code, stopSignal, stderr) {
            session.retired = true;
            clearTimeout(session.idleTimer);
            if (sessions.get(id) === session) sessions.delete(id);
            if (captured && !captured.closed) {
              captured.settleStarted(new Error(claudeExitMessage({ stderr }, code, stopSignal)));
              releaseTurn(session, captured);
              if (!captured.terminalEventSent && !captured.interrupted) {
                captured.terminalEventSent = true;
                await captured.handler.onNotification?.("turn/completed", {
                  threadId: id, turnId: captured.turnId,
                  turn: { status: "failed", error: { message: claudeExitMessage({ stderr }, code, stopSignal) } },
                });
              }
            }
            session.bridge?.server.close();
            if (session.directory) rmSync(session.directory, { recursive: true, force: true });
            session.directory = null;
          },
        });
      }
      signal?.throwIfAborted();
      if (session.retired || turn.interrupted) throw new Error("Claude Code turn cancelled");
      session.transport.turn = turn;
      session.transport.send(claudeUserPrompt(text, attachments, threadId ? "" : historyContext), id);
      // A resident process emits init only once. Its session identity is already
      // confirmed; this turn is admitted after writing its message to stdin.
      if (session.initialized) turn.settleStarted();
      log("computer collaborator Claude Code turn started");
      const result = await started;
      session.initialized = true;
      return result;
    } catch (error) {
      if (turn) {
        turn.settleStarted(error);
        releaseTurn(session, turn);
      }
      if (session) await retire(session);
      throw error;
    } finally {
      reservations.delete(id);
    }
  }
  async function interrupt(threadId, turnId) {
    const active = activeTurns.get(turnId);
    if (!active || active.session.id !== threadId) return;
    active.turn.interrupted = true;
    active.turn.settleStarted(new Error("Claude Code turn cancelled"));
    await retire(active.session);
    releaseTurn(active.session, active.turn);
  }
  async function dispose() {
    disposed = true;
    process.removeListener("exit", onExit);
    await Promise.all([...sessions.values()].map(async (session) => {
      const turn = session.transport?.turn;
      if (turn) {
        turn.interrupted = true;
        turn.settleStarted(new Error("Claude Code driver closed"));
      }
      await retire(session);
    }));
    sessionToolGrants.clear();
  }
  function onExit() {
    for (const session of sessions.values()) {
      session.transport?.child.kill("SIGTERM");
      if (session.directory) rmSync(session.directory, { recursive: true, force: true });
    }
  }
  process.once("exit", onExit);
  return { status, refreshExecutable, ensureConnected, startTurn, interrupt, validateAttachments, dispose };
}

async function handleClaudeLine(context, line, settleStarted, complete) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "system" && message.subtype === "init") {
    if (message.session_id !== context.sessionId) throw new Error("Claude Code returned a different session id");
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
  if (message.session_id && message.session_id !== context.sessionId) throw new Error("Claude Code returned a different session id");
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
  complete();
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



// One subprocess owns one Claude transport session. The driver owns turn
// admission; callbacks always retain the turn captured when a frame arrived.
function createClaudeCodeSession({ invocation, cwd, spawnProcess = spawn, onLine, onClose }) {
  const child = spawnProcess(invocation.command, invocation.args, {
    cwd,
    env: { ...process.env, NO_COLOR: "1", CLAUDE_CODE_AUTO_CONNECT_IDE: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  let queue = Promise.resolve();
  let stderr = "";
  let closed = false;
  let stopping = false;
  let killTimer;
  let resolveClosed;
  const finished = new Promise((resolve) => { resolveClosed = resolve; });
  const session = {
    child,
    turn: null,
    get closed() { return closed || stopping; },
    get stderr() { return stderr; },
    send(text, sessionId) {
      if (closed || stopping) throw new Error("Claude Code session is closed");
      stderr = "";
      child.stdin.write(`${JSON.stringify({ type: "user", session_id: sessionId,
        message: { role: "user", content: text }, parent_tool_use_id: null })}\n`);
    },
    stop() {
      if (!closed && !stopping) {
        stopping = true;
        child.kill("SIGTERM");
        // Cancellation is confirmed by close, not by kill's return value.
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        killTimer.unref?.();
      }
      return finished;
    },
  };
  function enqueue(line) {
    const turn = session.turn;
    queue = queue.then(() => onLine(turn, line)).catch((error) => {
      turn?.fail(error);
      void session.stop();
    });
  }
  child.stdout.setEncoding?.("utf8");
  child.stderr.setEncoding?.("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      enqueue(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-32 * 1024); });
  const fail = (error) => {
    session.turn?.fail(error);
    void session.stop();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("close", (code, signal) => {
    closed = true;
    clearTimeout(killTimer);
    if (buffer.trim()) enqueue(buffer);
    queue.finally(async () => {
      try { await onClose(session.turn, code, signal, stderr); }
      finally { resolveClosed(); }
    }).catch(() => {});
  });
  return session;
}
