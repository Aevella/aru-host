import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReplicaRecordStore } from '../src/host/replica-record-store.mjs';
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'aru-receipts-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
const record = (id, state = 'completed') => ({ sourceCollaboratorId: 'phone', epoch: 1, deliveryId: `delivery_${id}`, createdAt: id, state, content: 'saved paid result '.repeat(100) });
test('legacy migration preserves every body and receipt and retires the old writer', t => {
  const root = fixture(t);
  const legacy = { replicas: [], executions: [record(1)], deliveries: [{ ...record(2), assistantContent: 'original', acknowledgedAt: 3 }] };
  const bytes = JSON.stringify(legacy); writeFileSync(join(root, 'ledger.json'), bytes);
  let store = createReplicaRecordStore(root);
  assert.equal(readFileSync(join(root, 'ledger.v1.backup.json'), 'utf8'), bytes);
  assert.throws(() => JSON.parse(readFileSync(join(root, 'ledger.json'))));
  assert.deepEqual(store.get('executions', 'phone', 1, 'delivery_1'), legacy.executions[0]);
  assert.equal(store.pending('deliveries', 'phone', 1).length, 0);
  assert.equal(store.get('deliveries', 'phone', 1, 'delivery_2').assistantContent, 'original');
  store = createReplicaRecordStore(root);
  assert.equal(store.indexed('executions', 'phone', 1).length, 1);
});
for (const point of ['after-journal', 'after-publication']) test(`restart replays durable storage transaction at ${point} without duplicate records`, t => {
  const root = fixture(t); let armed = false;
  let store = createReplicaRecordStore(root, { fault: p => { if (armed && p === point) throw new Error('crash'); } });
  const item = record(1, 'running'); store.put('executions', item); armed = true;
  assert.throws(() => store.commit({ ...store.ledger, marker: 'admitted' }), /crash/);
  assert.throws(() => store.pending('deliveries', 'phone', 1), /restart/);
  store = createReplicaRecordStore(root);
  assert.equal(store.ledger.marker, 'admitted');
  assert.deepEqual(store.running(), [item]);
  store.commit(store.ledger);
  assert.equal(createReplicaRecordStore(root).indexed('executions', 'phone', 1).length, 1);
});
test('interrupted migration resumes from untouched backup', t => {
  const root = fixture(t); const before = JSON.stringify({ replicas: [], executions: [record(1)], deliveries: [] });
  writeFileSync(join(root, 'ledger.json'), before);
  assert.throws(() => createReplicaRecordStore(root, { fault: () => { throw new Error('migration crash'); } }), /migration crash/);
  assert.equal(readFileSync(join(root, 'ledger.v1.backup.json'), 'utf8'), before);
  assert.equal(createReplicaRecordStore(root).indexed('executions', 'phone', 1).length, 1);
});
test('history bodies are paged and scheduler saves do not rewrite old records', t => {
  const root = fixture(t); let store = createReplicaRecordStore(root);
  for (let i = 1; i <= 120; i++) store.put('executions', record(i));
  store.commit(store.ledger);
  const file = join(root, 'records-v2/executions/phone/1/delivery_1.json');
  const inode = statSync(file).ino; let bodyReads = 0;
  store = createReplicaRecordStore(root, { onRead: path => { if (path.includes('/executions/')) bodyReads++; } });
  assert.equal(bodyReads, 0);
  const page = store.indexed('executions', 'phone', 1, { limit: 51 });
  assert.equal(bodyReads, 51); assert.equal(page[0].deliveryId, 'delivery_120');
  assert.equal(store.indexed('executions', 'other', 1).length, 0);
  store.commit({ ...store.ledger, changed: true });
  assert.equal(statSync(file).ino, inode);
  assert.equal(existsSync(join(root, 'records-v2/transaction.json')), false);
  assert.equal('executions' in store.ledger, false);
});
