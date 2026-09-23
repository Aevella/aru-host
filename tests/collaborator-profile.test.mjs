import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaboratorHost } from '../collaborator-host.mjs';
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aru-profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { hostedCollaborators: [], agentDriverProbes: [], providerProfiles: [] };
  let active = false, failSave = false;
  const host = createCollaboratorHost({ dataDir: dir, managedWorkspaceRoot: dir, state,
    saveState() { if (failSave) throw new Error('disk failure'); },
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, { status, body }), HttpError,
    conversationHostFactory: () => ({ route: async () => false,
      inventory: () => ({ conversations: active ? [{ activeTurn: { state: 'streaming' } }] : [] }),
      status: () => ({ conversationCount: 0, activeTurnCount: 0, pendingApprovalCount: 0 }) }),
  });
  const request = async (method, path, body = {}) => {
    const res = {};
    assert.equal(await host.route({ method, body }, res, path, () => ({ deviceId: 'test' })), true);
    return res.body;
  };
  return { state, request, active: value => active = value, failSave: value => failSave = value };
}
test('profile validation and failed persistence cannot partially mutate a collaborator', async t => {
  const f = fixture(t);
  const item = await f.request('POST', '/aru/v1/hosted-collaborators', { displayName: 'Astra', driverId: 'codex' });
  const path = `/aru/v1/hosted-collaborators/${item.collaboratorId}`;
  await assert.rejects(f.request('PUT', path, { expectedRevision: 1, displayName: 'Changed', avatarDataURL: 'invalid' }));
  assert.equal(f.state.hostedCollaborators[0].displayName, 'Astra');
  f.failSave(true);
  await assert.rejects(f.request('PUT', path, { expectedRevision: 1, displayName: 'Changed', avatarDataURL: 'data:image/png;base64,aGVsbG8=' }));
  assert.equal(f.state.hostedCollaborators[0].avatarDataURL, undefined);
  assert.equal(f.state.hostedCollaborators[0].revision, 1);
  assert.equal(f.state.hostedCollaborators[0].displayName, 'Astra');
  f.failSave(false);
  const updated = await f.request('PUT', path, { expectedRevision: 1, displayName: 'New', avatarDataURL: 'data:image/png;base64,aGVsbG8=' });
  assert.equal(updated.displayName, 'New');
  assert.equal(updated.avatarDataURL, 'data:image/png;base64,aGVsbG8=');
  await assert.rejects(f.request('PUT', path, { expectedRevision: 1, displayName: 'Stale' }), e => e.code === 'collaborator.revision_conflict');
});
test('active execution blocks deletion; failed deletion preserves the live identity; successful deletion rejects late actions', async t => {
  const f = fixture(t);
  const item = await f.request('POST', '/aru/v1/hosted-collaborators', { displayName: 'Astra', driverId: 'codex' });
  const path = `/aru/v1/hosted-collaborators/${item.collaboratorId}`;
  f.active(true);
  await assert.rejects(f.request('DELETE', path, { expectedRevision: 1 }), e => e.code === 'collaborator.busy');
  f.active(false); f.failSave(true);
  await assert.rejects(f.request('DELETE', path, { expectedRevision: 1 }));
  assert.equal(f.state.hostedCollaborators[0].archivedAt, null);
  f.failSave(false);
  const deleted = await f.request('DELETE', path, { expectedRevision: 1 });
  assert.ok(deleted.archivedAt);
  const retried = await f.request('DELETE', path, { expectedRevision: 1 });
  assert.equal(retried.revision, deleted.revision);
  await assert.rejects(f.request('PUT', path, { expectedRevision: 2, displayName: 'Late' }), e => e.code === 'collaborator.unknown');
});

test('lost create replies reuse the same identity; failed persistence does not publish a ghost', async t => {
  const f = fixture(t);
  const body = { displayName: 'Astra', driverId: 'codex', requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  f.failSave(true);
  await assert.rejects(f.request('POST', '/aru/v1/hosted-collaborators', body));
  assert.equal(f.state.hostedCollaborators.length, 0);
  f.failSave(false);
  const first = await f.request('POST', '/aru/v1/hosted-collaborators', body);
  const second = await f.request('POST', '/aru/v1/hosted-collaborators', body);
  assert.equal(first.collaboratorId, second.collaboratorId);
  assert.equal(f.state.hostedCollaborators.length, 1);
});
