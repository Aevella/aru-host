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
  let active = false, failSave = false, restartDuringStop = false;
  const stopped = [];
  const host = createCollaboratorHost({ dataDir: dir, managedWorkspaceRoot: dir, state,
    saveState() { if (failSave) throw new Error('disk failure'); },
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, { status, body }), HttpError,
    conversationHostFactory: () => ({ route: async () => false,
      inventory: () => ({ conversations: active ? [{ activeTurn: { state: 'streaming' } }] : [] }),
      stopActiveTurns: async (id, device) => { stopped.push({ id, device: device.deviceId }); active = restartDuringStop; },
      hasActiveTurns: () => active,
      status: () => ({ conversationCount: 0, activeTurnCount: 0, pendingApprovalCount: 0 }) }),
  });
  const request = async (method, path, body = {}) => {
    const res = {};
    assert.equal(await host.route({ method, body }, res, path, () => ({ deviceId: 'test' })), true);
    return res.body;
  };
  return { state, request, stopped, active: value => active = value, failSave: value => failSave = value,
    restartDuringStop: value => restartDuringStop = value };
}
test('inventory declares protocol compatibility before opening individual features', async t => {
  const f = fixture(t);
  const inventory = await f.request('GET', '/aru/v1/hosted-collaborators');
  assert.deepEqual(inventory.compatibility, { revision: 1, minimumClientRevision: 1 });
});
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

test('approval policy persists through collaborator revisions and rejects invalid or stale updates', async t => {
  const f = fixture(t);
  const item = await f.request('POST', '/aru/v1/hosted-collaborators', {displayName: 'Astra', driverId: 'codex'});
  assert.equal(item.approvalMode, 'confirm');
  assert.equal(item.supportsAvatarEditing, true);
  const path = `/aru/v1/hosted-collaborators/${item.collaboratorId}`;
  await assert.rejects(f.request('PUT', path, {expectedRevision: 1, approvalMode: 'unknown'}));
  f.failSave(true);
  await assert.rejects(f.request('PUT', path, {expectedRevision: 1, approvalMode: 'always_allow'}));
  assert.equal(f.state.hostedCollaborators[0].approvalMode, undefined);
  f.failSave(false);
  const allowed = await f.request('PUT', path, {expectedRevision: 1, approvalMode: 'always_allow'});
  assert.equal(allowed.approvalMode, 'always_allow');
  assert.equal(f.state.hostedCollaborators[0].approvalMode, 'always_allow');
  await assert.rejects(f.request('PUT', path, {expectedRevision: 1, approvalMode: 'confirm'}));
  const revoked = await f.request('PUT', path, {expectedRevision: 2, approvalMode: 'confirm'});
  assert.equal(revoked.approvalMode, 'confirm');
});

test('avatar content above the old 64KB limit round-trips in the profile', async t => {
  const f = fixture(t);
  const item = await f.request('POST', '/aru/v1/hosted-collaborators', {displayName: 'Avatar', driverId: 'codex'});
  const avatarDataURL = 'data:image/jpeg;base64,' + Buffer.alloc(100000, 7).toString('base64');
  const updated = await f.request('PUT', `/aru/v1/hosted-collaborators/${item.collaboratorId}`, {expectedRevision: 1, avatarDataURL});
  assert.equal(updated.avatarDataURL, avatarDataURL);
  assert.equal(f.state.hostedCollaborators[0].avatarDataURL, avatarDataURL);
});

test('deletion can stop running tasks when the person confirms it, and never deletes over a task that restarted', async t => {
  const f = fixture(t);
  const item = await f.request('POST', '/aru/v1/hosted-collaborators', { displayName: 'Astra', driverId: 'codex' });
  const path = `/aru/v1/hosted-collaborators/${item.collaboratorId}`;
  f.active(true); f.restartDuringStop(true);
  await assert.rejects(f.request('DELETE', path, { expectedRevision: 1, stopActiveTurns: true }), e => e.code === 'collaborator.busy');
  assert.equal(f.state.hostedCollaborators[0].archivedAt, null);
  f.active(true); f.restartDuringStop(false);
  const deleted = await f.request('DELETE', path, { expectedRevision: 1, stopActiveTurns: true });
  assert.ok(deleted.archivedAt);
  assert.deepEqual(f.stopped.map(item => item.id), [item.collaboratorId, item.collaboratorId]);
});
