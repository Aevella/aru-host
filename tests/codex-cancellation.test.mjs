import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAppServerDriver } from '../codex-app-server-driver.mjs';

test('a lost interrupt acknowledgement can be retried, and retired turn events cannot settle a new turn', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-codex-cancel-'));
  const original = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = original; rmSync(root, { recursive: true, force: true }); });
  const script = join(root, 'fake.mjs');
  writeFileSync(script, "console.error('listening on: ws://127.0.0.1:54321');\n");
  let socket, allowInterrupt = false, completeInterrupt = false, sequence = 0;
  class Socket extends EventTarget {
    readyState = 1;
    constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const message = JSON.parse(text);
      if (!message.method || message.id === undefined) return;
      if (message.method === 'turn/interrupt' && !allowInterrupt) return;
      const result = message.method === 'thread/start' ? { thread: { id: 'thread' } }
        : message.method === 'turn/start' ? { turn: { id: `turn${++sequence}` } } : {};
      queueMicrotask(() => {
        this.deliver({ id: message.id, result });
        if (message.method === 'turn/interrupt' && completeInterrupt) this.deliver({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted' } } });
      });
    }
    deliver(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  globalThis.WebSocket = Socket;
  const driver = createCodexAppServerDriver({ executable: { file: process.execPath, args: [script] }, interruptTimeoutMs: 10 });
  const events = [];
  const options = { cwd: root, instructions: '', tools: [], text: 'test', handler: { onNotification: (...args) => events.push(args) } };
  const first = await driver.startTurn(options);
  await assert.rejects(driver.interrupt(first.threadId, first.turnId), /has not confirmed|did not acknowledge/);
  allowInterrupt = true;
  await assert.rejects(driver.interrupt(first.threadId, first.turnId), /has not confirmed/);
  completeInterrupt = true; await driver.interrupt(first.threadId, first.turnId);
  const next = await driver.startTurn({ ...options, threadId: first.threadId });
  socket.deliver({ method: 'turn/completed', params: { threadId: first.threadId, turn: { id: first.turnId, status: 'interrupted' } } });
  socket.deliver({ method: 'item/agentMessage/delta', params: { threadId: first.threadId, turnId: first.turnId, delta: 'late' } });
  assert.equal(events.length, 0);
  socket.deliver({ method: 'turn/completed', params: { threadId: next.threadId, turn: { id: next.turnId, status: 'completed' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1); assert.equal(events[0][1].turn.id, next.turnId);
});
