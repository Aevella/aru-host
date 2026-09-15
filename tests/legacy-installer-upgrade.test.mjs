import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
test('the shipped 0.31.4 fixed-list installer admits and starts modularized Host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aru-installed-upgrader-'));
  const data = join(root, 'var/lib/aru-selfhost/data');
  mkdirSync(data, { recursive: true });
  const original = '{"serverId":"upgrade-preserved","devices":[],"packages":[]}';
  writeFileSync(join(data, 'state.json'), original);
  let child;
  try {
    execFileSync('bash', [join(source, 'tests/fixtures/install-v0.31.4.sh'), '--root', root,
      '--source-dir', source, '--base-url', 'http://100.64.0.10:8787'], { stdio: 'pipe', timeout: 30000 });
    assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), original);
    const server = join(root, 'opt/aru-selfhost/current/server.mjs');
    execFileSync(process.execPath, [server, '--data-dir', data, '--container-runtime', 'none', '--check-state'], { stdio: 'pipe' });
    child = spawn(process.execPath, [server, '--data-dir', data, '--container-runtime', 'none', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolveReady, reject) => {
      let text = '';
      const timeout = setTimeout(() => reject(new Error(`Host did not start: ${text}`)), 10000);
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Host exited ${code}: ${text}`)); });
      child.stdout.on('data', chunk => {
        text += chunk;
        if (text.includes('pairing')) { clearTimeout(timeout); resolveReady(); }
      });
      child.stderr.on('data', chunk => { text += chunk; });
    });
    assert.equal(JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')).serverId, 'upgrade-preserved');
  } finally {
    if (child?.exitCode === null) {
      const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
