import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaboratorConversationHost } from '../collaborator-conversations.mjs';
function fixture(t, { start, interrupt, executeTool } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aru-turn-cancel-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const queue = [], handlers = []; let sequence = 0;
  const host = createCollaboratorConversationHost({ dataDir: root, cancellationWaitMs: 15,
    driverForCollaborator: () => ({ status: () => 'ready', startTurn: async options => { handlers.push(options.handler); return start ? start() : { threadId: 'thread', turnId: `turn${++sequence}` }; }, interrupt: interrupt ?? (async () => {}) }),
    collaboratorForId: id => ({ collaboratorId: id, displayName: id, driverId: 'codex', approvalMode: 'always_allow' }),
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    HttpError: class extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } },
    toolCatalog: () => [{ name: 'work', annotations: { readOnlyHint: false }, inputSchema: {} }],
    executeTool: executeTool ?? (async () => ({})), defer: fn => queue.push(fn),
  });
  const call = async (method, path, body) => { const res = {}; await host.route({ method, body }, res, path, () => ({ deviceId: 'test' })); return res.body; };
  return { call, queue, handlers, async conversation() {
    const base = '/aru/v1/hosted-collaborators/a/conversations';
    const c = await call('POST', base, { title: 'Test' }); return `${base}/${c.conversationId}`;
  }, async send(path, id) { return call('POST', `${path}/messages`, { text: 'work', clientRequestId: id }); },
  async stop(path) { const c = await call('GET', path); return call('POST', `${path}/turns/${c.activeTurn.turnId}/cancel`); } };
}
test('cancel while driver starts waits for its identity then stops it; late callbacks cannot hit retry', async t => {
  let ready; const stops = [];
  const f = fixture(t, { start: () => new Promise(resolve => { ready = resolve; }), interrupt: async (...args) => stops.push(args) });
  const path = await f.conversation(); await f.send(path, 'first'); const starting = f.queue.shift()();
  await Promise.resolve(); const stop = f.stop(path);
  await new Promise(resolve => setImmediate(resolve)); ready({ threadId: 'thread', turnId: 'one' });
  await starting; assert.equal((await stop).activeTurn.state, 'interrupted');
  assert.deepEqual(stops, [['thread', 'one']]);
  await f.send(path, 'second');
  await f.handlers[0].onNotification('item/agentMessage/delta', { delta: 'late old text' });
  const fresh = await f.call('GET', path);
  assert.equal(fresh.activeTurn.state, 'queued'); assert.ok(fresh.messages.every(m => !m.content.includes('late old text')));
});
test('unacknowledged cancellation remains retryable and does not free the occupied turn', async t => {
  let count = 0;
  const f = fixture(t, { interrupt: async () => { if (++count === 1) throw new Error('no acknowledgement'); } });
  const path = await f.conversation(); await f.send(path, 'first'); await f.queue.shift()();
  const failed = await f.stop(path); assert.equal(failed.activeTurn.cancellation.status, 'failed'); assert.equal(failed.activeTurn.canCancel, true);
  await assert.rejects(f.send(path, 'second'));
  assert.equal((await f.stop(path)).activeTurn.state, 'interrupted');
  await f.send(path, 'second');
});
test('tool cancellation signals the exact attempt and waits for real side effect completion', async t => {
  let finish, signal;
  const f = fixture(t, { executeTool: async (_, __, ___, ____, context) => { signal = context.signal; return new Promise(resolve => { finish = resolve; }); } });
  const path = await f.conversation(); await f.send(path, 'first'); await f.queue.shift()();
  const tool = f.handlers[0].onToolCall({ tool: 'work' }); const rejection = assert.rejects(tool);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.call('GET', path)).activeTurn.canCancel, true);
  const stopped = await f.stop(path);
  assert.equal(signal.aborted, true); assert.equal(stopped.activeTurn.cancellation.status, 'failed');
  finish({}); await rejection; await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.call('GET', path)).activeTurn.state, 'interrupted');
  await f.send(path, 'second');
});
