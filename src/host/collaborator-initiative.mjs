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
import { join } from "node:path";

const INITIATIVE_SCHEMA = "aru.selfhost.collaborator-initiative.v1";
const RULE_PREFIX = "hostinitiative";
const COLLABORATOR_ID = /^hostcol_[A-Fa-f0-9-]+$/;
const RULE_ID = /^hostinitiative_[A-Fa-f0-9-]+$/;
const CONVERSATION_ID = /^hostconv_[A-Fa-f0-9-]+$/;
const CONVERSATION_MODES = new Set(["follow_latest", "fixed"]);
const SCHEDULE_KINDS = new Set(["one_time", "daily", "interval"]);

export function createCollaboratorInitiativeHost({
  dataDir,
  readJSONBody,
  sendJSON,
  HttpError,
  collaboratorForId,
  collaboratorIds,
  conversationExists = () => true,
  trigger,
  now = Date.now,
  defer = setImmediate,
  schedule = setInterval,
  cancelSchedule = clearInterval,
  log = () => {},
}) {
  const root = join(dataDir, "collaborator-initiative");
  let timer = null;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  recoverInterruptedAttempts();

  async function route(req, res, path, requireDevice) {
    const match = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/initiative(?:\/rules(?:\/([^/]+)(?:\/(archive|restore|run))?)?)?$/,
    );
    if (!match) return false;
    const collaborator = collaboratorForId(match[1]);
    const ruleId = match[2] ?? null;
    const action = match[3] ?? null;
    const device = requireDevice();

    if (!ruleId && req.method === "GET") {
      sendJSON(res, 200, read(collaborator.collaboratorId));
      return true;
    }
    if (!ruleId && req.method === "POST") {
      const body = await readJSONBody(req, 128 * 1024);
      sendJSON(res, 201, clientInput(() => createRule(
        collaborator.collaboratorId, body, device,
      )));
      return true;
    }
    if (ruleId && !action && req.method === "PUT") {
      const body = await readJSONBody(req, 128 * 1024);
      sendJSON(res, 200, clientInput(() => updateRule(
        collaborator.collaboratorId, ruleId, body, device,
      )));
      return true;
    }
    if (ruleId && (action === "archive" || action === "restore") && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, clientInput(() => setArchived(
        collaborator.collaboratorId, ruleId, body, device, action === "archive",
      )));
      return true;
    }
    if (ruleId && action === "run" && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 202, clientInput(() => runRuleNow(
        collaborator, ruleId, body, device,
      )));
      return true;
    }
    return false;
  }

  function initialize(collaboratorId) {
    if (existsSync(pathFor(collaboratorId))) return read(collaboratorId);
    const timestamp = now();
    const initiative = {
      schema: INITIATIVE_SCHEMA,
      collaboratorId,
      revision: 1,
      rules: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      updatedByDeviceId: null,
    };
    save(initiative);
    return publicInitiative(initiative);
  }

  function read(collaboratorId) {
    return publicInitiative(load(collaboratorId));
  }

  function createRule(collaboratorId, body, device) {
    const initiative = load(collaboratorId);
    checkRevision(initiative, body?.expectedRevision);
    const timestamp = now();
    initiative.rules.push({
      ruleId: `${RULE_PREFIX}_${randomUUID()}`,
      title: validatedText(body?.title, true, "title", 120),
      goal: validatedText(body?.goal, true, "goal", 4_000),
      instructions: validatedText(body?.instructions, true, "instructions", 16_000),
      conversationMode: validatedEnum(
        body?.conversationMode ?? "follow_latest", CONVERSATION_MODES, "conversationMode",
      ),
      conversationId: validatedOptionalConversationId(body?.conversationId),
      scheduleKind: validatedEnum(
        body?.scheduleKind ?? (body?.recurrenceMinutes ? "interval" : "one_time"),
        SCHEDULE_KINDS,
        "scheduleKind",
      ),
      nextFireAt: validatedOptionalTimestamp(body?.nextFireAt),
      recurrenceMinutes: validatedOptionalPositiveInteger(body?.recurrenceMinutes),
      dailyTimeMinutes: validatedOptionalMinuteOfDay(body?.dailyTimeMinutes),
      scheduleTimeZoneIdentifier: validatedOptionalTimeZone(body?.scheduleTimeZoneIdentifier),
      notificationsEnabled: body?.notificationsEnabled === true,
      enabled: body?.enabled !== false,
      deliveryCount: 0,
      lastAttemptAt: null,
      lastDeliveredAt: null,
      lastFailure: null,
      runningAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      updatedByDeviceId: device.deviceId,
    });
    validateRuleContent(initiative.rules.at(-1), collaboratorId);
    touch(initiative, device.deviceId);
    save(initiative);
    return publicInitiative(initiative);
  }

  function updateRule(collaboratorId, ruleId, body, device) {
    const initiative = load(collaboratorId);
    checkRevision(initiative, body?.expectedRevision);
    const rule = findRule(initiative, ruleId);
    if (rule.runningAt) {
      throw new HttpError(409, "initiative.rule_running", "running initiative rule cannot be edited");
    }
    for (const field of ["title", "goal", "instructions"]) {
      if (body?.[field] !== undefined) {
        rule[field] = validatedText(
          body[field], true, field, field === "title" ? 120 : (field === "goal" ? 4_000 : 16_000),
        );
      }
    }
    if (body?.conversationMode !== undefined) {
      rule.conversationMode = validatedEnum(
        body.conversationMode, CONVERSATION_MODES, "conversationMode",
      );
      rule.conversationId = rule.conversationMode === "fixed"
        ? validatedOptionalConversationId(body?.conversationId)
        : null;
    }
    if (body?.scheduleKind !== undefined) {
      rule.scheduleKind = validatedEnum(body.scheduleKind, SCHEDULE_KINDS, "scheduleKind");
      rule.nextFireAt = validatedOptionalTimestamp(body?.nextFireAt);
      rule.recurrenceMinutes = rule.scheduleKind === "interval"
        ? validatedOptionalPositiveInteger(body?.recurrenceMinutes)
        : null;
      rule.dailyTimeMinutes = rule.scheduleKind === "daily"
        ? validatedOptionalMinuteOfDay(body?.dailyTimeMinutes)
        : null;
      rule.scheduleTimeZoneIdentifier = rule.scheduleKind === "daily"
        ? validatedOptionalTimeZone(body?.scheduleTimeZoneIdentifier)
        : null;
    } else {
      if (body?.nextFireAt !== undefined) {
        rule.nextFireAt = validatedOptionalTimestamp(body.nextFireAt);
      }
      if (body?.recurrenceMinutes !== undefined) {
        rule.recurrenceMinutes = recurrenceFromSelfTool(body.recurrenceMinutes);
        rule.scheduleKind = rule.recurrenceMinutes ? "interval" : "one_time";
        rule.dailyTimeMinutes = null;
        rule.scheduleTimeZoneIdentifier = null;
      }
    }
    if (body?.notificationsEnabled !== undefined) {
      rule.notificationsEnabled = body.notificationsEnabled === true;
    }
    if (body?.enabled !== undefined) rule.enabled = body.enabled === true;
    validateRuleContent(rule, collaboratorId, {
      validatesTarget: body?.conversationMode !== undefined,
    });
    rule.updatedAt = now();
    rule.updatedByDeviceId = device.deviceId;
    touch(initiative, device.deviceId);
    save(initiative);
    return publicInitiative(initiative);
  }

  function setArchived(collaboratorId, ruleId, body, device, archived) {
    const initiative = load(collaboratorId);
    checkRevision(initiative, body?.expectedRevision);
    const rule = findRule(initiative, ruleId, true);
    if (rule.runningAt) {
      throw new HttpError(409, "initiative.rule_running", "running initiative rule cannot be archived");
    }
    rule.archivedAt = archived ? now() : null;
    rule.enabled = archived ? false : rule.enabled;
    rule.updatedAt = now();
    rule.updatedByDeviceId = device.deviceId;
    touch(initiative, device.deviceId);
    save(initiative);
    return publicInitiative(initiative);
  }

  function runRuleNow(collaborator, ruleId, body, device) {
    const initiative = load(collaborator.collaboratorId);
    checkRevision(initiative, body?.expectedRevision);
    const rule = findRule(initiative, ruleId);
    beginAttempt(initiative, rule, collaborator, device.deviceId, true);
    return publicInitiative(initiative);
  }

  function runDue() {
    for (const collaboratorId of collaboratorIds()) {
      let collaborator;
      let initiative;
      try {
        collaborator = collaboratorForId(collaboratorId);
        initiative = load(collaboratorId);
      } catch (error) {
        log(`initiative scan skipped ${collaboratorId}: ${safeFailure(error)}`);
        continue;
      }
      const timestamp = now();
      for (const rule of initiative.rules.filter((item) => due(item, timestamp))) {
        beginAttempt(initiative, rule, collaborator, "host-scheduler", false);
      }
    }
  }

  function beginAttempt(initiative, rule, collaborator, actorDeviceId, manual) {
    if (rule.runningAt) {
      throw new HttpError(409, "initiative.rule_running", "initiative rule is already running");
    }
    const timestamp = now();
    const scheduledAt = rule.nextFireAt ?? timestamp;
    rule.lastAttemptAt = timestamp;
    rule.lastFailure = null;
    rule.runningAt = timestamp;
    if (rule.scheduleKind === "interval") {
      const interval = rule.recurrenceMinutes * 60 * 1_000;
      const elapsed = Math.max(0, timestamp - scheduledAt);
      const elapsedIntervals = Math.floor(elapsed / interval);
      rule.nextFireAt = scheduledAt + (elapsedIntervals + 1) * interval;
      rule.enabled = true;
    } else if (rule.scheduleKind === "daily") {
      rule.nextFireAt = nextDailyFireAt(
        rule.dailyTimeMinutes,
        rule.scheduleTimeZoneIdentifier,
        timestamp,
      );
      rule.enabled = true;
    } else {
      rule.nextFireAt = null;
      rule.enabled = false;
    }
    rule.updatedAt = timestamp;
    rule.updatedByDeviceId = actorDeviceId;
    touch(initiative, actorDeviceId);
    save(initiative);
    try {
      const conversation = trigger(collaborator, {
        ...rule,
        manual,
        seed: proactiveSeed(rule),
      });
      rule.updatedAt = now();
      touch(initiative, actorDeviceId);
      save(initiative);
    } catch (error) {
      settleFailure(initiative, rule, safeFailure(error));
    }
  }

  function settle(event) {
    const ruleId = event?.turn?.ruleId;
    if (!RULE_ID.test(String(ruleId ?? ""))) return;
    let initiative;
    try { initiative = load(event.collaborator.collaboratorId); }
    catch { return; }
    const rule = initiative.rules.find((item) => item.ruleId === ruleId);
    if (!rule) return;
    if (event.outcome === "completed") {
      rule.runningAt = null;
      rule.deliveryCount += 1;
      rule.lastDeliveredAt = event.turn.completedAt ?? now();
      rule.lastFailure = null;
      rule.updatedAt = now();
      touch(initiative, null);
      save(initiative);
    } else {
      settleFailure(initiative, rule, event.failure ?? "主动回合没有完成");
    }
  }

  function settleFailure(initiative, rule, failure) {
    rule.runningAt = null;
    rule.lastFailure = failure;
    rule.updatedAt = now();
    touch(initiative, null);
    save(initiative);
  }

  function selfTools() {
    const string = (description) => ({ type: "string", description });
    const revision = {
      type: "integer",
      minimum: 1,
      description: "Revision returned by your latest initiative read or mutation.",
    };
    const ruleId = string("Existing initiative rule id from aru_collaborator_initiative_read.");
    const minutes = (description, minimum = 1) => ({
      type: "integer",
      minimum,
      description,
    });
    const operation = (name, title, description, properties, required, readOnlyHint = false) => ({
      name,
      title,
      description,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      outputSchema: initiativeOutputSchema(),
      annotations: {
        readOnlyHint,
        destructiveHint: !readOnlyHint,
        idempotentHint: readOnlyHint,
        openWorldHint: false,
      },
    });
    return [
      operation(
        "aru_collaborator_initiative_read",
        "Read my proactive message plans",
        "Read your own Host-authoritative proactive message rules, their current revision, next firing times, delivery counts, and failures. You cannot read another collaborator's rules.",
        {},
        [],
        true,
      ),
      operation(
        "aru_collaborator_initiative_create",
        "Create my proactive message plan",
        "Create one of your own durable proactive message rules. The target defaults to the conversation in which you call this tool, so do not ask the user for or invent a conversation id. The Host schedules a normal future collaborator turn; recurrenceMinutes 0 means one time, and phone notification is enabled unless notificationsEnabled is false.",
        {
          expectedRevision: revision,
          title: string("Short user-visible name for this proactive intention."),
          goal: string("What you intend to do or say proactively when the rule fires."),
          instructions: string("Optional tone, context, or judgment guidance for the future turn."),
          fireAfterMinutes: minutes("Whole minutes from now until the first firing."),
          recurrenceMinutes: minutes("Whole minutes between later firings; 0 creates a one-time rule.", 0),
          notificationsEnabled: {
            type: "boolean",
            description: "Whether a completed future reply should be delivered to registered phones. Defaults to true.",
          },
        },
        ["expectedRevision", "title", "goal", "fireAfterMinutes", "recurrenceMinutes"],
      ),
      operation(
        "aru_collaborator_initiative_update",
        "Update my proactive message plan",
        "Update or pause one of your own proactive message rules. Supply at least one mutable field. fireAfterMinutes reschedules relative to now; recurrenceMinutes 0 makes later firings one-time. This cannot edit a rule while its proactive turn is running.",
        {
          expectedRevision: revision,
          ruleId,
          title: string("Replacement user-visible name."),
          goal: string("Replacement proactive goal."),
          instructions: string("Replacement tone, context, or judgment guidance."),
          fireAfterMinutes: minutes("Whole minutes from now until the next firing."),
          recurrenceMinutes: minutes("Whole minutes between later firings; 0 means no recurrence.", 0),
          notificationsEnabled: {
            type: "boolean",
            description: "Whether completed future replies should be delivered to registered phones.",
          },
          enabled: {
            type: "boolean",
            description: "True resumes the rule; false pauses it without archiving.",
          },
        },
        ["expectedRevision", "ruleId"],
      ),
      operation(
        "aru_collaborator_initiative_archive",
        "Archive or restore my proactive message plan",
        "Archive or restore one of your own proactive message rules without deleting its history. Archiving also pauses it and cannot happen while its proactive turn is running.",
        {
          expectedRevision: revision,
          ruleId,
          archived: {
            type: "boolean",
            description: "True archives and pauses the rule; false restores it without automatically enabling it.",
          },
        },
        ["expectedRevision", "ruleId", "archived"],
      ),
    ];
  }

  function callSelfTool(name, args, device, collaborator, context = null) {
    if (!name.startsWith("aru_collaborator_initiative_")) return { matched: false };
    if (Object.prototype.hasOwnProperty.call(args ?? {}, "collaboratorId")) {
      throw new HttpError(
        400,
        "initiative.owner_scope_fixed",
        "自己的主动消息工具不能指定其他协作者",
      );
    }
    const collaboratorId = collaborator?.collaboratorId;
    if (!COLLABORATOR_ID.test(String(collaboratorId ?? ""))) {
      throw new HttpError(400, "collaborator.id_invalid", "invalid hosted collaborator id");
    }
    if (name === "aru_collaborator_initiative_read") {
      return { matched: true, value: read(collaboratorId) };
    }
    if (name === "aru_collaborator_initiative_create") {
      return {
        matched: true,
        value: createRule(
          collaboratorId,
          createBodyFromSelfTool(args, context?.conversationId),
          device,
        ),
      };
    }
    if (name === "aru_collaborator_initiative_update") {
      return {
        matched: true,
        value: updateRule(
          collaboratorId,
          String(args?.ruleId ?? ""),
          updateBodyFromSelfTool(args),
          device,
        ),
      };
    }
    if (name === "aru_collaborator_initiative_archive") {
      return {
        matched: true,
        value: setArchived(
          collaboratorId,
          String(args?.ruleId ?? ""),
          args,
          device,
          args?.archived === true,
        ),
      };
    }
    return { matched: false };
  }

  function createBodyFromSelfTool(args, currentConversationId) {
    const conversationId = validatedOptionalConversationId(currentConversationId);
    return {
      expectedRevision: args?.expectedRevision,
      title: args?.title,
      goal: args?.goal,
      instructions: args?.instructions ?? "",
      conversationMode: conversationId ? "fixed" : "follow_latest",
      conversationId,
      scheduleKind: args?.recurrenceMinutes > 0 ? "interval" : "one_time",
      nextFireAt: relativeFireAt(args?.fireAfterMinutes),
      recurrenceMinutes: recurrenceFromSelfTool(args?.recurrenceMinutes),
      notificationsEnabled: args?.notificationsEnabled !== false,
      enabled: true,
    };
  }

  function updateBodyFromSelfTool(args) {
    const body = { expectedRevision: args?.expectedRevision };
    for (const field of ["title", "goal", "instructions", "notificationsEnabled", "enabled"]) {
      if (args?.[field] !== undefined) body[field] = args[field];
    }
    if (args?.fireAfterMinutes !== undefined) {
      body.nextFireAt = relativeFireAt(args.fireAfterMinutes);
    }
    if (args?.recurrenceMinutes !== undefined) {
      body.recurrenceMinutes = recurrenceFromSelfTool(args.recurrenceMinutes);
    }
    if (Object.keys(body).length === 1) {
      throw new HttpError(
        400,
        "initiative.update_empty",
        "initiative update requires at least one mutable field",
      );
    }
    return body;
  }

  function relativeFireAt(value) {
    const minutes = validatedOptionalPositiveInteger(value);
    if (minutes === null) throw new Error("fireAfterMinutes is required");
    const timestamp = now() + minutes * 60 * 1_000;
    if (!Number.isSafeInteger(timestamp)) throw new Error("fireAfterMinutes is too large");
    return timestamp;
  }

  function recurrenceFromSelfTool(value) {
    if (value === 0) return null;
    return validatedOptionalPositiveInteger(value);
  }

  function initiativeOutputSchema() {
    const nullableInteger = { type: ["integer", "null"] };
    const nullableString = { type: ["string", "null"] };
    return {
      type: "object",
      properties: {
        schema: { type: "string", const: INITIATIVE_SCHEMA },
        collaboratorId: { type: "string" },
        revision: { type: "integer", minimum: 1 },
        rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ruleId: { type: "string" },
              title: { type: "string" },
              goal: { type: "string" },
              instructions: { type: "string" },
              conversationMode: {
                type: "string",
                enum: ["follow_latest", "fixed"],
              },
              conversationId: nullableString,
              scheduleKind: {
                type: "string",
                enum: ["one_time", "daily", "interval"],
              },
              nextFireAt: nullableInteger,
              recurrenceMinutes: nullableInteger,
              dailyTimeMinutes: nullableInteger,
              scheduleTimeZoneIdentifier: nullableString,
              notificationsEnabled: { type: "boolean" },
              enabled: { type: "boolean" },
              deliveryCount: { type: "integer", minimum: 0 },
              lastAttemptAt: nullableInteger,
              lastDeliveredAt: nullableInteger,
              lastFailure: nullableString,
              runningAt: nullableInteger,
              createdAt: { type: "integer" },
              updatedAt: { type: "integer" },
              archivedAt: nullableInteger,
            },
            required: [
              "ruleId", "title", "goal", "instructions", "conversationMode",
              "conversationId", "scheduleKind", "nextFireAt", "recurrenceMinutes",
              "dailyTimeMinutes", "scheduleTimeZoneIdentifier",
              "notificationsEnabled", "enabled", "deliveryCount",
              "lastAttemptAt", "lastDeliveredAt", "lastFailure", "runningAt", "createdAt",
              "updatedAt", "archivedAt",
            ],
            additionalProperties: false,
          },
        },
        createdAt: { type: "integer" },
        updatedAt: { type: "integer" },
      },
      required: ["schema", "collaboratorId", "revision", "rules", "createdAt", "updatedAt"],
      additionalProperties: false,
    };
  }

  function start() {
    if (timer) return;
    defer(runDue);
    timer = schedule(runDue, 15_000);
    timer?.unref?.();
  }

  function stop() {
    if (!timer) return;
    cancelSchedule(timer);
    timer = null;
  }

  function recoverInterruptedAttempts() {
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".json")) continue;
      const collaboratorId = name.slice(0, -5);
      if (!COLLABORATOR_ID.test(collaboratorId)) continue;
      let initiative;
      try { initiative = load(collaboratorId); }
      catch { continue; }
      let changed = false;
      for (const rule of initiative.rules) {
        if (!rule.runningAt) continue;
        rule.runningAt = null;
        rule.lastFailure = "Aru Host 重启中断了这次主动回合；规则没有自动重复执行";
        rule.updatedAt = now();
        changed = true;
      }
      if (changed) {
        touch(initiative, null);
        save(initiative);
      }
    }
  }

  function load(collaboratorId) {
    const path = pathFor(collaboratorId);
    if (!existsSync(path)) {
      initialize(collaboratorId);
    }
    try {
      return normalizedInitiative(JSON.parse(readFileSync(path, "utf8")), collaboratorId);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, "initiative.unreadable", "collaborator initiative is unreadable");
    }
  }

  function save(initiative) {
    const path = pathFor(initiative.collaboratorId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(initiative, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }

  function pathFor(collaboratorId) {
    if (!COLLABORATOR_ID.test(String(collaboratorId ?? ""))) {
      throw new HttpError(400, "collaborator.id_invalid", "invalid hosted collaborator id");
    }
    return join(root, `${collaboratorId}.json`);
  }

  function normalizedInitiative(value, collaboratorId) {
    if (!value || value.schema !== INITIATIVE_SCHEMA || value.collaboratorId !== collaboratorId) {
      throw new Error("invalid initiative record");
    }
    value.rules = Array.isArray(value.rules) ? value.rules.map(normalizedRule) : [];
    return value;
  }

  function normalizedRule(rule) {
    rule.title = typeof rule.title === "string" ? rule.title : "";
    rule.goal = typeof rule.goal === "string" ? rule.goal : "";
    rule.instructions = typeof rule.instructions === "string" ? rule.instructions : "";
    rule.conversationId = typeof rule.conversationId === "string" ? rule.conversationId : null;
    rule.conversationMode = CONVERSATION_MODES.has(rule.conversationMode)
      ? rule.conversationMode
      : (rule.conversationId ? "fixed" : "follow_latest");
    rule.nextFireAt = optionalTimestamp(rule.nextFireAt);
    rule.recurrenceMinutes = validatedOptionalPositiveInteger(rule.recurrenceMinutes);
    rule.scheduleKind = SCHEDULE_KINDS.has(rule.scheduleKind)
      ? rule.scheduleKind
      : (rule.recurrenceMinutes ? "interval" : "one_time");
    rule.dailyTimeMinutes = validatedOptionalMinuteOfDay(rule.dailyTimeMinutes);
    rule.scheduleTimeZoneIdentifier = validatedOptionalTimeZone(
      rule.scheduleTimeZoneIdentifier,
    );
    rule.notificationsEnabled = rule.notificationsEnabled === true;
    rule.enabled = rule.enabled === true;
    rule.deliveryCount = Number.isSafeInteger(rule.deliveryCount) ? rule.deliveryCount : 0;
    rule.lastAttemptAt = optionalTimestamp(rule.lastAttemptAt);
    rule.lastDeliveredAt = optionalTimestamp(rule.lastDeliveredAt);
    rule.lastFailure = typeof rule.lastFailure === "string" ? rule.lastFailure : null;
    rule.runningAt = optionalTimestamp(rule.runningAt);
    rule.archivedAt = optionalTimestamp(rule.archivedAt);
    return rule;
  }

  function publicInitiative(initiative) {
    return {
      schema: INITIATIVE_SCHEMA,
      collaboratorId: initiative.collaboratorId,
      revision: initiative.revision,
      rules: initiative.rules.map(({ updatedByDeviceId: _, ...rule }) => rule),
      createdAt: initiative.createdAt,
      updatedAt: initiative.updatedAt,
    };
  }

  function findRule(initiative, ruleId, includeArchived = false) {
    if (!RULE_ID.test(String(ruleId ?? ""))) throw new Error("initiative rule id is invalid");
    const rule = initiative.rules.find((item) => item.ruleId === ruleId);
    if (!rule || (!includeArchived && rule.archivedAt)) {
      throw new HttpError(404, "initiative.rule_unknown", "initiative rule does not exist");
    }
    return rule;
  }

  function checkRevision(initiative, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new HttpError(400, "initiative.expected_revision_required", "expectedRevision required");
    }
    if (initiative.revision !== expectedRevision) {
      throw new HttpError(409, "initiative.revision_conflict", "initiative changed since it was read");
    }
  }

  function touch(initiative, deviceId) {
    initiative.revision += 1;
    initiative.updatedAt = now();
    if (deviceId) initiative.updatedByDeviceId = deviceId;
  }

  function due(rule, timestamp) {
    return !rule.archivedAt && rule.enabled && !rule.runningAt
      && rule.nextFireAt !== null && rule.nextFireAt <= timestamp;
  }

  function validateRuleContent(rule, collaboratorId, { validatesTarget = true } = {}) {
    if (!rule.goal.trim() && !rule.instructions.trim()) {
      throw new Error("initiative goal or instructions is required");
    }
    if (rule.conversationMode === "fixed") {
      if (!rule.conversationId) throw new Error("fixed initiative conversation is required");
      if (validatesTarget && !conversationExists(collaboratorId, rule.conversationId)) {
        throw new Error("initiative conversation is unavailable");
      }
    } else {
      rule.conversationId = null;
    }
    if (rule.scheduleKind === "interval" && !rule.recurrenceMinutes) {
      throw new Error("interval initiative recurrenceMinutes is required");
    }
    if (rule.scheduleKind === "daily"
      && (rule.dailyTimeMinutes === null || !rule.scheduleTimeZoneIdentifier)) {
      throw new Error("daily initiative time and time zone are required");
    }
    if (rule.enabled && rule.nextFireAt === null) {
      throw new Error("enabled initiative nextFireAt is required");
    }
  }

  function proactiveSeed(rule) {
    const lines = ["[proactive_seed]", `rule_id: ${rule.ruleId}`];
    if (rule.title.trim()) lines.push(`title: ${rule.title.trim()}`);
    if (rule.goal.trim()) lines.push(`goal: ${rule.goal.trim()}`);
    if (rule.instructions.trim()) lines.push(`instructions: ${rule.instructions.trim()}`);
    lines.push("请基于这条主动消息规则给用户发起一条自然、有用、可继续的 assistant 消息。不要声称用户刚刚发来了请求；如果信息不足，先用轻量问题把下一步接起来。");
    return lines.join("\n");
  }

  function validatedText(value, allowsEmpty, field, maximumLength) {
    const text = String(value ?? "").trim();
    if (!allowsEmpty && !text) throw new Error(`${field} is required`);
    if ([...text].length > maximumLength) throw new Error(`${field} is too long`);
    return text;
  }

  function validatedOptionalTimestamp(value) {
    if (value === null || value === undefined) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("nextFireAt is invalid");
    return value;
  }

  function validatedOptionalPositiveInteger(value) {
    if (value === null || value === undefined) return null;
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("recurrenceMinutes is invalid");
    return value;
  }

  function validatedEnum(value, allowed, field) {
    if (!allowed.has(value)) throw new Error(`${field} is invalid`);
    return value;
  }

  function validatedOptionalConversationId(value) {
    if (value === null || value === undefined || value === "") return null;
    if (!CONVERSATION_ID.test(String(value))) throw new Error("conversationId is invalid");
    return String(value);
  }

  function validatedOptionalMinuteOfDay(value) {
    if (value === null || value === undefined) return null;
    if (!Number.isSafeInteger(value) || value < 0 || value >= 24 * 60) {
      throw new Error("dailyTimeMinutes is invalid");
    }
    return value;
  }

  function validatedOptionalTimeZone(value) {
    if (value === null || value === undefined || value === "") return null;
    const identifier = String(value);
    try { new Intl.DateTimeFormat("en-US", { timeZone: identifier }).format(0); }
    catch { throw new Error("scheduleTimeZoneIdentifier is invalid"); }
    return identifier;
  }

  function nextDailyFireAt(minutes, timeZone, after) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const targetHour = Math.floor(minutes / 60);
    const targetMinute = minutes % 60;
    for (let offset = 60_000; offset <= 27 * 60 * 60 * 1_000; offset += 60_000) {
      const candidate = after + offset;
      const parts = Object.fromEntries(
        formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
      );
      if (Number(parts.hour) === targetHour && Number(parts.minute) === targetMinute) {
        return candidate - (candidate % 60_000);
      }
    }
    throw new Error("could not resolve next daily initiative time");
  }

  function optionalTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function safeFailure(error) {
    return String(error?.message ?? "电脑协作者主动回合失败")
      .replace(/[\r\n\u0000]/g, " ").slice(0, 400);
  }

  function clientInput(operation) {
    try { return operation(); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "initiative.input_invalid", error.message ?? "invalid initiative input");
    }
  }

  return {
    route,
    read,
    initialize,
    settle,
    runDue,
    start,
    stop,
    selfTools,
    callSelfTool,
  };
}
