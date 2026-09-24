import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaboratorConversationHost } from '../collaborator-conversations.mjs';

test('persistent collaborator permission applies to new conversations and revokes on the next action', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-approval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const collaborators = { a: { collaboratorId: 'a', displayName: 'A', driverId: 'codex', approvalMode: 'always_allow' }, b: { collaboratorId: 'b', displayName: 'B', driverId: 'codex' } };
  const deferred = []; let handler; let executions = 0;
  const host = createCollaboratorConversationHost({ dataDir: root,
    driverForCollaborator: () => ({ status: () => 'ready', startTurn: async options => { handler = options.handler; return { threadId: 'thread', turnId: 'turn' }; } }),
    collaboratorForId: id => collaborators[id],
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, {status, body}),
    HttpError: class extends Error { constructor(status, code, message) { super(message); Object.assign(this, {status, code}); } },
    toolCatalog: () => [{name: 'write', inputSchema: {type: 'object'}, annotations: {readOnlyHint: false}}],
    executeTool: async () => { executions++; return {}; }, defer: fn => deferred.push(fn),
  });
  async function call(method, path, body) { const res = {}; await host.route({method, body}, res, path, () => ({deviceId: 'd'})); return res.body; }
  async function start(id) {
    const base = `/aru/v1/hosted-collaborators/${id}/conversations`;
    const c = await call('POST', base, {title: 'Test'}); const path = `${base}/${c.conversationId}`;
    await call('POST', `${path}/messages`, {text: 'test', clientRequestId: `r_${c.conversationId}`});
    await deferred.shift()(); return path;
  }
  for (let i = 0; i < 2; i++) {
    await start('a'); let response;
    await handler.onApproval({method: 'item/commandExecution/requestApproval', params: {}, respond: value => { response = value; }});
    assert.deepEqual(response, {decision: 'accept'});
    await handler.onToolCall({tool: 'write', arguments: {}});
  }
  assert.equal(executions, 2);
  const unrelated = await start('b'); let response;
  await handler.onApproval({method: 'item/fileChange/requestApproval', params: {}, respond: value => {response = value;}});
  assert.equal(response, undefined);
  assert.equal((await call('GET', unrelated)).pendingApprovalCount, 1);
  const revoked = await start('a'); collaborators.a.approvalMode = 'confirm';
  await handler.onApproval({method: 'item/commandExecution/requestApproval', params: {}, respond: value => {response = value;}});
  assert.equal(response, undefined);
  assert.equal((await call('GET', revoked)).pendingApprovalCount, 1);
});

test('mobile replica turns follow the executing computer face approval setting', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-replica-approval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executor = { collaboratorId: 'hostcol_1', displayName: 'Computer', driverId: 'codex', approvalMode: 'always_allow' };
  const lookups = [];
  const deferred = []; let handler; let executions = 0;
  const host = createCollaboratorConversationHost({ dataDir: root,
    driverForCollaborator: () => ({ status: () => 'ready', startTurn: async options => { handler = options.handler; return { threadId: 'thread', turnId: 'turn' }; } }),
    collaboratorForId: id => {
      lookups.push(id);
      if (id !== executor.collaboratorId) throw Object.assign(new Error('invalid hosted collaborator id'), { status: 400 });
      return executor;
    },
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, {status, body}),
    HttpError: class extends Error { constructor(status, code, message) { super(message); Object.assign(this, {status, code}); } },
    toolCatalog: () => [{name: 'write', inputSchema: {type: 'object'}, annotations: {readOnlyHint: false}}],
    executeTool: async () => { executions++; return {}; }, defer: fn => deferred.push(fn),
  });
  const replica = { sourceCollaboratorId: 'phone1', displayName: 'Phone', revision: 1, epoch: 1, conversations: [] };
  const rule = { ruleId: 'rule1', title: 'Morning', seed: 'hello', sourceVersion: 1 };
  host.runReplicaProactive(executor, replica, rule, 'delivery1');
  await deferred.shift()();
  let response;
  await handler.onApproval({method: 'item/commandExecution/requestApproval', params: {}, respond: value => { response = value; }});
  assert.deepEqual(response, {decision: 'accept'});
  await handler.onToolCall({tool: 'write', arguments: {}});
  assert.equal(executions, 1);
  assert.ok(lookups.every(id => id === executor.collaboratorId), `unexpected lookups: ${lookups}`);
});

