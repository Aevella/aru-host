import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as selection from '../collaborator-host.mjs';
const { selectNewestCodex, selectNewestCodexAsync } = selection;
const select = (versions) => selectNewestCodex(Object.keys(versions), (path) => versions[path] === null
  ? { status: 1, error: { code: 'ETIMEDOUT' } }
  : { status: 0, stdout: versions[path] });
test('newer ChatGPT bundle beats older PATH and Codex bundle', () => {
  assert.equal(select({ path: 'codex-cli 0.147.0', codex: 'codex-cli 0.148.0-alpha.9', chatgpt: 'codex-cli 0.153.0' }).executable, 'chatgpt');
});
test('numeric versions, stable releases, and equal-version path priority', () => {
  assert.equal(select({ old: 'codex-cli 0.9.0', newer: 'codex-cli 0.153.0-alpha.10', stable: 'codex-cli 0.153.0', duplicate: 'codex-cli 0.153.0' }).executable, 'stable');
  assert.equal(select({ a: 'codex-cli 0.153.0-alpha.9', b: 'codex-cli 0.153.0-alpha.10' }).executable, 'b');
});
test('failed and malformed candidates do not hide a working install', () => {
  assert.equal(select({ broken: null, malformed: 'something else', valid: 'codex-cli 0.153.0' }).executable, 'valid');
  assert.equal(select({ broken: null, malformed: 'something else' }), null);
});
test('async selection reaches the same verdict and treats a missing binary as absent', async () => {
  const versions = { path: 'codex-cli 0.147.0', broken: null, chatgpt: 'codex-cli 0.153.0' };
  const selected = await selectNewestCodexAsync(Object.keys(versions), async (path) => versions[path] === null
    ? { status: 1, error: { code: 'ETIMEDOUT' } }
    : { status: 0, stdout: versions[path] });
  assert.equal(selected.executable, 'chatgpt');
  assert.equal(await selectNewestCodexAsync(['/nonexistent/aru-test/codex']), null);
});
test('npm-global and nvm installs are discovered outside a trimmed PATH, newest node first', () => {
  const { nodePackageExecutableCandidates } = selection;
  const readDirectory = (root) => {
    if (root === '/home/aru/.nvm/versions/node') {
      return [
        { name: 'v20.11.0', isDirectory: () => true },
        { name: 'v22.4.1', isDirectory: () => true },
        { name: 'README', isDirectory: () => false },
      ];
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const candidates = nodePackageExecutableCandidates('codex', {
    homeDirectory: '/home/aru',
    env: { NPM_CONFIG_PREFIX: '/opt/npm-global' },
    readDirectory,
  });
  assert.deepEqual(candidates, [
    '/opt/npm-global/bin/codex',
    '/home/aru/.npm-global/bin/codex',
    '/home/aru/.nvm/versions/node/v22.4.1/bin/codex',
    '/home/aru/.nvm/versions/node/v20.11.0/bin/codex',
    '/home/aru/.volta/bin/codex',
  ]);
  const versions = { codex: null, '/home/aru/.nvm/versions/node/v22.4.1/bin/codex': 'codex-cli 0.153.0' };
  assert.equal(select({ codex: versions.codex, ...Object.fromEntries(candidates.map((path) => [path, versions[path] ?? null])) }).executable,
    '/home/aru/.nvm/versions/node/v22.4.1/bin/codex');
});
