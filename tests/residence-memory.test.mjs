import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaboratorCognitionHost } from '../collaborator-cognition.mjs';
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const id = 'hostcol_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
test('bidirectional exchange is idempotent, retains conflicting edits, and propagates deletion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aru-memory-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const make = () => createCollaboratorCognitionHost({ dataDir: dir, HttpError,
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, { status, body }) });
  let host = make();
  host.initialize(id, 'isolated');
  const request = async (suffix, body) => {
    const res = {};
    assert.equal(await host.route({ method: 'POST', body }, res, `/aru/v1/hosted-collaborators/${id}/cognition/${suffix}`,
      () => ({ deviceId: 'test' }), () => ({ collaboratorId: id })), true);
    return res.body;
  };
  const exchange = changes => request('memory-sync', { schema: 'aru.residence-memory-sync.v1', changes });
  const change = { sharedId: 'phone_a', base: null, content: 'original' };
  await exchange([change]);
  host = make();
  let receipt = await exchange([change]);
  assert.equal(receipt.records.length, 1);
  assert.equal(receipt.conflicts.length, 0);
  const cognition = host.read(id);
  host.callSelfTool('aru_collaborator_memory_save', { expectedRevision: cognition.revision,
    memoryId: cognition.memories[0].memoryId, title: 'Memory', content: 'computer edit' }, { deviceId: 'host' }, { collaboratorId: id });
  receipt = await exchange([{ ...change, base: 'original', content: 'phone edit' }]);
  assert.deepEqual(receipt.conflicts, ['phone_a']);
  assert.equal(receipt.records[0].content, 'computer edit');
  receipt = await exchange([{ ...change, base: 'computer edit', content: 'resolved' }]);
  assert.equal(receipt.conflicts.length, 0);
  receipt = await exchange([{ ...change, base: 'resolved', content: null }]);
  assert.equal(receipt.records[0].content, null);
  // Old offline upload cannot revive the deleted memory.
  receipt = await exchange([{ ...change, base: 'resolved', content: 'late' }]);
  assert.deepEqual(receipt.conflicts, ['phone_a']);
  assert.equal(receipt.records[0].content, null);
});
