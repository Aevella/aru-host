import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readlinkSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../', import.meta.url));
test('VPS release identity and service key survive upgrades; missing key cannot switch releases', () => {
  const root = mkdtempSync(join(tmpdir(), 'aru-release-recovery-'));
  try {
    const install = version => execFileSync('bash', [join(source, 'install.sh'), '--root', root, '--source-dir', source, '--release-version', version, '--base-url', 'http://100.64.0.1:8787'], { stdio: 'pipe' });
    install('0.40.0');
    const release = JSON.parse(readFileSync(join(root, 'opt/aru-selfhost/current/release.json')));
    assert.equal(release.version, '0.40.0');
    const keyPath = join(root, 'var/lib/aru-selfhost/provider-secrets/master.key');
    const key = readFileSync(keyPath);
    install('0.40.1'); assert.deepEqual(readFileSync(keyPath), key);
    const pointer = readlinkSync(join(root, 'opt/aru-selfhost/current'));
    writeFileSync(join(root, 'var/lib/aru-selfhost/provider-secrets/provider_abc.sealed'), 'existing ciphertext');
    unlinkSync(keyPath);
    assert.throws(() => install('0.40.2'));
    assert.equal(readlinkSync(join(root, 'opt/aru-selfhost/current')), pointer);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failure after rewriting configuration restores the prior installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'aru-install-rollback-'));
  try {
    const args = [join(source, 'install.sh'), '--root', root, '--source-dir', source,
      '--release-version', '0.40.0', '--base-url', 'http://100.64.0.1:8787'];
    execFileSync('bash', args, { stdio: 'pipe' });
    const paths = ['etc/aru-selfhost/node.env', 'etc/aru-selfhost/install.env',
      'etc/systemd/system/aru-selfhost.service', 'usr/local/bin/aru-selfhost'];
    const before = paths.map(path => readFileSync(join(root, path)));
    const pointer = readlinkSync(join(root, 'opt/aru-selfhost/current'));
    const bin = join(root, 'mock-bin'); mkdirSync(bin);
    const realInstall = execFileSync('/usr/bin/which', ['install'], { encoding: 'utf8' }).trim();
    const wrapper = join(bin, 'install');
    writeFileSync(wrapper, '#!/bin/bash\nfor arg in "$@"; do [[ "$arg" != */aru-selfhost.service ]] || exit 91; done\nexec ' + realInstall + ' "$@"\n');
    chmodSync(wrapper, 0o755);
    const failedArgs = [...args]; failedArgs[failedArgs.length - 1] = 'http://100.64.0.2:8787';
    assert.throws(() => execFileSync('bash', failedArgs, { stdio: 'pipe',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH } }));
    paths.forEach((path, index) => assert.deepEqual(readFileSync(join(root, path)), before[index]));
    assert.equal(readlinkSync(join(root, 'opt/aru-selfhost/current')), pointer);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
