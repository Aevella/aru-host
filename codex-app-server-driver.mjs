import { spawn } from "node:child_process";

const INITIALIZE_CLIENT = {
  name: "aru_host",
  title: "Aru Host",
  version: "1",
};

export function createCodexAppServerDriver({ executable, resolveExecutable, log = () => {} }) {
  let process = null;
  let socket = null;
  let connecting = null;
  let requestSequence = 0;
  const pendingRequests = new Map();
  const threadHandlers = new Map();

  function status() {
    if (socket?.readyState === WebSocket.OPEN) return "running";
    if (connecting) return "starting";
    return executablePath() ? "ready" : "unavailable";
  }

  async function ensureConnected() {
    if (socket?.readyState === WebSocket.OPEN) return;
    const command = executablePath();
    if (!command) throw new Error("codex executable is unavailable");
    if (typeof WebSocket !== "function") {
      throw new Error("Aru Host requires Node.js with WebSocket support");
    }
    if (connecting) return connecting;
    connecting = connect(command);
    try {
      await connecting;
    } finally {
      connecting = null;
    }
  }

  async function connect(command) {
    process = spawn(command, [
      "app-server",
      "-c",
      "project_doc_max_bytes=0",
      "--listen",
      "ws://127.0.0.1:0",
    ], {
      env: { ...globalThis.process.env, NO_COLOR: "1" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const url = await listeningURL(process);
    socket = await openSocket(url);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", () => handleDisconnect("Codex connection closed"));
    socket.addEventListener("error", () => handleDisconnect("Codex connection failed"));
    await request("initialize", {
      clientInfo: INITIALIZE_CLIENT,
      capabilities: { experimentalApi: true },
    });
    notify("initialized", {});
    log("computer collaborator Codex driver ready");
  }

  async function startTurn({
    threadId,
    cwd,
    instructions,
    historyContext,
    tools,
    text,
    userMessageId,
    handler,
  }) {
    await ensureConnected();
    let resolvedThreadId = threadId;
    if (resolvedThreadId) {
      try {
        await request("thread/resume", {
          threadId: resolvedThreadId,
          cwd,
          baseInstructions: instructions,
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        });
      } catch {
        resolvedThreadId = null;
      }
    }
    if (!resolvedThreadId) {
      const started = await request("thread/start", {
        cwd,
        runtimeWorkspaceRoots: [cwd],
        baseInstructions: newThreadInstructions(instructions, historyContext),
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        dynamicTools: tools,
        ephemeral: false,
      });
      resolvedThreadId = started.thread.id;
    }
    threadHandlers.set(resolvedThreadId, handler);
    const startedTurn = await request("turn/start", {
      threadId: resolvedThreadId,
      input: [{ type: "text", text }],
      clientUserMessageId: userMessageId,
    });
    return { threadId: resolvedThreadId, turnId: startedTurn.turn.id };
  }

  async function interrupt(threadId, turnId) {
    await ensureConnected();
    await request("turn/interrupt", { threadId, turnId });
  }

  function request(method, params) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex connection is not open"));
    }
    const id = ++requestSequence;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function notify(method, params) {
    socket.send(JSON.stringify({ method, params }));
  }

  async function handleMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : await event.data.text());
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"));
      else pending.resolve(message.result);
      return;
    }
    const handler = threadHandlers.get(message.params?.threadId);
    if (!handler) return;
    if (message.id !== undefined) {
      await handleServerRequest(message, handler);
      return;
    }
    await handler.onNotification?.(message.method, message.params ?? {});
    if (message.method === "turn/completed") {
      threadHandlers.delete(message.params.threadId);
    }
  }

  async function handleServerRequest(message, handler) {
    const respond = (result) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: message.id, result }));
      }
    };
    if (message.method === "item/tool/call") {
      try {
        const result = await handler.onToolCall(message.params);
        respond({
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
        });
      } catch (error) {
        respond({
          success: false,
          contentItems: [{ type: "inputText", text: error?.message ?? "Tool call failed" }],
        });
      }
      return;
    }
    if ([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ].includes(message.method)) {
      await handler.onApproval({
        method: message.method,
        params: message.params,
        respond,
      });
      return;
    }
    socket.send(JSON.stringify({
      id: message.id,
      error: { code: -32601, message: `Unsupported Codex request: ${message.method}` },
    }));
  }

  function handleDisconnect(reason) {
    if (!socket && !process) return;
    socket = null;
    process = null;
    const error = new Error(reason);
    for (const pending of pendingRequests.values()) pending.reject(error);
    pendingRequests.clear();
    for (const handler of threadHandlers.values()) handler.onDisconnect?.(error);
    threadHandlers.clear();
  }

  function executablePath() {
    return typeof resolveExecutable === "function" ? resolveExecutable() : executable;
  }

  return { status, ensureConnected, startTurn, interrupt };
}

function newThreadInstructions(instructions, historyContext) {
  if (!historyContext) return instructions;
  return [
    instructions,
    "The Codex transport thread was recreated. The following transcript is the durable Aru Host ledger; continue from it without claiming these messages are new:",
    historyContext,
  ].join("\n\n");
}

function listeningURL(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = /listening on:\s*(ws:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
      if (!match) {
        if (buffer.length > 16_384) buffer = buffer.slice(-8_192);
        return;
      }
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      resolve(match[1]);
    };
    const onExit = () => {
      child.stderr.off("data", onData);
      reject(new Error("Codex app-server stopped before it became ready"));
    };
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", reject);
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const value = new WebSocket(url);
    value.addEventListener("open", () => resolve(value), { once: true });
    value.addEventListener("error", () => reject(new Error("Could not connect to Codex app-server")), {
      once: true,
    });
  });
}
