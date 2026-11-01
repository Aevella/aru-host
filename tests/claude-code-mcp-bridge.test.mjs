import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { runClaudeCodeMCPBridge } from '../claude-code-mcp-bridge.mjs';
import { createClaudeCodeHostBridge } from '../claude-code-host-bridge.mjs';

async function fixture(t) {
  const approvals = [];
  const lifetime = new AbortController();
  const grants = new Map();
  const context = { sessionId: 'session', tools: [], lifetimeSignal: lifetime.signal,
    handler: { onApproval: request => approvals.push(request) } };
  const host = await createClaudeCodeHostBridge(() => context, grants);
  const input = new PassThrough(), output = new PassThrough();
  const replies = [], waiters = [];
  const lines = createInterface({ input: output });
  lines.on('line', line => { const reply = JSON.parse(line); const waiter = waiters.shift(); if (waiter) waiter(reply); else replies.push(reply); });
  const running = runClaudeCodeMCPBridge({ bridgeURL: host.url, bridgeToken: host.token,
    input, output, errorOutput: new PassThrough() });
  t.after(async () => { input.end(); await running; lifetime.abort(); host.server.closeAllConnections(); await new Promise(r => host.server.close(r)); lines.close(); });
  return { approvals, grants, input, running,
    send: (id, method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'),
    next: () => replies.length ? Promise.resolve(replies.shift()) : new Promise(r => waiters.push(r)) };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('expected lifecycle transition');
}
const permission = { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'echo fixture' } } };

test('pending real HTTP approval does not block ping; delayed approval completes once', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.send(1, 'tools/call', permission);
  await until(() => f.approvals.length === 1);
  f.send(2, 'ping');
  assert.equal((await f.next()).id, 2);
  f.approvals[0].respond({ decision: 'accept' });
  const reply = await f.next();
  assert.equal(reply.id, 1);
  assert.equal(JSON.parse(reply.result.content[0].text).behavior, 'allow');
});

test('MCP cancellation aborts original approval, rejects late grant and permits next request', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.send(1, 'tools/call', permission);
  await until(() => f.approvals.length === 1);
  f.send(undefined, 'notifications/cancelled', { requestId: 1 });
  await until(() => f.approvals[0].signal.aborted);
  f.approvals[0].respond({ decision: 'acceptForSession' });
  f.send(2, 'tools/call', permission);
  await until(() => f.approvals.length === 2);
  assert.equal(f.grants.size, 0);
  f.approvals[1].respond({ decision: 'accept' });
  assert.equal((await f.next()).id, 2);
});

test('stdio close releases pending HTTP approval without waiting for user', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.send(1, 'tools/call', permission);
  await until(() => f.approvals.length === 1);
  f.input.end();
  await f.running;
  await until(() => f.approvals[0].signal.aborted);
});
