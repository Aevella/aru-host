import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mobileToolReceipts } from '../src/conversations/mobile-tool-receipts.mjs';
import { createCollaboratorConversationHost } from '../collaborator-conversations.mjs';
import { createMobileCollaboratorReplicaHost } from '../mobile-collaborator-replicas.mjs';

test('status projection is turn scoped, preserves order and never exports arguments or raw results', () => {
  const event = (kind, id, at, extra = {}) => ({ kind, at, payload: { turnId: 'turn', toolCallId: id, toolName: 'read', ...extra } });
  const receipts = mobileToolReceipts({ events: [
    event('tool.completed', 'other', 1, { turnId: 'unrelated' }),
    event('tool.started', 'one', 2, { arguments: 'secret' }),
    event('tool.started', 'two', 3), event('tool.completed', 'one', 4, { result: 'private' }),
    event('tool.started', 'three', 5), event('tool.failed', 'three', 6, { message: 'offline' }),
  ] }, { turnId: 'turn' });
  assert.deepEqual(receipts.map(x => [x.toolCallId, x.status]), [['one', 'complete'], ['two', 'interrupted'], ['three', 'failed']]);
  assert.equal(receipts[0].createdAt, 2); assert.equal(receipts[0].updatedAt, 4);
  assert.ok(!JSON.stringify(receipts).includes('secret')); assert.ok(!JSON.stringify(receipts).includes('private'));
});

test('successful, MCP isError and thrown failures reach durable delivery and recovery with no duplicate calls', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mobile-tool-receipts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let response, request, event, calls = 0, mobile;
  const deferred = [], settlements = [];
  const executor = { collaboratorId: 'executor', toolAccess: { mode: 'all' }, approvalMode: 'always_allow' };
  const common = { dataDir: root, HttpError: Error, collaboratorForId: () => executor, now: () => 1000,
    readJSONBody: async req => req.body, sendJSON: (_res, _status, value) => { response = value; } };
  const options = { ...common, defer: op => deferred.push(op),
    toolCatalog: () => ['ok', 'mcp_error', 'offline'].map(name => ({ name, inputSchema: { type: 'object' } })),
    executeTool: async name => {
      calls++;
      if (name === 'offline') throw new Error('service offline');
      return { isError: name === 'mcp_error', content: [{ type: 'text', text: name === 'mcp_error' ? 'MCP unauthorized: renew service access' : 'saved' }] };
    },
    driverForCollaborator: () => ({ startTurn: async value => { request = value; return { threadId: 'thread', turnId: 'turn' }; } }),
    onTurnSettled: value => { event = value; const pending = mobile.settle(value); settlements.push(pending); return pending; },
  };
  let conversations = createCollaboratorConversationHost(options);
  const mobileOptions = { ...common, maximumRequestBytes: 1e6, setTimer: () => 1, clearTimer() {},
    trigger: (...args) => conversations.runReplicaProactive(...args),
    recoverDelivery: (...args) => conversations.recoverReplicaDelivery(...args),
  };
  mobile = createMobileCollaboratorReplicaHost(mobileOptions);
  t.after(() => mobile.stop());
  const path = '/aru/v1/mobile-collaborator-replicas/phone';
  async function route(method, suffix, body) {
    await mobile.route({ method, body, url: path + suffix + '?epoch=1' }, {}, path + suffix, () => ({})); return response;
  }
  await route('PUT', '', { schema: 'aru.selfhost.mobile-collaborator-replica.v1', sourceCollaboratorId: 'phone', displayName: 'Phone',
    systemPrompt: '', memories: [], references: [], conversations: [], readerHostCollaboratorIds: ['executor'], executorHostCollaboratorId: 'executor', epoch: 1, revision: 1, generatedAt: 1,
    rules: [{ ruleId: 'once', title: 'test', nextFireAt: 1, updatedAt: 1, enabled: true, scheduleKind: 'one_time', sourceVersion: 'v1' }] });
  await mobile.runDue(); await deferred.shift()();
  assert.equal((await request.handler.onToolCall({ tool: 'ok', arguments: {} })).isError, false);
  assert.equal((await request.handler.onToolCall({ tool: 'mcp_error', arguments: {} })).isError, true);
  await assert.rejects(request.handler.onToolCall({ tool: 'offline', arguments: {} }), /offline/);
  request.handler.onNotification('item/agentMessage/delta', { delta: 'summary' });
  request.handler.onNotification('turn/completed', { turn: { status: 'completed' } });
  await Promise.all(settlements);
  const first = (await route('GET', '/deliveries')).deliveries[0];
  assert.deepEqual(first.toolReceipts.map(x => x.status), ['complete', 'failed', 'failed']);
  assert.equal(first.toolReceipts[1].failure, 'MCP unauthorized: renew service access');
  assert.equal(first.toolReceipts[2].failure, 'service offline');
  await mobile.settle(event);
  mobile.stop(); conversations = createCollaboratorConversationHost(options);
  const recovered = conversations.recoverReplicaDelivery('phone', first.deliveryId, 1);
  assert.deepEqual(recovered.toolReceipts, first.toolReceipts);
  mobile = createMobileCollaboratorReplicaHost(mobileOptions); await mobile.start();
  assert.deepEqual((await route('GET', '/deliveries')).deliveries[0].toolReceipts, first.toolReceipts);
  await mobile.runDue(); assert.equal(deferred.length, 0); assert.equal(calls, 3);
});
