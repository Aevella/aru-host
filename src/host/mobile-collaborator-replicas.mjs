export const replicaStorageVersion = 2;
import { createMobileMCP } from "./mobile-mcp.mjs";
import { createReplicaRecordStore } from "./replica-record-store.mjs";
import { assistantDeliveryContent } from "./assistant-delivery-content.mjs";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REPLICA_SCHEMA = "aru.selfhost.mobile-collaborator-replica.v1";
const RECEIPT_SCHEMA = "aru.selfhost.mobile-collaborator-replica-receipt.v1";
const DELIVERY_SCHEMA = "aru.selfhost.mobile-collaborator-delivery.v1";
const DELIVERY_INVENTORY_SCHEMA = "aru.selfhost.mobile-collaborator-delivery-inventory.v1";
const DELIVERY_ACK_SCHEMA = "aru.selfhost.mobile-collaborator-delivery-ack.v1";

const ID = /^[A-Za-z0-9_-]+$/;

// Bounds the Host's own not-yet-synced messages added to one turn's context.
const MAX_CONTINUED_DELIVERIES = 24;

export function createMobileCollaboratorReplicaHost({
  dataDir,
  readJSONBody,
  sendJSON,
  HttpError,
  collaboratorForId,
  trigger,
  maximumRequestBytes,
  onDelivery = async () => {},
  recoverDelivery = () => null,
  now = Date.now,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  mcpSecretStore,
  mcpConnect,
}) {
  const mcp = createMobileMCP({ secretStore: mcpSecretStore, connect: mcpConnect });
  const writes = new Map();
  async function serialized(id, operation) {
    const previous = writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    writes.set(id, next);
    try { return await next; } finally { if (writes.get(id) === next) writes.delete(id); }
  }
  const root = join(dataDir, "mobile-collaborator-replicas");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const records = createReplicaRecordStore(root);
  const ledger = records.ledger;
  ledger.revokedExecutions ??= [];
  ledger.mcpCleanup ??= [];
  async function cleanupMCP(sourceId) {
    for (const item of [...(ledger.mcpCleanup ?? [])].filter(item => item.sourceCollaboratorId === sourceId)) {
      try {
        await mcp.remove(item.sourceCollaboratorId, item.epoch);
        ledger.mcpCleanup = ledger.mcpCleanup.filter(entry => entry.sourceCollaboratorId !== item.sourceCollaboratorId || entry.epoch !== item.epoch);
        saveLedger();
      } catch { /* No active grant can reach this retired key. Retry on the next sync/revoke. */ }
    }
  }
  for (const replica of ledger.replicas) records.retireContinuation(replica.sourceCollaboratorId, replica.epoch, replica.revision);
  let timer = null;
  let started = false;
  let dueAttempt;
  const activeExecutions = new Set();
  // Same-process evidence: publication failed before trigger was invoked.
  const unstartedAdmissions = new Map();
  const executionKey = (source, epoch, id) => `${source}/${epoch}/${id}`;
  // Complete results are reconciled before old in-flight markers are cleared.
  // No model/tool action is retried during recovery.
  const recoveryEvents = [];
  // Migrate outstanding legacy rule markers once into independent attempts.
  for (const replica of ledger.replicas) {
    for (const rule of replica.rules ?? []) {
      if (rule.inFlightDeliveryId && !records.get("executions", replica.sourceCollaboratorId, replica.epoch, rule.inFlightDeliveryId)) {
        records.put("executions", executionRecord(replica, rule, rule.inFlightDeliveryId));
      }
    }
  }
  saveLedger();
  for (const execution of records.running()) {
    if (execution.state !== "running") continue;
    const event = recoverDelivery(execution.sourceCollaboratorId, execution.deliveryId, execution.epoch);
    if (event) recoveryEvents.push(event);
    else {
      execution.state = "uncertain";
      execution.updatedAt = now();
      records.put("executions", execution);
      const replica = replicaForId(execution.sourceCollaboratorId, false);
      const rule = replica?.epoch === execution.epoch
        ? replica.rules.find((item) => item.inFlightDeliveryId === execution.deliveryId) : null;
      if (rule) { rule.inFlightDeliveryId = null; rule.inFlightRuleVersion = null; }
    }
  }
  saveLedger();

  function executionRecord(replica, rule, deliveryId) {
    return { deliveryId, sourceCollaboratorId: replica.sourceCollaboratorId, epoch: replica.epoch,
      ruleId: rule.ruleId, ruleVersion: rule.sourceVersion, title: rule.title, state: "running", createdAt: now(), updatedAt: now(),
      content: null, failure: null };
  }

  async function route(req, res, path, requireDevice) {
    if (path.startsWith("/aru/v1/mobile-collaborator-")) {
      requireDevice();
      recoverStorage();
    }
    if (path === "/aru/v1/mobile-collaborator-execution-grants" && req.method === "GET") {
      requireDevice();
      const executor = validatedId(new URL(req.url, "http://localhost").searchParams.get("executor"), "executor collaborator");
      collaboratorForId(executor);
      const grants = ledger.replicas.filter(replica => replica.executorHostCollaboratorId === executor
        && !executionRevoked(replica.sourceCollaboratorId, replica.epoch))
        .map(replica => ({ sourceCollaboratorId: replica.sourceCollaboratorId,
          executorHostCollaboratorId: executor, epoch: replica.epoch }));
      sendJSON(res, 200, { schema: "aru.selfhost.mobile-execution-grants.v1", grants });
      return true;
    }
    if (path === "/aru/v1/mobile-collaborator-mcp-capabilities" && req.method === "GET") {
      requireDevice(); sendJSON(res, 200, { version: 1 }); return true;
    }
    const match = path.match(/^\/aru\/v1\/mobile-collaborator-replicas\/([^/]+)(.*)$/);
    if (!match) return false;
    const sourceCollaboratorId = validatedId(match[1], "source collaborator");
    const suffix = match[2] || "";
    requireDevice();
    if (!suffix && req.method === "PUT") {
      const body = await readJSONBody(req, maximumRequestBytes);
      requireDevice();
      sendJSON(res, 200, await serialized(sourceCollaboratorId, () => upsert(sourceCollaboratorId, body)));
      return true;
    }
    if (suffix === "/revoke" && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      requireDevice();
      const epoch = positiveInteger(body?.epoch, "epoch");
      await serialized(sourceCollaboratorId, async () => {
        const current = replicaForId(sourceCollaboratorId, false);
        if (current && current.epoch > epoch) throw new HttpError(409, "mobile_replica.epoch_stale", "a newer execution grant is active");
        const previous = ledger.revokedExecutions;
        const previousCleanup = ledger.mcpCleanup ?? [];
        const oldMCP = current?.mcp;
        ledger.revokedExecutions = previous.filter(item => item.sourceCollaboratorId !== sourceCollaboratorId);
        ledger.revokedExecutions.push({ sourceCollaboratorId,
          epoch: Math.max(epoch, previous.find(item => item.sourceCollaboratorId === sourceCollaboratorId)?.epoch ?? 0) });
        if (current) delete current.mcp;
        if (mcpSecretStore && !previousCleanup.some(item => item.sourceCollaboratorId === sourceCollaboratorId && item.epoch === epoch)) {
          ledger.mcpCleanup = [...previousCleanup, { sourceCollaboratorId, epoch }];
        }
        try { saveLedger(); }
        catch (error) { ledger.revokedExecutions = previous; ledger.mcpCleanup = previousCleanup; if (current) current.mcp = oldMCP; throw error; }
        mcp.invalidate(sourceCollaboratorId);
        // Durable revocation is sufficient to return phone ownership. An inaccessible
        // retired key must not hold that handoff hostage; cleanup has its own retry.
        if (mcpSecretStore) await cleanupMCP(sourceCollaboratorId);
        schedule();
      });
      sendJSON(res, 200, { schema: "aru.selfhost.mobile-collaborator-revoke-receipt.v1", sourceCollaboratorId, epoch });
      return true;
    }
    if (suffix === "/mcp-check" && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      const replica = replicaForId(sourceCollaboratorId, true);
      const collaborator = { mobileSourceId: sourceCollaboratorId, mobileEpoch: positiveInteger(body.epoch, "epoch"),
        executorCollaboratorId: replica.executorHostCollaboratorId, mobileMCPFingerprint: replica.mcp?.fingerprint };
      admittedReplica(collaborator);
      await mcp.catalog(replica, undefined, () => admittedReplica(collaborator));
      sendJSON(res, 200, { sourceCollaboratorId, epoch: replica.epoch, connections: mcp.status(sourceCollaboratorId) });
      return true;
    }
    if (suffix === "/executions" && req.method === "GET") {
      const epoch = requestEpoch(req.url);
      const replica = replicaForId(sourceCollaboratorId, true);
      if (replica.epoch !== epoch) throw new HttpError(409, "mobile_replica.epoch_stale", "execution epoch is stale");
      const cursor = new URL(req.url, "http://aru.local").searchParams.get("after");
      const page = records.indexed("executions", sourceCollaboratorId, epoch, { after: cursor, limit: 51 });
      if (!page) throw new HttpError(409, "mobile_execution.cursor_stale", "refresh execution history");
      const executions = page.slice(0, 50);
      sendJSON(res, 200, { schema: "aru.selfhost.mobile-collaborator-execution-inventory.v1",
        sourceCollaboratorId, epoch, executions,
        nextCursor: page.length > 50 ? executions.at(-1).deliveryId : null });
      return true;
    }
    if (suffix === "/deliveries" && req.method === "GET") {
      const epoch = requestEpoch(req.url);
      sendJSON(res, 200, deliveries(sourceCollaboratorId, epoch));
      return true;
    }
    if (suffix === "/deliveries/reject" && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, acknowledge(sourceCollaboratorId, body, true));
      return true;
    }
    if (suffix === "/deliveries/acknowledge" && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, acknowledge(sourceCollaboratorId, body));
      return true;
    }
    return false;
  }

  async function upsert(sourceCollaboratorId, body) {
    if (body?.schema !== REPLICA_SCHEMA || body.sourceCollaboratorId !== sourceCollaboratorId) {
      throw new HttpError(400, "mobile_replica.schema_invalid", "mobile collaborator replica identity is invalid");
    }
    const epoch = positiveInteger(body.epoch, "epoch");
    const revision = nonnegativeInteger(body.revision, "revision");
    if (executionRevoked(sourceCollaboratorId, epoch)) {
      throw new HttpError(409, "mobile_replica.epoch_revoked", "mobile collaborator execution grant was revoked");
    }
    const readerIds = uniqueIds(body.readerHostCollaboratorIds);
    const executorHostCollaboratorId = validatedId(body.executorHostCollaboratorId, "executor collaborator");
    if (!readerIds.includes(executorHostCollaboratorId)) readerIds.push(executorHostCollaboratorId);
    for (const collaboratorId of readerIds) collaboratorForId(collaboratorId);
    const sealedMCP = body.mcpConnections === undefined ? undefined
      : await mcp.seal(sourceCollaboratorId, epoch, body.mcpConnections);
    // Credential IO yields. Read scheduling truth only after it completes, so a
    // timer settling an occurrence cannot be overwritten by a pre-await snapshot.
    if (executionRevoked(sourceCollaboratorId, epoch)) throw new HttpError(409, "mobile_replica.epoch_revoked", "execution grant was revoked");
    const current = replicaForId(sourceCollaboratorId, false);
    if (current && epoch < current.epoch) {
      throw new HttpError(409, "mobile_replica.epoch_stale", "mobile collaborator execution epoch is stale");
    }
    if (current && epoch === current.epoch && revision < current.revision) {
      throw new HttpError(409, "mobile_replica.revision_stale", "mobile collaborator replica revision is stale");
    }
    if (current && epoch === current.epoch && revision === current.revision) {
      if (sealedMCP) {
        if (current.mcp?.fingerprint !== sealedMCP.fingerprint) throw new HttpError(409, "mobile_replica.revision_conflict", "MCP configuration changed; synchronize a newer revision");
        const previous = current.mcp;
        current.mcp = sealedMCP; // Same content can repair a lost/corrupt derived encryption key.
        try { saveLedger(); } catch (error) { current.mcp = previous; throw error; }
      }
      await cleanupMCP(sourceCollaboratorId);
      return publicReceipt(current);
    }
    const value = {
      schema: REPLICA_SCHEMA,
      sourceCollaboratorId,
      displayName: requiredText(body.displayName, "displayName"),
      systemPrompt: String(body.systemPrompt ?? ""),
      memories: validatedRecords(body.memories),
      references: validatedRecords(body.references),
      conversations: validatedConversations(body.conversations),
      rules: validatedRules(body.rules, current, epoch),
      readerHostCollaboratorIds: readerIds.sort(),
      executorHostCollaboratorId,
      epoch,
      revision,
      generatedAt: positiveInteger(body.generatedAt, "generatedAt"),
      updatedAt: now(),
    };
    value.mcp = body.mcpConnections === undefined
      ? (current?.epoch === epoch ? current.mcp : undefined)
      : sealedMCP;
    records.retireContinuation(sourceCollaboratorId, epoch, revision);
    const previousCleanup = ledger.mcpCleanup ?? [];
    if (current?.mcp?.count && current.epoch !== epoch) {
      ledger.mcpCleanup = [...previousCleanup, { sourceCollaboratorId, epoch: current.epoch }];
    }
    if (current) ledger.replicas.splice(ledger.replicas.indexOf(current), 1, value);
    else ledger.replicas.push(value);
    try { saveLedger(); }
    catch (error) {
      ledger.mcpCleanup = previousCleanup;
      const index = ledger.replicas.indexOf(value);
      if (current) ledger.replicas.splice(index, 1, current); else ledger.replicas.splice(index, 1);
      throw error;
    }
    if (current?.epoch !== epoch || current?.mcp?.fingerprint !== value.mcp?.fingerprint
        || JSON.stringify(current?.rules.map(rule => [rule.ruleId, rule.mcpServerIds])) !== JSON.stringify(value.rules.map(rule => [rule.ruleId, rule.mcpServerIds]))) mcp.invalidate(sourceCollaboratorId);
    schedule();
    await cleanupMCP(sourceCollaboratorId);
    return publicReceipt(value);
  }

  function deliveries(sourceCollaboratorId, epoch) {
    const replica = replicaForId(sourceCollaboratorId, true);
    if (epoch !== replica.epoch) {
      throw new HttpError(409, "mobile_replica.epoch_stale", "mobile collaborator execution epoch is stale");
    }
    return {
      schema: DELIVERY_INVENTORY_SCHEMA,
      deliveries: records.pending("deliveries", sourceCollaboratorId, epoch)
        .sort((left, right) => left.createdAt - right.createdAt || left.deliveryId.localeCompare(right.deliveryId))
        .map(publicDelivery),
    };
  }

  function acknowledge(sourceCollaboratorId, body, rejected = false) {
    const replica = replicaForId(sourceCollaboratorId, true);
    const epoch = positiveInteger(body?.epoch, "epoch");
    if (epoch !== replica.epoch) {
      throw new HttpError(409, "mobile_replica.epoch_stale", "mobile collaborator execution epoch is stale");
    }
    const deliveryId = validatedId(body?.deliveryId, "delivery");
    const delivery = records.get("deliveries", sourceCollaboratorId, epoch, deliveryId);
    if (!delivery) throw new HttpError(404, "mobile_delivery.unknown", "unknown mobile collaborator delivery");
    if (!delivery.acknowledgedAt && !delivery.rejectedAt) {
      if (rejected) delivery.rejectedAt = now();
      else delivery.acknowledgedAt = now();
    }
    records.put("deliveries", delivery);
    records.retireContinuation(sourceCollaboratorId, epoch, replica.revision);
    saveLedger();
    return { schema: rejected ? "aru.selfhost.mobile-collaborator-delivery-rejection.v1" : DELIVERY_ACK_SCHEMA, deliveryId };
  }

  function selfTools() {
    return [
      {
        name: "aru_mobile_replica_list",
        title: "可读取的手机协作者",
        description: "列出当前电脑协作者被明确授权只读查看的手机协作者副本。",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: "aru_mobile_replica_read",
        title: "读取手机协作者副本",
        description: "只读查看一位已授权手机协作者的身份和对话上下文；不会修改对方。记忆与长期资料通过独立的 aru_phone_memory_read 查阅权限读取。",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["sourceCollaboratorId"],
          properties: { sourceCollaboratorId: { type: "string" } },
        },
        annotations: { readOnlyHint: true },
      },
    ];
  }

  function callSelfTool(name, args, _device, collaborator) {
    if (name.startsWith("aru_mobile_replica_")) recoverStorage();
    if (name === "aru_mobile_replica_list") {
      return {
        matched: true,
        value: ledger.replicas
          .filter((item) => item.readerHostCollaboratorIds.includes(collaborator.collaboratorId))
          .map((item) => ({
            sourceCollaboratorId: item.sourceCollaboratorId,
            displayName: item.displayName,
            revision: item.revision,
            updatedAt: item.updatedAt,
          })),
      };
    }
    if (name === "aru_mobile_replica_read") {
      const replica = replicaForId(validatedId(args?.sourceCollaboratorId, "source collaborator"), true);
      if (!replica.readerHostCollaboratorIds.includes(collaborator.collaboratorId)) {
        throw new HttpError(403, "mobile_replica.read_forbidden", "this computer collaborator cannot read that mobile collaborator");
      }
      return { matched: true, value: publicReadableReplica(replica) };
    }
    return { matched: false, value: null };
  }

  let reconciliationNeeded = false;
  function recoverStorage() {
    if (records.recover()) reconciliationNeeded = true;
    if (!reconciliationNeeded) return;
    // Transactions are replayed, never model/tool calls. A running receipt with
    // no live attempt must be reconciled against conversation evidence.
    for (const execution of records.running()) {
      const key = executionKey(execution.sourceCollaboratorId, execution.epoch, execution.deliveryId);
      if (activeExecutions.has(key) || unstartedAdmissions.has(key)) continue;
      const event = recoverDelivery(execution.sourceCollaboratorId, execution.deliveryId, execution.epoch);
      if (event) {
        if (!recoveryEvents.some(item => item.turn.deliveryId === execution.deliveryId
            && item.turn.sourceCollaboratorId === execution.sourceCollaboratorId
            && item.turn.executionEpoch === execution.epoch)) recoveryEvents.push(event);
      } else {
        execution.state = "uncertain";
        execution.failure = "Execution admission was interrupted; this occurrence will not be replayed";
        execution.updatedAt = now();
        records.put("executions", execution);
        const replica = replicaForId(execution.sourceCollaboratorId, false);
        const rule = replica?.epoch === execution.epoch
          ? replica.rules.find(item => item.inFlightDeliveryId === execution.deliveryId) : null;
        if (rule) { rule.inFlightDeliveryId = null; rule.inFlightRuleVersion = null; }
      }
    }
    saveLedger();
    reconciliationNeeded = false;
  }

  async function drainRecovery() {
    while (recoveryEvents.length) {
      await settle(recoveryEvents[0], false);
      recoveryEvents.shift();
    }
  }

  async function start() {
    started = true;
    try { recoverStorage(); await drainRecovery(); }
    catch (error) { log(`mobile collaborator recovery pending: ${error?.message ?? error}`); }
    schedule();
    for (const id of new Set((ledger.mcpCleanup ?? []).map(item => item.sourceCollaboratorId))) {
      void serialized(id, () => cleanupMCP(id)).catch(() => {});
    }
  }

  function stop() {
    started = false;
    if (timer) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    if (!started) return;
    if (timer) clearTimer(timer);
    timer = null;
    if (records.needsRecovery() || reconciliationNeeded || recoveryEvents.length || unstartedAdmissions.size) {
      timer = setTimer(() => { void runDue(); }, 5_000);
      return;
    }
    const nextFireAt = ledger.replicas.filter((replica) => !executionRevoked(replica.sourceCollaboratorId, replica.epoch)).flatMap((replica) => (replica.rules ?? [])
      .filter((rule) => rule.enabled && rule.nextFireAt && !rule.inFlightDeliveryId)
      .map((rule) => rule.nextFireAt)).sort((left, right) => left - right)[0];
    if (!nextFireAt) return;
    timer = setTimer(() => { void runDue(); }, Math.min(Math.max(0, nextFireAt - now()), 2_147_000_000));
  }

  function runDue() {
    if (dueAttempt) return dueAttempt;
    const wasStarted = started;
    dueAttempt = Promise.resolve().then(async () => {
      try {
        recoverStorage(); await drainRecovery();
        if (wasStarted && !started) return;
        await runDueWork();
      } catch (error) { log(`mobile collaborator scheduling will retry after storage recovery: ${error?.message ?? error}`); }
      finally { dueAttempt = undefined; schedule(); }
    });
    return dueAttempt;
  }

  async function runDueWork() {
    timer = null;
    for (const [key, admission] of unstartedAdmissions) {
      const replica = replicaForId(admission.source, false);
      const rule = replica?.epoch === admission.epoch
        ? replica.rules.find(item => item.inFlightDeliveryId === admission.id) : null;
      if (rule && !executionRevoked(admission.source, admission.epoch)) {
        dispatchAdmission(replica, rule, admission.id);
      } else unstartedAdmissions.delete(key);
    }
    const due = [];
    const timestamp = now();
    for (const replica of ledger.replicas) {
      if (executionRevoked(replica.sourceCollaboratorId, replica.epoch)) continue;
      for (const rule of replica.rules ?? []) {
        if (rule.enabled && rule.nextFireAt && rule.nextFireAt <= timestamp
            && !rule.inFlightDeliveryId) {
          due.push({ replica, rule });
        }
      }
    }
    for (const { replica, rule } of due) {
      const deliveryId = `mobiledelivery_${randomUUID()}`;
      rule.inFlightDeliveryId = deliveryId;
      rule.inFlightRuleVersion = rule.sourceVersion;
      rule.lastFiredAt = rule.nextFireAt;
      records.put("executions", executionRecord(replica, rule, deliveryId));
      advanceRule(rule, timestamp);
      unstartedAdmissions.set(executionKey(replica.sourceCollaboratorId, replica.epoch, deliveryId),
        { source: replica.sourceCollaboratorId, epoch: replica.epoch, id: deliveryId });
      saveLedger();
      dispatchAdmission(replica, rule, deliveryId);
    }
    schedule();
  }

  function dispatchAdmission(replica, rule, deliveryId) {
    unstartedAdmissions.delete(executionKey(replica.sourceCollaboratorId, replica.epoch, deliveryId));
    try {
      const executor = collaboratorForId(replica.executorHostCollaboratorId);
      activeExecutions.add(executionKey(replica.sourceCollaboratorId, replica.epoch, deliveryId));
      trigger(executor, replicaContinuingOwnDeliveries(replica, rule), rule, deliveryId);
    } catch (error) {
      activeExecutions.delete(executionKey(replica.sourceCollaboratorId, replica.epoch, deliveryId));
      rule.inFlightDeliveryId = null;
      rule.inFlightRuleVersion = null;
      const execution = records.get("executions", replica.sourceCollaboratorId, replica.epoch, deliveryId);
      execution.state = "uncertain";
      execution.failure = String(error?.message ?? error);
      execution.updatedAt = now();
      records.put("executions", execution);
      log(`mobile collaborator proactive trigger failed: ${error?.message ?? error}`);
      saveLedger();
    }
  }

  // While the phone has not uploaded a replica that includes the Host's own
  // earlier deliveries (it may be offline for hours), the next turn continues
  // from them instead of from a context where they never happened. They carry
  // the id the phone imports them under, so the phone still appends each
  // delivery right after the previous one.
  function replicaContinuingOwnDeliveries(replica, rule) {
    if (!rule.conversationId) return replica;
    const pending = records.continuation(replica.sourceCollaboratorId, replica.epoch, rule.conversationId, MAX_CONTINUED_DELIVERIES)
      .filter(delivery => !deliveryReflectedInReplica(delivery, replica));
    pending.sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) return replica;
    return {
      ...replica,
      conversations: replica.conversations.map((conversation) => {
        if (conversation.conversationId !== rule.conversationId) return conversation;
        const known = new Set(conversation.messages.map((message) => message.messageId));
        const continued = pending
          .map((delivery) => ({
            messageId: `hostmessage_${delivery.deliveryId}`,
            role: "assistant",
            content: delivery.assistantContent,
            createdAt: delivery.createdAt,
            updatedAt: delivery.createdAt,
          }))
          .filter((message) => !known.has(message.messageId));
        if (continued.length === 0) return conversation;
        const messages = [...conversation.messages, ...continued];
        return { ...conversation, messages, baseMessageId: messages.at(-1).messageId };
      }),
    };
  }

  function deliveryReflectedInReplica(delivery, replica) {
    // Deliveries recorded before replicaRevision existed fall back to acknowledgement.
    if (Number.isSafeInteger(delivery.replicaRevision)) return replica.revision > delivery.replicaRevision;
    return Boolean(delivery.acknowledgedAt);
  }

  async function settle(event, notify = true) {
    if (event?.turn?.source !== "mobile-replica-proactive") return false;
    activeExecutions.delete(executionKey(event.turn.sourceCollaboratorId, event.turn.executionEpoch, event.turn.deliveryId));
    recoverStorage();
    const replica = replicaForId(event.turn.sourceCollaboratorId, false);
    const rule = replica?.rules?.find((candidate) => candidate.ruleId === event.turn.ruleId);
    if (!replica || replica.epoch !== event.turn.executionEpoch || executionRevoked(replica.sourceCollaboratorId, replica.epoch)) return true;
    const execution = records.get("executions", replica.sourceCollaboratorId, replica.epoch, event.turn.deliveryId);
    if (execution) {
      if (execution.state !== "running" && !(notify === false && execution.state === "uncertain")) return true;
    } else if (!rule || rule.inFlightDeliveryId !== event.turn.deliveryId) return true;
    if (execution) {
      execution.state = event.outcome === "completed" ? "completed" : event.outcome === "failed" ? "failed" : "uncertain";
      execution.content = String(event.assistantMessage?.content ?? "").trim() || null;
      execution.failure = event.failure ?? null;
      execution.updatedAt = now();
      records.put("executions", execution);
    }
    const executedRuleVersion = execution?.ruleVersion ?? event.turn.ruleVersion ?? rule?.inFlightRuleVersion ?? rule?.sourceVersion;
    if (rule?.inFlightDeliveryId === event.turn.deliveryId) {
      rule.inFlightDeliveryId = null;
      rule.inFlightRuleVersion = null;
    }
    if (event.outcome === "completed") {
      const assistantContent = assistantDeliveryContent(event.assistantMessage?.content);
      if (assistantContent) {
        const delivery = {
          schema: DELIVERY_SCHEMA,
          deliveryId: event.turn.deliveryId,
          sourceCollaboratorId: replica.sourceCollaboratorId,
          epoch: replica.epoch,
          ruleId: event.turn.ruleId,
          ruleVersion: executedRuleVersion,
          sourceConversationId: event.turn.sourceConversationId ?? null,
          baseMessageId: event.turn.baseMessageId ?? null,
          basisMessages: validatedContextMessages(event.turn.basisMessages),
          assistantContent,
          createdAt: now(),
          replicaRevision: replica.revision,
          acknowledgedAt: null,
        };
        if (!records.get("deliveries", replica.sourceCollaboratorId, replica.epoch, delivery.deliveryId)) {
          records.put("deliveries", delivery);
        }
        saveLedger();
        // The durable delivery is authoritative; notification is only a hint.
        // Finish scheduling before waiting on a transport that may be offline.
        schedule();
        try {
          if (notify) await onDelivery({ ...event, mobileDelivery: publicDelivery(delivery), mobileReplica: replica });
        } catch {
          log("mobile collaborator delivery saved; notification failed, phone can fetch it later");
        }
      }
    }
    saveLedger();
    schedule();
    return true;
  }

  function advanceRule(rule, timestamp) {
    if (rule.scheduleKind === "interval" && rule.recurrenceMinutes > 0) {
      const interval = rule.recurrenceMinutes * 60 * 1000;
      const elapsed = Math.max(0, timestamp - rule.nextFireAt);
      rule.nextFireAt += (Math.floor(elapsed / interval) + 1) * interval;
    } else if (rule.scheduleKind === "daily") {
      rule.nextFireAt = nextDailyFireAt(
        rule.dailyTimeMinutes,
        rule.scheduleTimeZoneIdentifier,
        timestamp,
      );
    } else {
      rule.nextFireAt = null;
      rule.enabled = false;
    }
  }

  function executionRevoked(sourceCollaboratorId, epoch) {
    return ledger.revokedExecutions.some((item) => item.sourceCollaboratorId === sourceCollaboratorId && epoch <= item.epoch);
  }

  function saveLedger() {
    try { records.commit(ledger); }
    catch (error) { schedule(); throw error; }
  }

  function replicaForId(sourceCollaboratorId, required) {
    const value = ledger.replicas.find((item) => item.sourceCollaboratorId === sourceCollaboratorId) ?? null;
    if (!value && required) throw new HttpError(404, "mobile_replica.unknown", "unknown mobile collaborator replica");
    return value;
  }

  function admittedReplica(collaborator) {
    recoverStorage();
    const replica = replicaForId(collaborator.mobileSourceId, true);
    if (collaborator.mobileRuleId) {
      const rule = replica.rules.find(item => item.ruleId === collaborator.mobileRuleId);
      if (!rule || JSON.stringify([...(rule.mcpServerIds ?? [])].sort()) !== JSON.stringify([...(collaborator.mobileMCPServerIds ?? [])].sort())) {
        throw new Error("This conversation's MCP selection changed. Start a new task using the current selection.");
      }
    }
    if (executionRevoked(replica.sourceCollaboratorId, collaborator.mobileEpoch)
        || replica.epoch !== collaborator.mobileEpoch
        || replica.executorHostCollaboratorId !== collaborator.executorCollaboratorId
        || replica.mcp?.fingerprint !== collaborator.mobileMCPFingerprint) {
      throw new Error("MCP delegation changed or was revoked. Start a new task with the current configuration.");
    }
    return replica;
  }
  return { route, selfTools, callSelfTool, start, stop, settle, runDue,
    mcpTools(collaborator, signal) {
      const replica = admittedReplica(collaborator);
      return mcp.catalog(replica, signal, () => admittedReplica(collaborator), collaborator.mobileMCPServerIds);
    },
    callMCP(name, args, collaborator, context) {
      const replica = admittedReplica(collaborator);
      if (context.tool?.mobileMCP && !collaborator.mobileMCPServerIds?.includes(context.tool.mobileMCP.serverId)) throw new Error("MCP connection is outside this conversation's scope");
      return mcp.call(replica, name, args, context, () => admittedReplica(collaborator));
    },
    hasExecutionGrant(collaboratorId) {
      recoverStorage();
      return ledger.replicas.some((replica) => replica.executorHostCollaboratorId === collaboratorId
        && !ledger.revokedExecutions.some((entry) => entry.sourceCollaboratorId === replica.sourceCollaboratorId && entry.epoch >= replica.epoch));
    },
  };
}

