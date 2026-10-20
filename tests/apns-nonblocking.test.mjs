import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAPNsCredentialStore, createAPNsPushHost } from '../apns-push.mjs';

for (const stage of ['probe', 'read']) test(`manifest and HTTP stay responsive while credential ${stage} is pending`, async t => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const store = createAPNsCredentialStore({ platform: 'win32', run: async (_cmd, args) => {
    calls++;
    const reading = args.at(-1).includes('Unprotect');
    if ((stage === 'read') === reading) return pending;
    return { status: reading ? 44 : 0 };
  } });
  const host = createAPNsPushHost({ state: { devices: [] }, credentialStore: store, saveState() {},
    sendJSON(res, status, body) { res.writeHead(status); res.end(JSON.stringify(body)); } });
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/aru.json') {
      res.end(JSON.stringify({ version: 'test', push: host.manifestCapability() }));
    } else void host.route(req, res, '/aru/v1/push-devices/current', () => ({ deviceId: 'phone' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release({ status: 44 }); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // A status request shares the pending credential read, but cannot block the
  // independent version route. Bound the request so a regression fails cleanly.
  const status = fetch(base + '/status').then(res => res.json());
  for (let i = 0; i < 4; i++) {
    const response = await fetch(base + '/.well-known/aru.json', { signal: AbortSignal.timeout(1_000) });
    const manifest = await response.json();
    assert.equal(manifest.version, 'test');
    assert.equal(manifest.push.credentialState, 'checking');
  }
  assert.equal(calls, stage === 'probe' ? 1 : 2, 'polling must not launch more subprocesses');
  release({ status: 44 });
  const result = await status;
  assert.equal(result.credentialState, stage === 'probe' ? 'unavailable' : 'missing');
});

test('production subprocess runner yields the event loop while waiting for a child', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-async-credential-'));
  const executable = join(root, 'powershell.exe'); const release = join(root, 'release');
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs');\nconst timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0)}},10);\n`);
  chmodSync(executable, 0o755);
  const priorPath = process.env.PATH; process.env.PATH = root + ':' + priorPath;
  t.after(() => { process.env.PATH = priorPath; rmSync(root, { recursive: true, force: true }); });
  const store = createAPNsCredentialStore({ platform: 'win32' });
  let finished = false;
  const probe = store.availability().finally(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 40));
  const yieldedBeforeCompletion = !finished;
  writeFileSync(release, 'ready');
  assert.equal((await probe).supported, true);
  assert.equal(yieldedBeforeCompletion, true, 'timer must run before the waiting child exits');
});
