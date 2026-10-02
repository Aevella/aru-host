import { SYNC_SCHEMA, messagePage, syncProjection } from "./conversation-sync.mjs";
import { replicaInstructions, proactiveReplicaSeed, messageContentWithTime, historyRoleLabel, isoTimestamp, validatedReplicaRole, dynamicTool, driverConfigurationFingerprint, collaboratorInstructions, driverApprovalKind, driverApprovalTitle, publicApprovalDetail, driverApprovalResponse, publicDriverItem, publicWorkspacePath } from "./driver-projection.mjs";
import { createCollaboratorConversationAttachmentHost } from "./attachments.mjs";
import { createReplicaDeliveryRecovery } from "./replica-delivery-recovery.mjs";
import { createTurnExecution, waitForTurnStop } from "./turn-execution.mjs";
import { mutateConversationLifecycle } from "./collaborator-conversation-lifecycle.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { once } from "node:events";

const CONVERSATION_SCHEMA = "aru.selfhost.collaborator-conversation.v1";
const INVENTORY_SCHEMA = "aru.selfhost.collaborator-conversation-inventory.v1";
const EVENTS_SCHEMA = "aru.selfhost.collaborator-conversation-events.v1";
const ID = /^[A-Za-z0-9_-]+$/;
// Pre-0.30 VPS installers copy a fixed payload list, so this owner must remain
// in the existing conversation payload until that installed upgrade floor retires.
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
  cancellationWaitMs = 15_000,
  defer = setImmediate,
  attachmentHost = null,
}) {
  const root = join(dataDir, "collaborator-conversations");
  const workspaceRoot = join(dataDir, "collaborator-workspaces");
  const pendingApprovals = new Map();
  const activeConversations = new Map();
  const activeDrivers = new Map();
  const executions = new Map();
  const sessionToolGrants = new Map();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const attachments = attachmentHost ?? createCollaboratorConversationAttachmentHost({
    dataDir, readJSONBody, sendJSON, HttpError, now,
  });
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
        sendJSON(res, 201, wireConversation(clientInput(() => createConversation(collaborator, body, device)), req));
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
    const query = new URL(req.url, "http://host").searchParams;
    if (suffix === "/sync" && req.method === "GET") {
      const path = conversationPath(collaborator.collaboratorId, conversationId);
      if (!existsSync(path)) throw new HttpError(404, "conversation.unknown", "unknown conversation");
      // Atomic ledger replacement makes file identity a change token without a second registry.
      const stat = statSync(path, { bigint: true });
      const version = `${stat.ino}-${stat.mtimeNs}-${stat.size}`;
      if (query.get("version") === version) {
        sendJSON(res, 200, { schema: SYNC_SCHEMA, collaboratorId: collaborator.collaboratorId,
          conversationId, version, unchanged: true });
        return true;
      }
      const afterText = query.get("after");
      const after = afterText === null ? null : Number(afterText);
      if (after !== null && (!Number.isSafeInteger(after) || after < 0)) {
        throw new HttpError(400, "conversation.cursor_invalid", "invalid event cursor");
      }
      const value = loadConversation(collaborator.collaboratorId, conversationId);
      sendJSON(res, 200, syncProjection(value, publicConversation(value, false), version, after));
      return true;
    }
    const conversation = loadConversation(collaborator.collaboratorId, conversationId);
    if (suffix === "/messages" && req.method === "GET") {
      sendJSON(res, 200, messagePage(conversation, query.get("before"), HttpError));
      return true;
    }

    if (suffix.startsWith("/attachments")) {
      try {
        if (await attachments.route(req, res, {
          suffix, collaboratorId: collaborator.collaboratorId, conversationId, device, conversation,
        })) return true;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "attachment.input_invalid", error.message ?? "invalid attachment input");
      }
    }

    if (!suffix && ["PUT", "DELETE"].includes(req.method)) {
      const body = await readJSONBody(req, 64 * 1024);
      mutateConversationLifecycle({ conversation, body, deleting: req.method === "DELETE",
        deviceId: device.deviceId, now, save: saveConversation, HttpError });
      sendJSON(res, 200, wireConversation(publicConversation(conversation, true), req));
      return true;
    }
    if (!suffix && req.method === "GET") {
      sendJSON(res, 200, wireConversation(publicConversation(conversation, true), req));
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
      sendJSON(res, 202, wireConversation(clientInput(() => enqueueMessage(conversation, collaborator, body, device)), req));
      return true;
    }
    const approvalMatch = suffix.match(/^\/approvals\/([^/]+)$/);
    if (approvalMatch && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, wireConversation(clientInput(() => resolveApproval(
        conversation,
        validatedId(approvalMatch[1], "approval"),
        body,
        device,
      )), req));
      return true;
    }
    const cancelMatch = suffix.match(/^\/turns\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      sendJSON(res, 202, wireConversation(await cancelTurn(
        conversation,
        clientInput(() => validatedId(cancelMatch[1], "turn")),
        device,
      ), req));
      return true;
    }
    return false;
  }

  function wireConversation(value, req) {
    if (new URL(req.url, "http://host").searchParams.get("window") !== "1") return value;
    return { ...value, messages: value.messages.slice(-64),
      approvals: value.approvals.filter(item => item.state === "pending") };
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
    const text = validatedOptionalMessage(body?.text);
    const clientRequestId = validatedClientRequestId(body?.clientRequestId);
    const existing = conversation.messages.find((message) => message.clientRequestId === clientRequestId);
    if (existing) return publicConversation(conversation, true);
    const driver = driverForCollaborator(collaborator);
    const messageAttachments = attachments.prepareMessageAttachments(
      conversation, body?.attachmentIds, driver,
    );
    if (!text && messageAttachments.length === 0) {
      throw new Error("message requires text or at least one attachment");
    }
    const publicContent = text || attachmentSummary(messageAttachments);

    const timestamp = now();
    const userMessage = {
      messageId: `hostmsg_${randomUUID()}`,
      clientRequestId,
      role: options.role ?? "user",
      content: publicContent,
      driverText: text,
      attachments: messageAttachments,
      status: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const assistantMessage = {
      messageId: `hostmsg_${randomUUID()}`,
      clientRequestId: null,
      role: "assistant",
      content: "",
      attachments: [],
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
      ruleVersion: options.ruleVersion ?? null,
      // Whether a completed turn may alert registered phones; null keeps the
      // default for turns that no rule governs.
      notify: typeof options.notify === "boolean" ? options.notify : null,
      deliveryId: options.deliveryId ?? null,
      sourceCollaboratorId: options.sourceCollaboratorId ?? null,
      sourceConversationId: options.sourceConversationId ?? null,
      baseMessageId: options.baseMessageId ?? null,
      basisMessages: options.basisMessages ?? [],
      executionEpoch: options.executionEpoch ?? null,
    };
    conversation.messages.push(userMessage, assistantMessage);
    conversation.activeTurn = turn;
    if (conversation.title === "新对话") conversation.title = messageTitle(publicContent);
    touch(conversation, device.deviceId);
    appendEvent(conversation, "message.accepted", {
      turnId: turn.turnId,
      userMessageId: userMessage.messageId,
      assistantMessageId: assistantMessage.messageId,
    });
    saveConversation(conversation);
    attachments.commitMessageBindings(conversation, userMessage);
    defer(() => runTurn(conversation.collaboratorId, conversation.conversationId, collaborator, turn.turnId));
    return publicConversation(conversation, true);
  }

  function runProactive(collaborator, rule) {
    const device = { deviceId: "host-scheduler" };
    let conversation;
    if (rule.conversationMode === "fixed") {
      conversation = loadConversation(collaborator.collaboratorId, rule.conversationId);
    } else {
      conversation = latestLiveConversation(collaborator.collaboratorId);
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
      notify: rule.notificationsEnabled === true,
    });
  }

  function runReplicaProactive(executor, replica, rule, deliveryId) {
    const device = { deviceId: "host-mobile-replica-scheduler" };
    const triggeredAt = now();
    const collaborator = {
      ...executor,
      collaboratorId: `mobilereplica_${replica.sourceCollaboratorId}`,
      displayName: replica.displayName,
      authority: "mobile-replica",
      executorCollaboratorId: executor.collaboratorId,
      mobileInstructions: replicaInstructions(replica),
      revision: replica.revision,
    };
    const source = replica.conversations.find(
      (candidate) => candidate.conversationId === rule.conversationId,
    ) ?? null;
    const conversation = loadConversation(
      collaborator.collaboratorId,
      createConversation(collaborator, { title: source?.title || rule.title || "主动消息" }, device).conversationId,
    );
    // Lets deleting the executing face find and stop this turn.
    conversation.executorCollaboratorId = executor.collaboratorId;
    for (const item of source?.messages ?? []) {
      const content = String(item.content ?? "").trim();
      if (!content) continue;
      conversation.messages.push({
        messageId: `hostmsg_${randomUUID()}`,
        clientRequestId: null,
        role: validatedReplicaRole(item.role),
        content,
        status: "completed",
        createdAt: Number(item.createdAt) || now(),
        updatedAt: Number(item.updatedAt) || Number(item.createdAt) || now(),
      });
    }
    touch(conversation, device.deviceId);
    saveConversation(conversation);
    return enqueueMessage(conversation, collaborator, {
      clientRequestId: `mobile_initiative_${deliveryId}`,
      text: proactiveReplicaSeed(rule, triggeredAt, replica.generatedAt),
    }, device, {
      role: "system",
      source: "mobile-replica-proactive",
      ruleId: rule.ruleId,
      ruleVersion: rule.sourceVersion,
      deliveryId,
      sourceCollaboratorId: replica.sourceCollaboratorId,
      sourceConversationId: source?.conversationId ?? null,
      baseMessageId: source?.baseMessageId ?? null,
      basisMessages: source?.messages ?? [],
      executionEpoch: replica.epoch,
    });
  }

  async function runTurn(collaboratorId, conversationId, collaborator, expectedTurnId) {
    const conversation = loadConversation(collaboratorId, conversationId);
    const turn = conversation.activeTurn;
    if (!turn || turn.state !== "queued") return;
    if (turn.turnId !== expectedTurnId || !ACTIVE_STATES.has(turn.state)) return;
    activeConversations.set(conversationKey(collaboratorId, conversationId), conversation);
    const execution = createTurnExecution();
    executions.set(conversationKey(collaboratorId, conversationId), execution);
    const acceptsResult = () => conversation.activeTurn === turn && ACTIVE_STATES.has(turn.state) && !execution.signal.aborted;
    setTurnState(conversation, "starting");
    turn.startedAt = now();
    saveConversation(conversation);
    try {
      const driver = driverForCollaborator(collaborator);
      activeDrivers.set(conversationKey(collaboratorId, conversationId), driver);
      const workspace = join(workspaceRoot, collaborator.collaboratorId);
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const userMessage = message(conversation, turn.userMessageId);
      const projectedAttachments = attachments.projectForWorkspace(userMessage.attachments, workspace);
      const tools = availableTools(collaborator);
      const configurationFingerprint = driverConfigurationFingerprint(
        collaborator,
        tools,
        configurationRevision(collaborator),
      );
      const canResumeDriverThread = conversation.driverConfigurationFingerprint === configurationFingerprint;
      if (!canResumeDriverThread) sessionToolGrants.delete(conversationKey(collaboratorId, conversationId));
      const started = await execution.start(() => driver.startTurn({
        threadId: canResumeDriverThread ? conversation.driverThreadId : null,
        cwd: workspace,
        instructions: requestInstructions(collaborator),
        historyContext: conversationHistoryContext(conversation, turn),
        historyMessages: conversationHistoryMessages(conversation, turn),
        tools: tools.map(dynamicTool),
        text: messageContentWithTime(
          userMessage,
          userMessage.driverText ?? userMessage.content,
        ),
        attachments: projectedAttachments,
        userMessageId: turn.userMessageId,
        handler: {
          onNotification: (method, params) => acceptsResult() && handleNotification(conversation, method, params, workspace),
          onApproval: (request) => acceptsResult() ? requestDriverApproval(conversation, collaborator, request) : request.respond({ decision: "cancel" }),
          onToolCall: (params) => execution.tool(() => handleToolCall(conversation, collaborator, tools, params, execution, turn)),
          onDisconnect: (error) => acceptsResult() && interruptConversation(conversation, error.message),
        },
      }));
      if (!acceptsResult()) return;
      conversation.driverThreadId = started.threadId;
      conversation.driverConfigurationFingerprint = configurationFingerprint;
      turn.driverTurnId = started.turnId;
      if (turn.state === "starting") {
        setTurnState(conversation, "streaming");
        saveConversation(conversation);
      }
    } catch (error) {
      if (acceptsResult()) failConversation(conversation, safeFailure(error));
    }
  }

  function handleNotification(conversation, method, params, workspace) {
    const turn = conversation.activeTurn;
    const notificationTurnId = params.turnId ?? params.turn?.id;
    if (!turn || (turn.driverTurnId && notificationTurnId && turn.driverTurnId !== notificationTurnId)) return;
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

  // A mobile replica turn runs under the computer face that executes it, so its
  // approval policy is that face's current setting, read at each action.
  function approvalAllowsAlways(collaborator) {
    const ownerId = collaborator.authority === "mobile-replica"
      ? collaborator.executorCollaboratorId
      : collaborator.collaboratorId;
    try {
      return collaboratorForId(ownerId).approvalMode === "always_allow";
    } catch {
      return false;
    }
  }

  async function requestDriverApproval(conversation, collaborator, request) {
    const turn = conversation.activeTurn;
    if (!turn) return;
    if (approvalAllowsAlways(collaborator)) {
      request.respond(driverApprovalResponse(request.method, request.params, "allowOnce"));
      return;
    }
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

  async function handleToolCall(conversation, collaborator, tools, params, execution, expectedTurn) {
    const admitResult = () => {
      execution.signal.throwIfAborted();
      if (conversation.activeTurn !== expectedTurn) throw new Error("Turn is no longer active");
    };
    admitResult();
    const tool = tools.find((candidate) => candidate.name === params.tool);
    if (!tool) throw new Error(`工具 ${params.tool} 不属于这个协作者`);
    const toolCallId = `hosttoolcall_${randomUUID()}`;
    const grants = sessionToolGrants.get(
      conversationKey(conversation.collaboratorId, conversation.conversationId),
    ) ?? new Set();
    if (!tool.annotations?.readOnlyHint && !grants.has(tool.name)
        && !approvalAllowsAlways(collaborator)) {
      await waitForToolApproval(conversation, tool, params.arguments ?? {});
    }
    admitResult();
    setTurnState(conversation, "toolRunning");
    appendEvent(conversation, "tool.started", {
      turnId: conversation.activeTurn.turnId,
      toolCallId,
      toolName: tool.name,
      title: tool.title ?? tool.name,
    });
    saveConversation(conversation);
    try {
      let value;
      if (tool.name === "aru_collaborator_reply_attach") {
        const turn = conversation.activeTurn;
        const assistant = message(conversation, turn.assistantMessageId);
        const attachment = attachments.admitAssistantFile({
          conversation,
          messageId: assistant.messageId,
          workspace: join(workspaceRoot, collaborator.collaboratorId),
          path: params.arguments?.path,
          filename: params.arguments?.filename,
          mimeType: params.arguments?.mimeType,
        });
        assistant.attachments ??= [];
        assistant.attachments.push(attachment);
        assistant.updatedAt = now();
        value = { content: [{ type: "text", text: `已把 ${attachment.filename} 附到这条回复。` }] };
      } else {
        value = await executeTool(tool.name, params.arguments ?? {}, {
          deviceId: `hosted-collaborator:${collaborator.collaboratorId}`,
        }, collaborator, { conversationId: conversation.conversationId, turnId: expectedTurn.turnId, signal: execution.signal });
      }
      admitResult();
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
      admitResult();
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
    const key = conversationKey(conversation.collaboratorId, conversation.conversationId);
    const execution = executions.get(key);
    turn.failure = null;
    turn.cancellation = { status: "pending", requestedAt: now(), message: null };
    appendEvent(conversation, "turn.cancellation", { turnId, ...turn.cancellation });
    touch(conversation, device.deviceId);
    saveConversation(conversation);
    const stop = (execution ? execution.stop(activeDrivers.get(key)) : Promise.resolve()).then(() => {
      if (conversation.activeTurn !== turn || !ACTIVE_STATES.has(turn.state)) return;
      turn.cancellation.status = "confirmed";
      interruptConversation(conversation, "用户取消了这次回合");
    });
    try { await waitForTurnStop(stop, cancellationWaitMs); }
    catch (error) {
      if (conversation.activeTurn === turn && ACTIVE_STATES.has(turn.state)) {
        turn.cancellation = { ...turn.cancellation, status: "failed", message: safeFailure(error) };
        turn.failure = "停止尚未确认，请重试。";
        appendEvent(conversation, "turn.cancellation", { turnId, ...turn.cancellation });
        touch(conversation, device.deviceId);
        saveConversation(conversation);
      }
    }
    return publicConversation(conversation, true);
  }

  // A computer face's own conversations plus the phone-replica conversations it
  // executes, which live under the replica's id rather than the face's.
  function executedConversations(collaboratorId) {
    const own = loadConversations(collaboratorId).map((stored) => ({ ownerId: collaboratorId, stored }));
    if (!existsSync(root)) return own;
    const replicas = readdirSync(root)
      .filter((name) => name.startsWith("mobilereplica_") && ID.test(name))
      .flatMap((ownerId) => loadConversations(ownerId)
        .filter((stored) => stored.executorCollaboratorId === collaboratorId)
        .map((stored) => ({ ownerId, stored })));
    return [...own, ...replicas];
  }

  function hasActiveTurns(collaboratorId) {
    return executedConversations(collaboratorId).some(({ stored }) => ACTIVE_STATES.has(stored.activeTurn?.state));
  }

  // Deleting a computer collaborator on request stops its running turns first,
  // including proactive turns it runs for a phone. Each is cancelled on its live
  // conversation, the same way a person would.
  async function stopActiveTurns(collaboratorId, device) {
    const stopped = [];
    for (const { ownerId, stored } of executedConversations(collaboratorId)) {
      if (!ACTIVE_STATES.has(stored.activeTurn?.state)) continue;
      const conversation = loadConversation(ownerId, stored.conversationId);
      const turn = conversation.activeTurn;
      if (!ACTIVE_STATES.has(turn?.state)) continue;
      await cancelTurn(conversation, turn.turnId, device);
      if (ACTIVE_STATES.has(turn.state)) {
        throw new HttpError(409, "collaborator.stop_unconfirmed", "停止尚未确认，协作者及其对话保持原状，请重试停止。");
      }
      stopped.push(conversation.conversationId);
    }
    return stopped;
  }

  function availableTools(collaborator) {
    const all = toolCatalog(collaborator);
    const replyAttachmentTool = {
      name: "aru_collaborator_reply_attach",
      title: "把工作区文件附到回复",
      description: "Explicitly attach one regular file from the current collaborator workspace to this assistant reply.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path inside the current collaborator workspace." },
          filename: { type: "string" },
          mimeType: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    };
    if (collaborator.toolAccess?.mode !== "selected") return [...all, replyAttachmentTool];
    const selected = new Set(collaborator.toolAccess.toolNames ?? []);
    return [...all.filter((tool) => selected.has(tool.name)), replyAttachmentTool];
  }

  function conversationHistoryContext(conversation, currentTurn) {
    return conversation.messages
      .filter((item) => item.messageId !== currentTurn.userMessageId
        && item.messageId !== currentTurn.assistantMessageId
        && item.status === "completed"
        && item.content)
      .map((item) => `${historyRoleLabel(item.role)}: ${messageContentWithTime(item)}`)
      .join("\n\n");
  }

  function conversationHistoryMessages(conversation, currentTurn) {
    return conversation.messages
      .filter((item) => item.messageId !== currentTurn.userMessageId
        && item.messageId !== currentTurn.assistantMessageId
        && item.status === "completed"
        && item.content)
      .map((item) => ({ role: item.role, content: messageContentWithTime(item) }));
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
    executions.delete(key);
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
        .map(({ clientRequestId: _, driverText: __, ...item }, position) => ({ ...item, position }))
        .filter((item) => item.role !== "system");
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
    return { ...value, canCancel: ACTIVE_STATES.has(turn.state) && turn.cancellation?.status !== "pending" };
  }

  function loadConversations(collaboratorId, requireReadable = false) {
    const directory = collaboratorDirectory(collaboratorId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5)))
      .map((name) => {
        try { return JSON.parse(readFileSync(join(directory, name), "utf8")); }
        catch (error) { if (requireReadable) throw error; return null; }
      })
      .filter(Boolean);
  }

  function loadConversation(collaboratorId, conversationId) {
    const active = activeConversations.get(conversationKey(collaboratorId, conversationId));
    if (active) return active;
    const path = conversationPath(collaboratorId, conversationId);
    if (!existsSync(path)) throw new HttpError(404, "conversation.unknown", "unknown conversation");
    try {
      const conversation = JSON.parse(readFileSync(path, "utf8"));
      attachments.reconcileConversation(conversation);
      return conversation;
    }
    catch { throw new HttpError(500, "conversation.unreadable", "conversation ledger is unreadable"); }
  }

  function latestLiveConversation(collaboratorId) {
    return loadConversations(collaboratorId)
      .filter((conversation) => !conversation.archivedAt)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  function hasConversation(collaboratorId, conversationId) {
    try {
      return !loadConversation(collaboratorId, conversationId).archivedAt;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
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
    stopActiveTurns,
    hasActiveTurns,
    hasConversation,
    runProactive,
    runReplicaProactive,
    recoverReplicaDelivery: createReplicaDeliveryRecovery({ loadConversations, publicConversation, publicTurn, message }),
  };
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

function validatedOptionalMessage(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("message text is invalid");
  return value.trim();
}

function attachmentSummary(attachments) {
  return attachments.map((attachment) => `📎 ${attachment.filename}`).join("\n");
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