function publicReceipt(replica) {
  return {
    schema: RECEIPT_SCHEMA,
    sourceCollaboratorId: replica.sourceCollaboratorId,
    epoch: replica.epoch,
    revision: replica.revision,
    mcpVersion: 1,
  };
}

function publicDelivery(delivery) {
  const { acknowledgedAt: _, replicaRevision: __, rejectedAt: ___, ...value } = delivery;
  return value;
}

function publicReadableReplica(replica) {
  return {
    schema: REPLICA_SCHEMA,
    sourceCollaboratorId: replica.sourceCollaboratorId,
    displayName: replica.displayName,
    systemPrompt: replica.systemPrompt,
    conversations: replica.conversations,
    revision: replica.revision,
    generatedAt: replica.generatedAt,
  };
}

function validatedId(value, field) {
  const text = String(value ?? "").trim();
  if (!ID.test(text)) throw new Error(`${field} id is invalid`);
  return text;
}

function uniqueIds(value) {
  if (!Array.isArray(value)) throw new Error("readerHostCollaboratorIds must be an array");
  return [...new Set(value.map((item) => validatedId(item, "reader collaborator")))];
}

function requiredText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a nonnegative integer`);
  return value;
}

function validatedRecords(value) {
  if (!Array.isArray(value)) throw new Error("records must be an array");
  return value.map((item) => ({
    title: String(item?.title ?? ""),
    content: String(item?.content ?? ""),
  }));
}

function validatedConversations(value) {
  if (!Array.isArray(value)) throw new Error("conversations must be an array");
  return value.map((item) => {
    const messages = validatedContextMessages(item?.messages);
    const baseMessageId = item?.baseMessageId ? validatedMessageId(item.baseMessageId) : null;
    if (baseMessageId !== (messages.at(-1)?.messageId ?? null)) {
      throw new Error("baseMessageId must identify the final context message");
    }
    return {
      conversationId: validatedId(item?.conversationId, "conversation"),
      title: String(item?.title ?? ""),
      baseMessageId,
      messages,
    };
  });
}

// Phone message identities are opaque references, never filesystem components.
// Preserve them exactly so the returned basis still names the phone's durable row.
function validatedMessageId(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("message id is invalid");
  return value;
}

function validatedContextMessages(value) {
  if (!Array.isArray(value)) throw new Error("context messages must be an array");
  return value.map((message) => ({
    messageId: validatedMessageId(message?.messageId),
    role: validatedContextRole(message?.role),
    content: String(message?.content ?? ""),
    createdAt: positiveInteger(message?.createdAt, "message.createdAt"),
    updatedAt: positiveInteger(message?.updatedAt, "message.updatedAt"),
  }));
}

function validatedContextRole(value) {
  const role = String(value ?? "user");
  if (!["user", "assistant", "tool", "system"].includes(role)) {
    throw new Error("context message role is invalid");
  }
  return role;
}

function validatedRules(value, current, epoch) {
  if (!Array.isArray(value)) throw new Error("rules must be an array");
  return value.map((item) => {
    const ruleId = validatedId(item?.ruleId, "rule");
    const previous = current?.epoch === epoch
      ? current.rules?.find((candidate) => candidate.ruleId === ruleId)
      : null;
    const sourceUpdatedAt = positiveInteger(item?.updatedAt, "rule.updatedAt");
    const sourceVersion = requiredText(item?.sourceVersion, "rule.sourceVersion");
    const preservesHostSettlement = previous?.sourceVersion === sourceVersion;
    const conversationId = item?.conversationId
      ? validatedId(item.conversationId, "conversation")
      : null;
    const conversationMode = ["follow_latest", "fixed"].includes(item?.conversationMode)
      ? item.conversationMode
      : (conversationId ? "fixed" : "follow_latest");
    const recurrenceMinutes = item?.recurrenceMinutes == null
      ? null
      : positiveInteger(item.recurrenceMinutes, "recurrenceMinutes");
    const scheduleKind = ["one_time", "daily", "interval"].includes(item?.scheduleKind)
      ? item.scheduleKind
      : (recurrenceMinutes ? "interval" : "one_time");
    const dailyTimeMinutes = item?.dailyTimeMinutes == null
      ? null
      : nonnegativeInteger(item.dailyTimeMinutes, "dailyTimeMinutes");
    const scheduleTimeZoneIdentifier = item?.scheduleTimeZoneIdentifier == null
      ? null
      : requiredText(item.scheduleTimeZoneIdentifier, "scheduleTimeZoneIdentifier");
    if (dailyTimeMinutes != null && dailyTimeMinutes >= 1440) {
      throw new Error("dailyTimeMinutes must identify one minute in a day");
    }
    if (scheduleKind === "interval" && !recurrenceMinutes) {
      throw new Error("interval schedule requires recurrenceMinutes");
    }
    if (scheduleKind === "daily" && (dailyTimeMinutes == null || !scheduleTimeZoneIdentifier)) {
      throw new Error("daily schedule requires local time and time zone");
    }
    let nextFireAt = item?.nextFireAt == null ? null : positiveInteger(item.nextFireAt, "nextFireAt");
    if (nextFireAt != null && previous?.lastFiredAt != null && nextFireAt <= previous.lastFiredAt) {
      if (scheduleKind === "daily") nextFireAt = nextDailyFireAt(dailyTimeMinutes, scheduleTimeZoneIdentifier, previous.lastFiredAt);
      else if (scheduleKind === "interval") {
        const interval = recurrenceMinutes * 60_000;
        nextFireAt += (Math.floor((previous.lastFiredAt - nextFireAt) / interval) + 1) * interval;
      } else nextFireAt = null;
    }
    return {
      ruleId,
      mcpServerIds: Array.isArray(item.mcpServerIds) ? uniqueIds(item.mcpServerIds) : [],
      conversationMode,
      conversationId,
      title: String(item?.title ?? ""),
      goal: String(item?.goal ?? ""),
      instructions: String(item?.instructions ?? ""),
      nextFireAt: preservesHostSettlement
        ? previous.nextFireAt
        : nextFireAt,
      scheduleKind,
      recurrenceMinutes,
      dailyTimeMinutes,
      scheduleTimeZoneIdentifier,
      notificationsEnabled: item?.notificationsEnabled === true,
      enabled: preservesHostSettlement ? previous.enabled : item?.enabled === true && !(item?.nextFireAt != null && nextFireAt == null),
      sourceUpdatedAt,
      sourceVersion,
      lastFiredAt: previous?.lastFiredAt ?? null,
      inFlightRuleVersion: previous?.inFlightRuleVersion ?? (previous?.inFlightDeliveryId ? previous.sourceVersion : null),
      inFlightDeliveryId: previous?.inFlightDeliveryId ?? null,
      inFlightRuleVersion: previous?.inFlightRuleVersion
        ?? (previous?.inFlightDeliveryId ? previous.sourceVersion : null),
    };
  });
}

function nextDailyFireAt(dailyTimeMinutes, timeZoneIdentifier, after) {
  const hour = Math.floor(dailyTimeMinutes / 60);
  const minute = dailyTimeMinutes % 60;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZoneIdentifier,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const partsAt = (timestamp) => Object.fromEntries(
    formatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const local = partsAt(after);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  for (let dayOffset = 0; dayOffset < 4; dayOffset += 1) {
    const targetDate = new Date(localDate.getTime() + dayOffset * 86_400_000);
    const target = {
      year: targetDate.getUTCFullYear(),
      month: targetDate.getUTCMonth() + 1,
      day: targetDate.getUTCDate(),
      hour,
      minute,
    };
    let candidate = Date.UTC(target.year, target.month - 1, target.day, hour, minute);
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const actual = partsAt(candidate);
      const targetWall = Date.UTC(target.year, target.month - 1, target.day, hour, minute);
      const actualWall = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
      candidate += targetWall - actualWall;
    }
    const actual = partsAt(candidate);
    const matches = actual.year === target.year && actual.month === target.month
      && actual.day === target.day && actual.hour === hour && actual.minute === minute;
    if (matches && candidate > after) return candidate;
  }
  throw new Error("daily schedule could not resolve its next wall-clock occurrence");
}

function requestEpoch(urlString) {
  const epoch = Number(new URL(urlString, "http://aru.local").searchParams.get("epoch"));
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("epoch query is required");
  return epoch;
}

// Public transport compatibility: pre-0.31 fixed-file installers already fetch
// this module. Artifact identity remains a separate factory and state owner.

// Host-owned artifact identities. These are not computer cognition roots or
// execution replicas. Pairing authorizes management of this node; a phone's
// durable collaborator UUID survives device re-pairing and display-name edits.
export function createMobileCollaboratorIdentityHost({ state, saveState, readJSONBody, sendJSON, HttpError, now = Date.now }) {
  state.mobileCollaboratorIdentities ??= [];
  const schema = "aru.selfhost.mobile-collaborator-identity.v1";
  function inventory() { return state.mobileCollaboratorIdentities.map((item) => ({ ...item })); }
  function ownerForId(id) { return state.mobileCollaboratorIdentities.find((item) => item.collaboratorId === id); }
  async function route(req, res, path, requireDevice) {
    const match = path.match(/^\/aru\/v1\/mobile-collaborator-identities\/([^/]+)$/);
    if (!match || req.method !== "PUT") return false;
    const device = requireDevice();
    let sourceCollaboratorId;
    try { sourceCollaboratorId = decodeURIComponent(match[1]); }
    catch { throw new HttpError(400, "mobile_identity.source_invalid", "invalid collaborator UUID encoding"); }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sourceCollaboratorId)) {
      throw new HttpError(400, "mobile_identity.source_invalid", "a durable phone collaborator UUID is required");
    }
    const body = await readJSONBody(req, 64 * 1024);
    requireDevice(); // A revoked pairing cannot commit after a suspended body read.
    if (typeof body?.displayName !== "string" || !body.displayName.trim()) {
      throw new HttpError(400, "mobile_identity.name_invalid", "a display name is required");
    }
    // Lookup after the await: simultaneous first requests must converge on one owner.
    let identity = state.mobileCollaboratorIdentities.find((item) =>
      item.sourceCollaboratorId.toLowerCase() === sourceCollaboratorId.toLowerCase());
    const displayName = body.displayName.trim();
    if (!identity) {
      identity = { schema, sourceCollaboratorId, collaboratorId: `hostcol_${randomUUID()}`,
        displayName, authority: "phone", turnExecution: false,
        createdAt: now(), updatedAt: now(), createdByDeviceId: device.deviceId };
      state.mobileCollaboratorIdentities.push(identity);
      try { saveState(); }
      catch (error) { state.mobileCollaboratorIdentities.pop(); throw error; }
    } else if (identity.displayName !== displayName) {
      const previous = { displayName: identity.displayName, updatedAt: identity.updatedAt };
      identity.displayName = displayName;
      identity.updatedAt = now();
      try { saveState(); }
      catch (error) { Object.assign(identity, previous); throw error; }
    }
    sendJSON(res, 200, { ...identity, sourceCollaboratorId });
    return true;
  }
  return { route, inventory, ownerForId };
}
