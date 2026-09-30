import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('authenticated address edits publish immediately and survive a real Core restart', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aru-connection-test-'));
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`; let child;
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, [fileURLToPath(new URL('../aru-selfhost-stub.mjs', import.meta.url)),
      '--data-dir', directory, '--listen-host', '127.0.0.1', '--port', String(port), '--base-url', base,
      '--container-runtime', 'none', '--pairing-token', 'example-token'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', data => errors += data);
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(base + '/.well-known/aru.json')).ok) return; } catch {}
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(errors || 'Core did not start');
  }
  await start();
  const original = await (await fetch(base + '/.well-known/aru.json')).json();
  const grant = await (await fetch(base + '/aru/v1/pair', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingToken: 'example-token', deviceLabel: 'Example Console', deviceRole: 'host-console' }) })).json();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${grant.credentialSecret}` };
  const body = { schema: 'aru.selfhost.node-settings.v1', displayName: 'Example Host', expectedRevision: 1,
    additionalTransports: [{ id: 'tailnet', kind: 'tailscale', baseUrl: 'http://100.100.100.100:8787', priority: 20 }] };
  assert.equal((await fetch(base + '/aru/v1/node-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
  assert.equal((await fetch(base + '/aru/v1/node-settings', { method: 'PUT', headers, body: JSON.stringify(body) })).status, 200);
  const published = await (await fetch(base + '/.well-known/aru.json')).json();
  assert.equal(published.capabilities['node-settings'].additionalTransports, true);
  assert.deepEqual(published.transportProfiles, [...original.transportProfiles, ...body.additionalTransports]);
  await stop(); await start();
  assert.deepEqual((await (await fetch(base + '/.well-known/aru.json')).json()).transportProfiles, published.transportProfiles);
  const settings = await (await fetch(base + '/aru/v1/node-settings', { headers })).json();
  assert.equal(settings.additionalTransports.length, 1);
  assert.equal((await fetch(base + '/aru/v1/node-settings', { method: 'PUT', headers, body: JSON.stringify(body) })).status, 409);
  body.expectedRevision = settings.revision; body.additionalTransports = [];
  assert.equal((await fetch(base + '/aru/v1/node-settings', { method: 'PUT', headers, body: JSON.stringify(body) })).status, 200);
  assert.deepEqual((await (await fetch(base + '/.well-known/aru.json')).json()).transportProfiles, original.transportProfiles);
});
