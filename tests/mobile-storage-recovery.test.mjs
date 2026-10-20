import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMobileCollaboratorReplicaHost } from '../mobile-collaborator-replicas.mjs';
test('failed admission ends once; storage repair resumes sibling work in the same scheduler', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-mobile-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'mobile-collaborator-replicas'); mkdirSync(folder);
  const replicas = ['first', 'sibling'].map(sourceCollaboratorId => ({ sourceCollaboratorId, epoch: 1, revision: 1,
    executorHostCollaboratorId: 'executor', conversations: [], rules: [{ ruleId: 'rule', sourceVersion: 'v1', enabled: true, nextFireAt: 1, recurrenceMinutes: null }] }));
  writeFileSync(join(folder, 'ledger.json'), JSON.stringify({ replicas, executions: [], deliveries: [] }));
  const calls = []; let callback;
  const host = createMobileCollaboratorReplicaHost({ dataDir: root, now: () => 10,
    collaboratorForId: () => ({}), trigger: (_, replica) => calls.push(replica.sourceCollaboratorId),
    setTimer: fn => { callback = fn; return 1; }, clearTimer() {} });
  t.after(() => host.stop());
  const scheduler = join(folder, 'records-v2/scheduler.json'); const original = readFileSync(scheduler);
  await host.start(); rmSync(scheduler); mkdirSync(scheduler);
  await host.runDue(); assert.deepEqual(calls, []);
  rmSync(scheduler, { recursive: true }); writeFileSync(scheduler, original);
  callback(); await host.runDue();
  assert.deepEqual(calls, ['sibling']);
  await host.runDue(); assert.deepEqual(calls, ['sibling']);
  const records = join(folder, 'records-v2/executions/first/1');
  const first = JSON.parse(readFileSync(join(records, readdirSync(records)[0])));
  assert.equal(first.state, 'uncertain');
  const saved = JSON.parse(readFileSync(scheduler));
  assert.equal(saved.replicas[0].rules[0].inFlightDeliveryId, null);
  assert.equal(saved.replicas[0].rules[0].nextFireAt, null);
});
