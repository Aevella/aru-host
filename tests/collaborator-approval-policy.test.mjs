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
