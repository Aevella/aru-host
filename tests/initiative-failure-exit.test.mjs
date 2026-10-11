import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaboratorInitiativeHost } from '../collaborator-initiative.mjs';

test('a lost settlement is reconciled before the next scan, without replaying the attempt', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aru-rule-closure-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const collaboratorId = 'hostcol_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  let clock = 1000, executions = 0, outcome = null;
  const host = createCollaboratorInitiativeHost({ dataDir,
    HttpError: class extends Error {}, readJSONBody: async req => req.body,
    sendJSON: (res, status, body) => { res.body = body; },
    collaboratorForId: () => ({ collaboratorId }), collaboratorIds: () => [collaboratorId],
    trigger: () => { executions++; }, executionOutcome: () => outcome, now: () => clock,
    defer: () => {},
  });
  const initial = host.initialize(collaboratorId), res = {};
  await host.route({ method: 'POST', body: { expectedRevision: initial.revision,
    title: 'test', goal: 'test', instructions: '', nextFireAt: clock,
    recurrenceMinutes: 1, enabled: true, notificationsEnabled: false } }, res,
    `/aru/v1/hosted-collaborators/${collaboratorId}/initiative`, () => ({ deviceId: 'phone' }));
  host.runDue();
  assert.equal(executions, 1);
  const rule = host.read(collaboratorId).rules[0];
  assert.equal(rule.runningAt, clock);
  outcome = { outcome: 'completed', turn: { completedAt: 1100 } };
  const repaired = host.read(collaboratorId).rules[0];
  assert.equal(repaired.runningAt, null);
  assert.equal(repaired.deliveryCount, 1);
  assert.equal(host.read(collaboratorId).rules[0].deliveryCount, 1);
  outcome = null; clock = 62000; host.runDue();
  assert.equal(executions, 2);
  // An old completion cannot release this second attempt.
  host.settle({ collaborator: { collaboratorId }, outcome: 'completed',
    turn: { ruleId: rule.ruleId, createdAt: 1000, completedAt: 1100 } });
  assert.equal(host.read(collaboratorId).rules[0].runningAt, clock);
  outcome = { outcome: 'failed', failure: 'execution disappeared' };
  assert.equal(host.read(collaboratorId).rules[0].lastFailure, 'execution disappeared');
  const persisted = JSON.parse(readFileSync(join(dataDir, 'collaborator-initiative', `${collaboratorId}.json`)));
  assert.equal(persisted.rules[0].runningAt, null);
});