test('stopping a collaborator\'s active turns cancels the live turn and leaves idle conversations alone', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-stop-active-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const collaborators = { a: { collaboratorId: 'a', displayName: 'A', driverId: 'codex' } };
  const deferred = []; const interrupted = [];
  const host = createCollaboratorConversationHost({ dataDir: root,
    driverForCollaborator: () => ({ status: () => 'ready',
      startTurn: async () => ({ threadId: 'thread', turnId: 'driver-turn' }),
      interrupt: async (thread, turn) => { interrupted.push([thread, turn]); } }),
    collaboratorForId: id => collaborators[id],
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, {status, body}),
    HttpError: class extends Error { constructor(status, code, message) { super(message); Object.assign(this, {status, code}); } },
    toolCatalog: () => [], executeTool: async () => ({}), defer: fn => deferred.push(fn),
  });
  async function call(method, path, body) { const res = {}; await host.route({method, body}, res, path, () => ({deviceId: 'd'})); return res.body; }
  const base = '/aru/v1/hosted-collaborators/a/conversations';
  const idle = await call('POST', base, {title: 'Idle'});
  const busy = await call('POST', base, {title: 'Busy'});
  await call('POST', `${base}/${busy.conversationId}/messages`, {text: 'work', clientRequestId: 'r1'});
  await deferred.shift()();
  assert.deepEqual(await host.stopActiveTurns('a', {deviceId: 'd'}), [busy.conversationId]);
  assert.deepEqual(interrupted, [['thread', 'driver-turn']]);
  assert.equal((await call('GET', `${base}/${busy.conversationId}`)).activeTurn.state, 'interrupted');
  assert.equal((await call('GET', `${base}/${idle.conversationId}`)).activeTurn, null);
  assert.deepEqual(await host.stopActiveTurns('a', {deviceId: 'd'}), []);
});

test('stopping a computer face also stops the phone proactive turn it is running', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-stop-replica-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executor = { collaboratorId: 'hostcol_1', displayName: 'Computer', driverId: 'codex' };
  const deferred = []; const interrupted = [];
  const host = createCollaboratorConversationHost({ dataDir: root,
    driverForCollaborator: () => ({ status: () => 'ready',
      startTurn: async () => ({ threadId: 'thread', turnId: 'driver-turn' }),
      interrupt: async (thread, turn) => { interrupted.push([thread, turn]); } }),
    collaboratorForId: id => { if (id !== executor.collaboratorId) throw new Error('unknown'); return executor; },
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, {status, body}),
    HttpError: class extends Error { constructor(status, code, message) { super(message); Object.assign(this, {status, code}); } },
    toolCatalog: () => [], executeTool: async () => ({}), defer: fn => deferred.push(fn),
  });
  const replica = { sourceCollaboratorId: 'phone1', displayName: 'Phone', revision: 1, epoch: 1, conversations: [] };
  host.runReplicaProactive(executor, replica, { ruleId: 'r', title: 'Morning', seed: 'hi', sourceVersion: 1 }, 'd1');
  await deferred.shift()();
  assert.equal(host.hasActiveTurns('hostcol_1'), true);
  assert.equal((await host.stopActiveTurns('hostcol_1', { deviceId: 'd' })).length, 1);
  assert.deepEqual(interrupted, [['thread', 'driver-turn']]);
  assert.equal(host.hasActiveTurns('hostcol_1'), false);
  assert.equal(host.hasActiveTurns('hostcol_other'), false);
});
