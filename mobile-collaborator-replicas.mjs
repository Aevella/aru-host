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

export function createMobileCollaboratorReplicaHost({
  dataDir,
  readJSONBody,
  sendJSON,
  HttpError,
  collaboratorForId,
  trigger,
  maximumRequestBytes,
  onDelivery = async () => {},
  now = Date.now,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const root = join(dataDir, "mobile-collaborator-replicas");
  const statePath = join(root, "ledger.json");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const ledger = loadLedger();
  let timer = null;
  let started = false;
  for (const replica of ledger.replicas) {
    for (const rule of replica.rules ?? []) rule.inFlightDeliveryId = null;
  }
  saveLedger();

  async function route(req, res, path, requireDevice) {
    const match = path.match(/^\/aru\/v1\/mobile-collaborator-replicas\/([^/]+)(.*)$/);
    if (!match) return false;
    const sourceCollaboratorId = validatedId(match[1], "source collaborator");
    const suffix = match[2] || "";
    requireDevice();
    if (!suffix && req.method === "PUT") {
      const body = await readJSONBody(req, maximumRequestBytes);
      sendJSON(res, 200, upsert(sourceCollaboratorId, body));
      return true;
    }
    if (suffix === "/deliveries" && req.method === "GET") {
      const epoch = requestEpoch(req.url);
      sendJSON(res, 200, deliveries(sourceCollaboratorId, epoch));
      return true;
    }
    if (suffix === "/deliveries/acknowledge" && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, acknowledge(sourceCollaboratorId, body));
      return true;
    }
    return false;
  }

  function upsert(sourceCollaboratorId, body) {
    if (body?.schema !== REPLICA_SCHEMA || body.sourceCollaboratorId !== sourceCollaboratorId) {
      throw new HttpError(400, "mobile_replica.schema_invalid", "mobile collaborator replica identity is invalid");
    }
    const epoch = positiveInteger(body.epoch, "epoch");
    const revision = nonnegativeInteger(body.revision, "revision");
    const readerIds = uniqueIds(body.readerHostCollaboratorIds);
    const executorHostCollaboratorId = validatedId(body.executorHostCollaboratorId, "executor collaborator");
    if (!readerIds.includes(executorHostCollaboratorId)) readerIds.push(executorHostCollaboratorId);
    for (const collaboratorId of readerIds) collaboratorForId(collaboratorId);
    const current = replicaForId(sourceCollaboratorId, false);
    if (current && epoch < current.epoch) {
      throw new HttpError(409, "mobile_replica.epoch_stale", "mobile collaborator execution epoch is stale");
    }
    if (current && epoch === current.epoch && revision < current.revision) {
      throw new HttpError(409, "mobile_replica.revision_stale", "mobile collaborator replica revision is stale");
    }
    if (current && epoch === current.epoch && revision === current.revision) {
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
    if (current) ledger.replicas.splice(ledger.replicas.indexOf(current), 1, value);
    else ledger.replicas.push(value);
    saveLedger();
    schedule();
    return publicReceipt(value);
  }

  function deliveries(sourceCollaboratorId, epoch) {
    const replica = replicaForId(sourceCollaboratorId, true);
    if (epoch !== replica.epoch) {
      throw new HttpError(409, "mobile_replica.epoch_stale", "mobile collaborator execution epoch is stale");
    }
    return {
      schema: DELIVERY_INVENTORY_SCHEMA,
      deliveries: ledger.deliveries
        .filter((item) => item.sourceCollaboratorId === sourceCollaboratorId
          && item.epoch === epoch && !item.acknowledgedAt)
        .sort((left, right) => left.createdAt - right.createdAt || left.deliveryId.localeCompare(right.deliveryId))
        .map(publicDelivery),
    };
  }

  function acknowledge(sourceCollaboratorId, body) {
    const replica = replicaForId(sourceCollaboratorId, true);
    const epoch = positiveInteger(body?.epoch, "epoch");
    if (epoch !== replica.epoch) {
      throw new HttpError(409, "mobile_replica.epoch_stale", "mobile collaborator execution epoch is stale");
    }
    const deliveryId = validatedId(body?.deliveryId, "delivery");
    const delivery = ledger.deliveries.find((item) => item.deliveryId === deliveryId
      && item.sourceCollaboratorId === sourceCollaboratorId && item.epoch === epoch);
    if (!delivery) throw new HttpError(404, "mobile_delivery.unknown", "unknown mobile collaborator delivery");
    delivery.acknowledgedAt ??= now();
    saveLedger();
    return { schema: DELIVERY_ACK_SCHEMA, deliveryId };
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
        description: "只读查看一位已授权手机协作者的身份、记忆、资料和对话上下文；不会修改对方。",
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

  function start() {
    started = true;
    schedule();
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
    const nextFireAt = ledger.replicas.flatMap((replica) => (replica.rules ?? [])
      .filter((rule) => rule.enabled && rule.nextFireAt && !rule.inFlightDeliveryId)
      .map((rule) => rule.nextFireAt)).sort((left, right) => left - right)[0];
    if (!nextFireAt) return;
    timer = setTimer(() => { void runDue(); }, Math.min(Math.max(0, nextFireAt - now()), 2_147_000_000));
  }

  async function runDue() {
    timer = null;
    const due = [];
    const timestamp = now();
    for (const replica of ledger.replicas) {
      for (const rule of replica.rules ?? []) {
        if (rule.enabled && rule.nextFireAt && rule.nextFireAt <= timestamp && !rule.inFlightDeliveryId) {
          due.push({ replica, rule });
        }
      }
    }
    for (const { replica, rule } of due) {
      const deliveryId = `mobiledelivery_${randomUUID()}`;
      rule.inFlightDeliveryId = deliveryId;
      advanceRule(rule, timestamp);
      saveLedger();
      try {
        const executor = collaboratorForId(replica.executorHostCollaboratorId);
        trigger(executor, replica, rule, deliveryId);
      } catch (error) {
        rule.inFlightDeliveryId = null;
        log(`mobile collaborator proactive trigger failed: ${error?.message ?? error}`);
        saveLedger();
      }
    }
    schedule();
  }

  async function settle(event) {
    if (event?.turn?.source !== "mobile-replica-proactive") return false;
    const replica = replicaForId(event.turn.sourceCollaboratorId, false);
    const rule = replica?.rules?.find((candidate) => candidate.ruleId === event.turn.ruleId);
    if (!replica || !rule || replica.epoch !== event.turn.executionEpoch
        || rule.inFlightDeliveryId !== event.turn.deliveryId) return true;
    rule.inFlightDeliveryId = null;
    if (event.outcome === "completed") {
      const assistantContent = String(event.assistantMessage?.content ?? "").trim();
      if (assistantContent) {
        const delivery = {
          schema: DELIVERY_SCHEMA,
          deliveryId: event.turn.deliveryId,
          sourceCollaboratorId: replica.sourceCollaboratorId,
          epoch: replica.epoch,
          ruleId: rule.ruleId,
          ruleVersion: rule.sourceVersion,
          sourceConversationId: event.turn.sourceConversationId ?? null,
          baseMessageId: event.turn.baseMessageId ?? null,
          basisMessages: validatedContextMessages(event.turn.basisMessages),
          assistantContent,
          createdAt: now(),
          acknowledgedAt: null,
        };
        if (!ledger.deliveries.some((item) => item.deliveryId === delivery.deliveryId)) {
          ledger.deliveries.push(delivery);
        }
        saveLedger();
        await onDelivery({ ...event, mobileDelivery: publicDelivery(delivery), mobileReplica: replica });
      }
    }
    saveLedger();
    schedule();
    return true;
  }

  function advanceRule(rule, timestamp) {
    if (rule.recurrenceMinutes > 0) {
      const interval = rule.recurrenceMinutes * 60 * 1000;
      const elapsed = Math.max(0, timestamp - rule.nextFireAt);
      rule.nextFireAt += (Math.floor(elapsed / interval) + 1) * interval;
    } else {
      rule.nextFireAt = null;
      rule.enabled = false;
    }
  }

  function loadLedger() {
    if (!existsSync(statePath)) return { schema: "aru.selfhost.mobile-collaborator-ledger.v1", replicas: [], deliveries: [] };
    try {
      const value = JSON.parse(readFileSync(statePath, "utf8"));
      value.replicas ??= [];
      value.deliveries ??= [];
      return value;
    } catch {
      throw new Error("mobile collaborator replica ledger is unreadable");
    }
  }

  function saveLedger() {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, statePath);
  }

  function replicaForId(sourceCollaboratorId, required) {
    const value = ledger.replicas.find((item) => item.sourceCollaboratorId === sourceCollaboratorId) ?? null;
    if (!value && required) throw new HttpError(404, "mobile_replica.unknown", "unknown mobile collaborator replica");
    return value;
  }

  return { route, selfTools, callSelfTool, start, stop, settle, runDue };
}

function publicReceipt(replica) {
  return {
    schema: RECEIPT_SCHEMA,
    sourceCollaboratorId: replica.sourceCollaboratorId,
    epoch: replica.epoch,
    revision: replica.revision,
  };
}

function publicDelivery(delivery) {
  const { acknowledgedAt: _, ...value } = delivery;
  return value;
}

function publicReadableReplica(replica) {
  return {
    schema: REPLICA_SCHEMA,
    sourceCollaboratorId: replica.sourceCollaboratorId,
    displayName: replica.displayName,
    systemPrompt: replica.systemPrompt,
    memories: replica.memories,
    references: replica.references,
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
    const baseMessageId = item?.baseMessageId ? validatedId(item.baseMessageId, "base message") : null;
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

function validatedContextMessages(value) {
  if (!Array.isArray(value)) throw new Error("context messages must be an array");
  return value.map((message) => ({
    messageId: validatedId(message?.messageId, "message"),
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
    return {
      ruleId,
      conversationId: item?.conversationId ? validatedId(item.conversationId, "conversation") : null,
      title: String(item?.title ?? ""),
      goal: String(item?.goal ?? ""),
      instructions: String(item?.instructions ?? ""),
      nextFireAt: preservesHostSettlement
        ? previous.nextFireAt
        : (item?.nextFireAt == null ? null : positiveInteger(item.nextFireAt, "nextFireAt")),
      recurrenceMinutes: item?.recurrenceMinutes == null ? null : positiveInteger(item.recurrenceMinutes, "recurrenceMinutes"),
      notificationsEnabled: item?.notificationsEnabled === true,
      enabled: preservesHostSettlement ? previous.enabled : item?.enabled === true,
      sourceUpdatedAt,
      sourceVersion,
      inFlightDeliveryId: previous?.inFlightDeliveryId ?? null,
    };
  });
}

function requestEpoch(urlString) {
  const epoch = Number(new URL(urlString, "http://aru.local").searchParams.get("epoch"));
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("epoch query is required");
  return epoch;
}
