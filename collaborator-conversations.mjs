import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const CONVERSATION_SCHEMA = "aru.selfhost.collaborator-conversation.v1";
const INVENTORY_SCHEMA = "aru.selfhost.collaborator-conversation-inventory.v1";
const EVENTS_SCHEMA = "aru.selfhost.collaborator-conversation-events.v1";
const ID = /^[A-Za-z0-9_-]+$/;
const ACTIVE_STATES = new Set([
  "queued", "starting", "streaming", "waitingApproval", "toolRunning",
]);

export function createCollaboratorConversationHost({
  dataDir,
  driverForCollaborator,
  collaboratorForId,
  readJSONBody,
  sendJSON,
  HttpError,
  toolCatalog,
  executeTool,
  requestInstructions = collaboratorInstructions,
  configurationRevision = () => null,
  onTurnSettled = () => {},
  now = Date.now,
  defer = setImmediate,
}) {
  const root = join(dataDir, "collaborator-conversations");
  const workspaceRoot = join(dataDir, "collaborator-workspaces");
  const pendingApprovals = new Map();
  const activeConversations = new Map();
  const activeDrivers = new Map();
  const sessionToolGrants = new Map();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  recoverInterruptedConversations();

  async function route(req, res, path, requireDevice) {
    const rootMatch = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/conversations$/,
    );
    if (rootMatch) {
      const collaborator = collaboratorForId(rootMatch[1]);
      const device = requireDevice();
      if (req.method === "GET") {
        sendJSON(res, 200, inventory(collaborator.collaboratorId));
        return true;
      }
      if (req.method === "POST") {
        const body = await readJSONBody(req, 64 * 1024);
        sendJSON(res, 201, clientInput(() => createConversation(collaborator, body, device)));
        return true;
      }
      return false;
    }

    const match = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/conversations\/([^/]+)(.*)$/,
    );
    if (!match) return false;
    const collaborator = collaboratorForId(match[1]);
    const conversationId = clientInput(() => validatedId(match[2], "conversation"));
    const suffix = match[3] || "";
    const device = requireDevice();
    const conversation = loadConversation(collaborator.collaboratorId, conversationId);

    if (!suffix && req.method === "GET") {
      sendJSON(res, 200, publicConversation(conversation, true));
      return true;
    }
    if (suffix === "/events" && req.method === "GET") {
      const after = eventCursor(req.url);
      sendJSON(res, 200, {
        schema: EVENTS_SCHEMA,
        collaboratorId: collaborator.collaboratorId,
        conversationId,
        cursor: conversation.events.at(-1)?.sequence ?? 0,
        events: conversation.events.filter((event) => event.sequence > after),
      });
      return true;
    }
    if (suffix === "/messages" && req.method === "POST") {
      const body = await readJSONBody(req, 256 * 1024);
      sendJSON(res, 202, clientInput(() => enqueueMessage(conversation, collaborator, body, device)));
      return true;
    }
    const approvalMatch = suffix.match(/^\/approvals\/([^/]+)$/);
    if (approvalMatch && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, clientInput(() => resolveApproval(
        conversation,
        validatedId(approvalMatch[1], "approval"),
        body,
        device,
      )));
      return true;
    }
    const cancelMatch = suffix.match(/^\/turns\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      sendJSON(res, 202, await cancelTurn(
        conversation,
        clientInput(() => validatedId(cancelMatch[1], "turn")),
        device,
      ));
      return true;
    }
    return false;
  }

  function clientInput(operation) {
    try {
      return operation();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "conversation.input_invalid", error.message ?? "invalid conversation input");
    }
  }

  function inventory(collaboratorId) {
    return {
      schema: INVENTORY_SCHEMA,
      collaboratorId,
      conversations: loadConversations(collaboratorId)
        .map((conversation) => publicConversation(conversation, false))
        .sort((left, right) => right.updatedAt - left.updatedAt || left.conversationId.localeCompare(right.conversationId)),
    };
  }

  function createConversation(collaborator, body, device) {
    const timestamp = now();
    const title = validatedOptionalTitle(body?.title) ?? "新对话";
    const conversation = {
      schema: CONVERSATION_SCHEMA,
      conversationId: `hostconv_${randomUUID()}`,
      collaboratorId: collaborator.collaboratorId,
      title,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      driverThreadId: null,
      driverConfigurationFingerprint: null,
      nextSequence: 1,
      messages: [],
      events: [],
      approvals: [],
      activeTurn: null,
      createdByDeviceId: device.deviceId,
      updatedByDeviceId: device.deviceId,
    };
    saveConversation(conversation);
    return publicConversation(conversation, true);
  }

  function enqueueMessage(conversation, collaborator, body, device, options = {}) {
    if (conversation.archivedAt) {
      throw new HttpError(409, "conversation.archived", "archived conversation cannot accept messages");
    }
    if (conversation.activeTurn && ACTIVE_STATES.has(conversation.activeTurn.state)) {
      throw new HttpError(409, "conversation.turn_active", "this conversation already has an active turn");
    }
    const text = validatedMessage(body?.text);
    const clientRequestId = validatedClientRequestId(body?.clientRequestId);
    const existing = conversation.messages.find((message) => message.clientRequestId === clientRequestId);
    if (existing) return publicConversation(conversation, true);

    const timestamp = now();
    const userMessage = {
      messageId: `hostmsg_${randomUUID()}`,
      clientRequestId,
      role: options.role ?? "user",
      content: text,
      status: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const assistantMessage = {
      messageId: `hostmsg_${randomUUID()}`,
      clientRequestId: null,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const turn = {
      turnId: `hostturn_${randomUUID()}`,
      driverTurnId: null,
      state: "queued",
      userMessageId: userMessage.messageId,
      assistantMessageId: assistantMessage.messageId,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      failure: null,
      cancelledByDeviceId: null,
      source: options.source ?? "client",
      ruleId: options.ruleId ?? null,
    };
    conversation.messages.push(userMessage, assistantMessage);
    conversation.activeTurn = turn;
    if (conversation.title === "新对话") conversation.title = messageTitle(text);
    touch(conversation, device.deviceId);
    appendEvent(conversation, "message.accepted", {
      turnId: turn.turnId,
      userMessageId: userMessage.messageId,
      assistantMessageId: assistantMessage.messageId,
    });
    saveConversation(conversation);
    defer(() => runTurn(conversation.collaboratorId, conversation.conversationId, collaborator));
    return publicConversation(conversation, true);
  }

  function runProactive(collaborator, rule) {
    const device = { deviceId: "host-scheduler" };
    let conversation = null;
    if (rule.conversationId) {
      try { conversation = loadConversation(collaborator.collaboratorId, rule.conversationId); }
      catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
    if (!conversation) {
      conversation = loadConversation(
        collaborator.collaboratorId,
        createConversation(collaborator, { title: rule.title || "主动消息" }, device).conversationId,
      );
    }
    return enqueueMessage(conversation, collaborator, {
      clientRequestId: `initiative_${rule.ruleId}_${now()}`,
      text: rule.seed,
    }, device, {
      role: "system",
      source: "proactive",
      ruleId: rule.ruleId,
    });
  }

  async function runTurn(collaboratorId, conversationId, collaborator) {
    const conversation = loadConversation(collaboratorId, conversationId);
    const turn = conversation.activeTurn;
    if (!turn || turn.state !== "queued") return;
    activeConversations.set(conversationKey(collaboratorId, conversationId), conversation);
    setTurnState(conversation, "starting");
    turn.startedAt = now();
    saveConversation(conversation);
    try {
      const driver = driverForCollaborator(collaborator);
      activeDrivers.set(conversationKey(collaboratorId, conversationId), driver);
      const workspace = join(workspaceRoot, collaborator.collaboratorId);
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const tools = availableTools(collaborator);
      const configurationFingerprint = driverConfigurationFingerprint(
        collaborator,
        tools,
        configurationRevision(collaborator),
      );
      const canResumeDriverThread = conversation.driverConfigurationFingerprint === configurationFingerprint;
      const started = await driver.startTurn({
        threadId: canResumeDriverThread ? conversation.driverThreadId : null,
        cwd: workspace,
        instructions: requestInstructions(collaborator),
        historyContext: conversationHistoryContext(conversation, turn),
        historyMessages: conversationHistoryMessages(conversation, turn),
        tools: tools.map(dynamicTool),
        text: message(conversation, turn.userMessageId).content,
        userMessageId: turn.userMessageId,
        handler: {
          onNotification: (method, params) => handleNotification(conversation, method, params, workspace),
          onApproval: (request) => requestDriverApproval(conversation, request),
          onToolCall: (params) => handleToolCall(conversation, collaborator, tools, params),
          onDisconnect: (error) => interruptConversation(conversation, error.message),
        },
      });
      conversation.driverThreadId = started.threadId;
      conversation.driverConfigurationFingerprint = configurationFingerprint;
      turn.driverTurnId = started.turnId;
      if (turn.state === "starting") {
        setTurnState(conversation, "streaming");
        saveConversation(conversation);
      }
    } catch (error) {
      failConversation(conversation, safeFailure(error));
    }
  }

  function handleNotification(conversation, method, params, workspace) {
    const turn = conversation.activeTurn;
    if (!turn || (turn.driverTurnId && params.turnId && turn.driverTurnId !== params.turnId)) return;
    if (method === "item/agentMessage/delta") {
      const assistant = message(conversation, turn.assistantMessageId);
      assistant.content += String(params.delta ?? "");
      assistant.updatedAt = now();
      setTurnState(conversation, "streaming");
      appendEvent(conversation, "assistant.delta", {
        turnId: turn.turnId,
        messageId: assistant.messageId,
        delta: String(params.delta ?? ""),
      });
      touch(conversation, null);
      saveConversation(conversation);
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item ?? {};
      appendEvent(conversation, `driver.${method === "item/started" ? "itemStarted" : "itemCompleted"}`, {
        turnId: turn.turnId,
        item: publicDriverItem(item, workspace),
      });
      saveConversation(conversation);
      return;
    }
    if (method === "turn/completed") {
      const status = params.turn?.status ?? "failed";
      if (status === "completed") completeConversation(conversation);
      else if (status === "interrupted") interruptConversation(conversation, "回合已中断");
      else failConversation(conversation, params.turn?.error?.message ?? "Codex 回合失败");
    }
  }

  async function requestDriverApproval(conversation, request) {
    const turn = conversation.activeTurn;
    if (!turn) return;
    const approval = addApproval(conversation, {
      kind: driverApprovalKind(request.method),
      title: driverApprovalTitle(request.method),
      detail: publicApprovalDetail(request.method, request.params),
    });
    pendingApprovals.set(approval.approvalId, {
      conversation,
      continuation(decision) {
        request.respond(driverApprovalResponse(request.method, request.params, decision));
      },
    });
    setTurnState(conversation, "waitingApproval");
    saveConversation(conversation);
  }

  async function handleToolCall(conversation, collaborator, tools, params) {
    const tool = tools.find((candidate) => candidate.name === params.tool);
    if (!tool) throw new Error(`工具 ${params.tool} 不属于这个协作者`);
    const toolCallId = `hosttoolcall_${randomUUID()}`;
    const grants = sessionToolGrants.get(
      conversationKey(conversation.collaboratorId, conversation.conversationId),
    ) ?? new Set();
    if (!tool.annotations?.readOnlyHint && !grants.has(tool.name)) {
      await waitForToolApproval(conversation, tool, params.arguments ?? {});
    }
    setTurnState(conversation, "toolRunning");
    appendEvent(conversation, "tool.started", {
      turnId: conversation.activeTurn.turnId,
      toolCallId,
      toolName: tool.name,
      title: tool.title ?? tool.name,
    });
    saveConversation(conversation);
    try {
      const value = await executeTool(tool.name, params.arguments ?? {}, {
        deviceId: `hosted-collaborator:${collaborator.collaboratorId}`,
      }, collaborator);
      appendEvent(conversation, "tool.completed", {
        turnId: conversation.activeTurn.turnId,
        toolCallId,
        toolName: tool.name,
        title: tool.title ?? tool.name,
      });
      setTurnState(conversation, "streaming");
      saveConversation(conversation);
      return value;
    } catch (error) {
      appendEvent(conversation, "tool.failed", {
        turnId: conversation.activeTurn.turnId,
        toolCallId,
        toolName: tool.name,
        title: tool.title ?? tool.name,
        message: safeFailure(error),
      });
      setTurnState(conversation, "streaming");
      saveConversation(conversation);
      throw error;
    }
  }

  function waitForToolApproval(conversation, tool, argumentsValue) {
    const approval = addApproval(conversation, {
      kind: "tool",
      title: tool.title ?? tool.name,
      detail: { toolName: tool.name, arguments: argumentsValue },
    });
    setTurnState(conversation, "waitingApproval");
    saveConversation(conversation);
    return new Promise((resolve, reject) => {
      pendingApprovals.set(approval.approvalId, {
        conversation,
        continuation(decision) {
          if (decision === "allowSession") {
            const key = conversationKey(conversation.collaboratorId, conversation.conversationId);
            const grants = sessionToolGrants.get(key) ?? new Set();
            grants.add(tool.name);
            sessionToolGrants.set(key, grants);
            resolve();
          } else if (decision === "allowOnce") resolve();
          else reject(new Error("用户没有允许这次工具调用"));
        },
      });
    });
  }

  function resolveApproval(conversation, approvalId, body, device) {
    const pending = pendingApprovals.get(approvalId);
    if (pending) conversation = pending.conversation;
    const approval = conversation.approvals.find((candidate) => candidate.approvalId === approvalId);
    if (!approval) throw new HttpError(404, "approval.unknown", "unknown approval request");
    if (approval.state !== "pending") return publicConversation(conversation, true);
    const decision = validatedDecision(body?.decision);
    if (!pending) {
      throw new HttpError(409, "approval.turn_interrupted", "this approval can no longer resume its turn");
    }
    approval.state = "resolved";
    approval.decision = decision;
    approval.resolvedAt = now();
    approval.resolvedByDeviceId = device.deviceId;
    pendingApprovals.delete(approvalId);
    setTurnState(conversation, "streaming");
    appendEvent(conversation, "approval.resolved", {
      turnId: approval.turnId,
      approvalId,
      decision,
    });
    touch(conversation, device.deviceId);
    saveConversation(conversation);
    pending.continuation(decision);
    return publicConversation(conversation, true);
  }

  async function cancelTurn(conversation, turnId, device) {
    const turn = conversation.activeTurn;
    if (!turn || turn.turnId !== turnId || !ACTIVE_STATES.has(turn.state)) {
      throw new HttpError(409, "conversation.turn_not_active", "turn is not active");
    }
    turn.cancelledByDeviceId = device.deviceId;
    for (const approval of conversation.approvals.filter((item) => item.state === "pending")) {
      const pending = pendingApprovals.get(approval.approvalId);
      pendingApprovals.delete(approval.approvalId);
      approval.state = "resolved";
      approval.decision = "cancel";
      approval.resolvedAt = now();
      approval.resolvedByDeviceId = device.deviceId;
      appendEvent(conversation, "approval.resolved", {
        turnId: approval.turnId,
        approvalId: approval.approvalId,
        decision: "cancel",
      });
      pending?.continuation("cancel");
    }
    if (conversation.driverThreadId && turn.driverTurnId) {
      const driver = activeDrivers.get(
        conversationKey(conversation.collaboratorId, conversation.conversationId),
      );
      await driver.interrupt(conversation.driverThreadId, turn.driverTurnId);
    }
    interruptConversation(conversation, "用户取消了这次回合");
    return publicConversation(conversation, true);
  }

  function availableTools(collaborator) {
    const all = toolCatalog(collaborator);
    if (collaborator.toolAccess?.mode !== "selected") return all;
    const selected = new Set(collaborator.toolAccess.toolNames ?? []);
    return all.filter((tool) => selected.has(tool.name));
  }

  function conversationHistoryContext(conversation, currentTurn) {
    return conversation.messages
      .filter((item) => item.messageId !== currentTurn.userMessageId
        && item.messageId !== currentTurn.assistantMessageId
        && item.status === "completed"
        && item.content)
      .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`)
      .join("\n\n");
  }

  function conversationHistoryMessages(conversation, currentTurn) {
    return conversation.messages
      .filter((item) => item.messageId !== currentTurn.userMessageId
        && item.messageId !== currentTurn.assistantMessageId
        && item.status === "completed"
        && item.content)
      .map((item) => ({ role: item.role, content: item.content }));
  }

  function recoverInterruptedConversations() {
    if (!existsSync(root)) return;
    for (const collaboratorId of readdirSync(root)) {
      if (!ID.test(collaboratorId)) continue;
      for (const conversation of loadConversations(collaboratorId)) {
        if (!conversation.activeTurn || !ACTIVE_STATES.has(conversation.activeTurn.state)) continue;
        for (const approval of conversation.approvals.filter((item) => item.state === "pending")) {
          approval.state = "expired";
          approval.resolvedAt = now();
          approval.decision = "interrupted";
          appendEvent(conversation, "approval.resolved", {
            turnId: approval.turnId,
            approvalId: approval.approvalId,
            decision: "interrupted",
          });
        }
        interruptConversation(conversation, "Aru Host 重启后保留了历史，但没有重复执行未完成的动作");
      }
    }
  }

  function addApproval(conversation, { kind, title, detail }) {
    const approval = {
      approvalId: `hostapproval_${randomUUID()}`,
      turnId: conversation.activeTurn.turnId,
      kind,
      title,
      detail,
      state: "pending",
      decision: null,
      createdAt: now(),
      resolvedAt: null,
      resolvedByDeviceId: null,
    };
    conversation.approvals.push(approval);
    appendEvent(conversation, "approval.requested", publicApproval(approval));
    return approval;
  }

  function completeConversation(conversation) {
    const turn = conversation.activeTurn;
    if (!turn) return;
    turn.state = "completed";
    turn.completedAt = now();
    message(conversation, turn.assistantMessageId).status = "completed";
    appendEvent(conversation, "turn.completed", { turnId: turn.turnId });
    touch(conversation, null);
    saveConversation(conversation);
    emitTurnSettled(conversation, turn, "completed", null);
    clearActiveConversation(conversation);
  }

  function failConversation(conversation, failure) {
    const turn = conversation.activeTurn;
    if (!turn || !ACTIVE_STATES.has(turn.state)) return;
    turn.state = "failed";
    turn.completedAt = now();
    turn.failure = failure;
    message(conversation, turn.assistantMessageId).status = "failed";
    appendEvent(conversation, "turn.failed", { turnId: turn.turnId, message: failure });
    touch(conversation, null);
    saveConversation(conversation);
    emitTurnSettled(conversation, turn, "failed", failure);
    clearActiveConversation(conversation);
  }

  function interruptConversation(conversation, failure) {
    const turn = conversation.activeTurn;
    if (!turn || !ACTIVE_STATES.has(turn.state)) return;
    turn.state = "interrupted";
    turn.completedAt = now();
    turn.failure = failure;
    message(conversation, turn.assistantMessageId).status = "interrupted";
    appendEvent(conversation, "turn.interrupted", { turnId: turn.turnId, message: failure });
    touch(conversation, null);
    saveConversation(conversation);
    emitTurnSettled(conversation, turn, "interrupted", failure);
    clearActiveConversation(conversation);
  }

  function emitTurnSettled(conversation, turn, outcome, failure) {
    const assistantMessage = message(conversation, turn.assistantMessageId);
    const event = {
      outcome,
      failure,
      conversation: publicConversation(conversation, true),
      turn: publicTurn(turn),
      assistantMessage: assistantMessage ? { ...assistantMessage } : null,
    };
    void Promise.resolve(onTurnSettled(event)).catch(() => {});
  }

  function clearActiveConversation(conversation) {
    const key = conversationKey(conversation.collaboratorId, conversation.conversationId);
    activeConversations.delete(key);
    activeDrivers.delete(key);
  }

  function setTurnState(conversation, state) {
    if (!conversation.activeTurn || conversation.activeTurn.state === state) return;
    conversation.activeTurn.state = state;
    appendEvent(conversation, "turn.state", {
      turnId: conversation.activeTurn.turnId,
      state,
    });
  }

  function appendEvent(conversation, kind, payload) {
    conversation.events.push({
      sequence: conversation.nextSequence++,
      kind,
      payload,
      at: now(),
    });
  }

  function publicConversation(conversation, includeBody) {
    const turn = conversation.activeTurn ? publicTurn(conversation.activeTurn) : null;
    const value = {
      schema: CONVERSATION_SCHEMA,
      conversationId: conversation.conversationId,
      collaboratorId: conversation.collaboratorId,
      title: conversation.title,
      revision: conversation.revision,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      archivedAt: conversation.archivedAt,
      cursor: conversation.events.at(-1)?.sequence ?? 0,
      activeTurn: turn,
      messageCount: conversation.messages.length,
      pendingApprovalCount: conversation.approvals.filter((approval) => approval.state === "pending").length,
      lastMessagePreview: conversation.messages.at(-1)?.content.slice(0, 180) ?? "",
    };
    if (includeBody) {
      value.messages = conversation.messages
        .filter((item) => item.role !== "system")
        .map(({ clientRequestId: _, ...item }) => item);
      value.approvals = conversation.approvals.map(publicApproval);
    }
    return value;
  }

  function publicApproval(approval) {
    const { resolvedByDeviceId: _, ...value } = approval;
    return value;
  }

  function publicTurn(turn) {
    const { driverTurnId: _, cancelledByDeviceId: __, ...value } = turn;
    return value;
  }

  function loadConversations(collaboratorId) {
    const directory = collaboratorDirectory(collaboratorId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5)))
      .map((name) => {
        try { return JSON.parse(readFileSync(join(directory, name), "utf8")); }
        catch { return null; }
      })
      .filter(Boolean);
  }

  function loadConversation(collaboratorId, conversationId) {
    const active = activeConversations.get(conversationKey(collaboratorId, conversationId));
    if (active) return active;
    const path = conversationPath(collaboratorId, conversationId);
    if (!existsSync(path)) throw new HttpError(404, "conversation.unknown", "unknown conversation");
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new HttpError(500, "conversation.unreadable", "conversation ledger is unreadable"); }
  }

  function saveConversation(conversation) {
    const directory = collaboratorDirectory(conversation.collaboratorId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = conversationPath(conversation.collaboratorId, conversation.conversationId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(conversation, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }

  function collaboratorDirectory(collaboratorId) {
    return join(root, validatedId(collaboratorId, "collaborator"));
  }

  function conversationPath(collaboratorId, conversationId) {
    return join(collaboratorDirectory(collaboratorId), `${validatedId(conversationId, "conversation")}.json`);
  }

  function conversationKey(collaboratorId, conversationId) {
    return `${collaboratorId}::${conversationId}`;
  }

  function touch(conversation, deviceId) {
    conversation.revision += 1;
    conversation.updatedAt = now();
    if (deviceId) conversation.updatedByDeviceId = deviceId;
  }

  function message(conversation, messageId) {
    return conversation.messages.find((candidate) => candidate.messageId === messageId);
  }

  return {
    route,
    inventory,
    runProactive,
    status() {
      const conversations = [];
      if (existsSync(root)) {
        for (const collaboratorId of readdirSync(root)) {
          if (ID.test(collaboratorId)) conversations.push(...loadConversations(collaboratorId));
        }
      }
      return {
        conversationCount: conversations.length,
        activeTurnCount: conversations.filter((item) => ACTIVE_STATES.has(item.activeTurn?.state)).length,
        pendingApprovalCount: conversations.reduce(
          (count, item) => count + item.approvals.filter((approval) => approval.state === "pending").length,
          0,
        ),
      };
    },
  };
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

function eventCursor(rawURL) {
  const value = new URL(rawURL, "http://aru.local").searchParams.get("after") ?? "0";
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function validatedId(value, kind) {
  const id = String(value ?? "");
  if (!ID.test(id)) throw new Error(`invalid ${kind} id`);
  return id;
}

function validatedOptionalTitle(value) {
  if (value === undefined || value === null || value === "") return null;
  const title = String(value).trim();
  if (!title) return null;
  if ([...title].length > 120) throw new Error("conversation title is too long");
  return title;
}

function validatedMessage(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("message text is required");
  return value.trim();
}

function validatedClientRequestId(value) {
  const id = String(value ?? "").trim();
  if (!ID.test(id)) throw new Error("clientRequestId is invalid");
  return id;
}

function validatedDecision(value) {
  if (!["allowOnce", "allowSession", "deny", "cancel"].includes(value)) {
    throw new Error("approval decision is invalid");
  }
  return value;
}

function messageTitle(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return [...compact].slice(0, 40).join("");
}

function safeFailure(error) {
  const message = String(error?.message ?? "电脑协作者运行失败").trim();
  if (/unauthorized|not logged in|login/i.test(message)) return "请先在这台电脑的 Codex 中登录";
  return message || "电脑协作者运行失败";
}
