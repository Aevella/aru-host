import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('manifest and diagnostics never scan conversation history; inventory preserves statistics', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aru-status-history-'));
  const history = join(directory, 'collaborator-conversations', 'collaborator_test');
  await mkdir(history, { recursive: true });
  await writeFile(join(history, 'conversation_test.json'), JSON.stringify({
    conversationId: 'conversation_test', collaboratorId: 'collaborator_test',
    messages: Array.from({ length: 128 }, () => ({ content: 'x'.repeat(32768) })),
    activeTurn: { state: 'running' }, approvals: [{ state: 'pending' }],
  }));
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    '--require', fileURLToPath(new URL('./fixtures/conversation-read-count-preload.cjs', import.meta.url)),
    fileURLToPath(new URL('../aru-selfhost-stub.mjs', import.meta.url)),
    '--data-dir', directory, '--listen-host', '127.0.0.1', '--port', String(port),
    '--base-url', base, '--container-runtime', 'none', '--pairing-token', 'status-test-token',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  function readCounts() {
    const id = ++sequence;
    return new Promise(resolve => {
      const receive = data => { if (data.id === id && data.kind === 'history-read-count') {
        child.off('message', receive); resolve(data);
      } };
      child.on('message', receive); child.send({ kind: 'history-read-count', id });
    });
  }
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(`${base}/.well-known/aru.json`); await response.arrayBuffer(); ready = response.ok; } catch {}
    if (ready) break;
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, errors);
  const pair = await fetch(`${base}/aru/v1/pair`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingToken: 'status-test-token', deviceLabel: 'test', deviceRole: 'host-console' }) });
  assert.equal(pair.status, 200);
  const grant = await pair.json();
  const headers = { authorization: `Bearer ${grant.credentialSecret}` };
  await readCounts();
  for (const path of ['/.well-known/aru.json', '/aru/v1/diagnostics']) {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (path.endsWith('aru.json')) assert.equal(typeof body.capabilities['collaborator-host'].turnExecution, 'boolean');
    else assert.equal(typeof body.readyAgentDriverCount, 'number');
    const counts = await readCounts();
    assert.equal(counts.reads, 0, `${path} must not read conversation JSON`);
    assert.equal(counts.directoryReads, 0, `${path} must not scan conversation/attachment directories`);
  }
  const response = await fetch(`${base}/aru/v1/agent-drivers`, { headers });
  assert.equal(response.status, 200);
  const inventory = await response.json();
  assert.equal(inventory.execution.conversationCount, 1);
  assert.equal(inventory.execution.pendingApprovalCount, 1);
  assert.equal((await readCounts()).reads, 1);
});
