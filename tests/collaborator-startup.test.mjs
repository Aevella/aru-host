import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollaboratorHost } from "../collaborator-host.mjs";

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

test("startup settlement disk failure is contained and durable evidence survives restart", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "aru-startup-failure-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "mobile-collaborator-replicas");
  const path = join(folder, "ledger.json");
  mkdirSync(folder);
  const turn = { source: "mobile-replica-proactive", sourceCollaboratorId: "phone", executionEpoch: 1,
    deliveryId: "delivery", ruleId: "rule", ruleVersion: "v1", basisMessages: [] };
  writeFileSync(path, JSON.stringify({ replicas: [{ sourceCollaboratorId: "phone", epoch: 1, revision: 1,
    rules: [{ ruleId: "rule", inFlightDeliveryId: "delivery", inFlightRuleVersion: "v1", enabled: false }] }],
    deliveries: [], executions: [{ sourceCollaboratorId: "phone", epoch: 1, deliveryId: "delivery",
      ruleId: "rule", ruleVersion: "v1", state: "running" }] }));
  const logs = [];
  const options = { dataDir: root, managedWorkspaceRoot: root, state: {}, saveState() {},
    readJSONBody: async (req) => req.body, sendJSON(res, status, body) { res.status = status; res.body = body; },
    HttpError, log: (line) => logs.push(line),
    probeLocalDriver: (definition) => ({ id: definition.id, status: "unavailable", checkedAt: Date.now() }),
    conversationHostFactory: () => ({
      recoverReplicaDelivery: () => ({ turn, outcome: "completed", assistantMessage: { content: "saved reply" } }),
      runReplicaProactive: () => assert.fail("recovery must not replay"),
      route: async () => false,
      status: () => ({ conversationCount: 0, activeTurnCount: 0, pendingApprovalCount: 0 }),
    }),
  };
  let host = createCollaboratorHost(options);
  context.after(() => host.stop());
  const durable = readFileSync(path);
  // Force rename failure after construction, while startup is settling its saved result.
  rmSync(path); mkdirSync(path);
  await host.start();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EISDIR|ENOTDIR|EEXIST/);
  assert.match(logs[0], /startup recovery failed; scheduling stopped until Host restart/);
  const response = {};
  await host.route({ method: "GET" }, response, "/aru/v1/agent-drivers", () => ({}));
  assert.equal(response.status, 200);
  host.stop();
  rmSync(path, { recursive: true }); writeFileSync(path, durable);
  host = createCollaboratorHost(options);
  await host.start(); host.stop();
  const recovered = JSON.parse(readFileSync(path));
  assert.equal(recovered.deliveries.length, 1);
  assert.equal(recovered.deliveries[0].assistantContent, "saved reply");
  assert.equal(recovered.executions[0].state, "completed");
});
