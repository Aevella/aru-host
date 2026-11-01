import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('HTTP pairing distinguishes consumed tokens and tokens invalidated by restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aru-pair-http-'));
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  }
  t.after(async () => { await stop(); await rm(directory, {recursive:true, force:true}); });
  async function start() {
    child = spawn(process.execPath, [fileURLToPath(new URL('../aru-selfhost-stub.mjs', import.meta.url)),
      '--data-dir', directory, '--listen-host', '127.0.0.1', '--port', String(port),
      '--base-url', base, '--transport-kind', 'lan', '--container-runtime', 'none'], {stdio:['ignore','pipe','pipe']});
    let output = '';
    child.stdout.on('data', data => {output += data;});
    child.stderr.resume();
    for (let i=0;i<100;i++) {
      const line = output.split(/\r?\n/).find(line => line.startsWith('aru://pair?'));
      if (line) return new URL(line).searchParams.get('pairingToken');
      if (child.exitCode !== null) throw new Error('Host exited before pairing');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Host did not issue a pairing link');
  }
  async function pair(token) {
    const response = await fetch(`${base}/aru/v1/pair`, {method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({pairingToken:token, deviceLabel:'synthetic-phone'})});
    return {status:response.status, body:await response.json()};
  }
  const first = await start();
  assert.equal((await pair(first)).status, 200);
  const used = await pair(first);
  assert.equal(used.status, 401);
  assert.match(JSON.stringify(used.body), /pairing.token_used/);
  await stop();
  const second = await start();
  assert.notEqual(first, second);
  const stale = await pair(first);
  assert.equal(stale.status, 401);
  assert.match(JSON.stringify(stale.body), /pairing.token_mismatch/);
  assert.equal((await pair(second)).status, 200, 'fresh pairing recovers without deleting data');
});
