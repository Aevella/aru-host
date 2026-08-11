import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollaboratorInitiativeHost } from "../collaborator-initiative.mjs";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "aru-initiative-"));
const collaborator = {
  collaboratorId: "hostcol_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  displayName: "Example Collaborator",
};
const device = { deviceId: "phone" };
let clock = 1_000;
const triggers = [];
const host = createCollaboratorInitiativeHost({
  dataDir,
  readJSONBody: async (req) => req.body,
  sendJSON(res, status, body) { res.status = status; res.body = body; },
  HttpError,
  collaboratorForId: (id) => {
    assert.equal(id, collaborator.collaboratorId);
    return collaborator;
  },
  collaboratorIds: () => [collaborator.collaboratorId],
  trigger(owner, rule) {
    triggers.push({ owner, rule });
    return { conversationId: "hostconv_initiative" };
  },
  now: () => clock,
  defer: () => {},
});

try {
  let initiative = host.initialize(collaborator.collaboratorId);
  assert.equal(initiative.rules.length, 0);
  let response = await call("POST", rootPath(), {
    expectedRevision: initiative.revision,
    title: "来找我",
    goal: "在合适的时候主动问候",
    instructions: "说一句真实而自然的话",
    nextFireAt: clock,
    recurrenceMinutes: null,
    notificationsEnabled: true,
    enabled: true,
  });
  assert.equal(response.status, 201);
  initiative = response.body;
  const rule = initiative.rules[0];
  host.runDue();
  assert.equal(triggers.length, 1);
  assert.match(triggers[0].rule.seed, /\[proactive_seed\]/);
  initiative = host.read(collaborator.collaboratorId);
  assert.equal(initiative.rules[0].runningAt, clock);
  assert.equal(initiative.rules[0].enabled, false);
  assert.equal(initiative.rules[0].conversationId, "hostconv_initiative");

  clock += 5;
  host.settle({
    outcome: "completed",
    collaborator,
    conversation: { conversationId: "hostconv_initiative" },
    turn: { ruleId: rule.ruleId, completedAt: clock },
    assistantMessage: { content: "hello" },
  });
  initiative = host.read(collaborator.collaboratorId);
  assert.equal(initiative.rules[0].runningAt, null);
  assert.equal(initiative.rules[0].deliveryCount, 1);
  assert.equal(initiative.rules[0].lastDeliveredAt, clock);

  response = await call("POST", rootPath(), {
    expectedRevision: initiative.revision,
    title: "持续关照",
    goal: "保持联系",
    instructions: "轻轻问一句",
    nextFireAt: clock,
    recurrenceMinutes: 2,
    notificationsEnabled: true,
    enabled: true,
  });
  initiative = response.body;
  const recurring = initiative.rules[1];
  host.runDue();
  initiative = host.read(collaborator.collaboratorId);
  assert.equal(initiative.rules[1].nextFireAt, clock + 120_000);
  assert.equal(initiative.rules[1].enabled, true);
  assert.equal(initiative.rules[1].runningAt, clock);

  host.settle({
    outcome: "failed",
    failure: "provider unavailable",
    collaborator,
    conversation: { conversationId: "hostconv_initiative" },
    turn: { ruleId: recurring.ruleId, completedAt: clock },
  });
  initiative = host.read(collaborator.collaboratorId);
  assert.equal(initiative.rules[1].runningAt, null);
  assert.equal(initiative.rules[1].lastFailure, "provider unavailable");

  const recurringFirstScheduledAt = recurring.nextFireAt;
  clock = recurringFirstScheduledAt + 5 * 60_000;
  host.runDue();
  initiative = host.read(collaborator.collaboratorId);
  assert.equal(initiative.rules[1].nextFireAt, recurringFirstScheduledAt + 6 * 60_000);
  assert.equal(initiative.rules[1].runningAt, clock);

  const selfTools = host.selfTools();
  assert.deepEqual(
    selfTools.map((tool) => tool.name),
    [
      "aru_collaborator_initiative_read",
      "aru_collaborator_initiative_create",
      "aru_collaborator_initiative_update",
      "aru_collaborator_initiative_archive",
    ],
  );
  assert.equal(selfTools.every((tool) => tool.inputSchema.type === "object"), true);
  assert.equal(selfTools.every(
    (tool) => !("collaboratorId" in tool.inputSchema.properties)), true);
  assert.equal(selfTools.every((tool) => tool.outputSchema.properties.rules.type === "array"), true);

  const modelDevice = { deviceId: `hosted-collaborator:${collaborator.collaboratorId}` };
  initiative = host.callSelfTool(
    "aru_collaborator_initiative_read", {}, modelDevice, collaborator,
  ).value;
  initiative = host.callSelfTool("aru_collaborator_initiative_create", {
    expectedRevision: initiative.revision,
    title: "我想主动靠近",
    goal: "在之后主动问用户今天有没有好好吃饭",
    fireAfterMinutes: 3,
    recurrenceMinutes: 0,
  }, modelDevice, collaborator).value;
  const selfRule = initiative.rules.at(-1);
  assert.equal(selfRule.nextFireAt, clock + 180_000);
  assert.equal(selfRule.recurrenceMinutes, null);
  assert.equal(selfRule.notificationsEnabled, true);
  assert.equal(selfRule.enabled, true);
  assert.equal(selfRule.updatedByDeviceId, undefined);

  initiative = host.callSelfTool("aru_collaborator_initiative_update", {
    expectedRevision: initiative.revision,
    ruleId: selfRule.ruleId,
    fireAfterMinutes: 5,
    recurrenceMinutes: 60,
    enabled: false,
  }, modelDevice, collaborator).value;
  const updatedSelfRule = initiative.rules.find((item) => item.ruleId === selfRule.ruleId);
  assert.equal(updatedSelfRule.nextFireAt, clock + 300_000);
  assert.equal(updatedSelfRule.recurrenceMinutes, 60);
  assert.equal(updatedSelfRule.enabled, false);

  assert.throws(
    () => host.callSelfTool("aru_collaborator_initiative_update", {
      expectedRevision: initiative.revision,
      ruleId: selfRule.ruleId,
    }, modelDevice, collaborator),
    (error) => error instanceof HttpError
      && error.status === 400
      && error.code === "initiative.update_empty",
  );

  initiative = host.callSelfTool("aru_collaborator_initiative_archive", {
    expectedRevision: initiative.revision,
    ruleId: selfRule.ruleId,
    archived: true,
  }, modelDevice, collaborator).value;
  assert.ok(initiative.rules.find((item) => item.ruleId === selfRule.ruleId).archivedAt);
  initiative = host.callSelfTool("aru_collaborator_initiative_archive", {
    expectedRevision: initiative.revision,
    ruleId: selfRule.ruleId,
    archived: false,
  }, modelDevice, collaborator).value;
  assert.equal(
    initiative.rules.find((item) => item.ruleId === selfRule.ruleId).archivedAt,
    null,
  );

  assert.throws(
    () => host.callSelfTool("aru_collaborator_initiative_read", {
      collaboratorId: "hostcol_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    }, modelDevice, collaborator),
    (error) => error instanceof HttpError
      && error.status === 400
      && error.code === "initiative.owner_scope_fixed",
  );
  console.log("ARU_COLLABORATOR_INITIATIVE_SMOKE_OK");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

async function call(method, path, body) {
  const req = { method, body };
  const res = {};
  const matched = await host.route(req, res, path, () => device);
  assert.equal(matched, true);
  return res;
}

function rootPath() {
  return `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/initiative`;
}
