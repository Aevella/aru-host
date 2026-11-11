import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaboratorHost } from '../../collaborator-host.mjs';
import { activeCollaborators } from '../src/host-presentation.mjs';

class HttpError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
test('real deletion retains its tombstone while refreshed Console lists exclude it and preserve another collaborator', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aru-delete-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { hostedCollaborators: [], agentDriverProbes: [], providerProfiles: [] };
  const host = createCollaboratorHost({ dataDir: dir, managedWorkspaceRoot: dir, state,
    saveState: () => writeFileSync(join(dir, 'state.json'), JSON.stringify(state)),
    readJSONBody: async req => req.body,
    sendJSON: (res, status, body) => Object.assign(res, { status, body }), HttpError });
  t.after(() => host.dispose?.());
  async function request(method, path, body = {}) {
    const res = {};
    assert.equal(await host.route({ method, body }, res, path, () => ({ deviceId: 'synthetic' })), true);
    return res.body;
  }
  const first = await request('POST', '/aru/v1/hosted-collaborators', { displayName: 'First', driverId: 'codex' });
  const second = await request('POST', '/aru/v1/hosted-collaborators', { displayName: 'Second', driverId: 'codex' });
  const path = `/aru/v1/hosted-collaborators/${first.collaboratorId}`;
  await assert.rejects(request('DELETE', path, { expectedRevision: 9 }), e => e.code === 'collaborator.revision_conflict');
  assert.equal(activeCollaborators(await request('GET', '/aru/v1/hosted-collaborators')).length, 2);
  const deleted = await request('DELETE', path, { expectedRevision: 1 });
  const retry = await request('DELETE', path, { expectedRevision: 1 });
  assert.equal(retry.revision, deleted.revision);
  const directory = await request('GET', '/aru/v1/hosted-collaborators');
  assert.equal(directory.collaborators.length, 2); // Sync must retain tombstones.
  assert.deepEqual(activeCollaborators(directory).map(c => c.collaboratorId), [second.collaboratorId]);
  for (const item of activeCollaborators(directory)) {
    await request('GET', `/aru/v1/hosted-collaborators/${item.collaboratorId}/surfaces`);
  }
  assert.ok(JSON.parse(readFileSync(join(dir, 'state.json'))).hostedCollaborators[0].archivedAt);
  assert.deepEqual(activeCollaborators({ collaborators: [{ collaboratorId: 'older-host' }] }), [{ collaboratorId: 'older-host' }]);
});
