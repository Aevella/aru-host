import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const compatible of [false, true]) test(`Mac rollback checks replica format before stopping current service: compatible=${compatible}`, { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-rollback-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, 'base'), instance = join(base, 'instances/default');
  for (const path of ['config', 'releases/old', 'releases/current', 'data/mobile-collaborator-replicas/records-v2']) mkdirSync(join(instance, path), { recursive: true });
  mkdirSync(join(root, 'bin'));
  const calls = join(root, 'calls');
  writeFileSync(join(root, 'bin/launchctl'), '#!/bin/sh\necho called >> "$CALLS"\n', { mode: 0o755 });
  writeFileSync(join(instance, 'config/node.env'), `ARU_DATA_DIR='${instance}/data'\nARU_NODE_BINARY='${process.execPath}'\n`);
  writeFileSync(join(instance, 'releases/old/mobile-collaborator-replicas.mjs'), compatible ? 'export const replicaStorageVersion = 2;' : 'export const old = true;');
  symlinkSync('releases/current', join(instance, 'current')); symlinkSync('releases/old', join(instance, 'previous'));
  const result = spawnSync('bash', ['aru-selfhostctl-macos', '--base-root', base, 'rollback'], { encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, CALLS: calls } });
  assert.equal(result.status, compatible ? 0 : 1, result.stderr);
  assert.equal(readlinkSync(join(instance, 'current')), compatible ? 'releases/old' : 'releases/current');
  if (compatible) assert.match(readFileSync(calls, 'utf8'), /called/);
  else { assert.match(result.stderr, /current release unchanged/); assert.throws(() => readFileSync(calls)); }
});

for (const compatible of [false, true]) test(`Linux rollback checks replica format before switching release: compatible=${compatible}`, { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-linux-rollback-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['releases/old', 'releases/current', 'data/mobile-collaborator-replicas/records-v2']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'releases/old/mobile-collaborator-replicas.mjs'), compatible ? 'export const replicaStorageVersion = 2;' : 'export const old = true;');
  symlinkSync('releases/current', join(root, 'current')); symlinkSync('releases/old', join(root, 'previous'));
  const source = readFileSync('aru-selfhostctl', 'utf8');
  const body = source.slice(source.indexOf('rollback_command() {'), source.indexOf('\nuninstall_command()'))
    .replaceAll('/opt/aru-selfhost', root);
  const script = `set -e\nneed_root() { :; }\nload_node_config() { :; }\ndie() { echo "$*" >&2; exit 1; }\nrunuser() { echo probe >> "$CALLS"; }\nsystemctl() { echo restart >> "$CALLS"; }\n${body}\nrollback_command\n`;
  const calls = join(root, 'calls');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ARU_DATA_DIR: join(root, 'data'), ARU_NODE_BINARY: process.execPath, ARU_PROVIDER_SECRET_ROOT: '', SERVICE: 'test', CALLS: calls } });
  assert.equal(result.status, compatible ? 0 : 1, result.stderr);
  assert.equal(readlinkSync(join(root, 'current')), compatible ? 'releases/old' : 'releases/current');
  if (compatible) assert.match(readFileSync(calls, 'utf8'), /restart/);
  else { assert.match(result.stderr, /current release unchanged/); assert.throws(() => readFileSync(calls)); }
});

for (const installer of ['install.sh', 'install-macos.sh']) test(`${installer} automatic fallback rejects old record readers`, { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'aru-auto-rollback-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'); mkdirSync(join(data, 'mobile-collaborator-replicas/records-v2'), { recursive: true });
  const text = readFileSync(installer, 'utf8'), start = text.indexOf('replica_rollback_compatible() {');
  const helper = text.slice(start, text.indexOf('\n}\n', start) + 3);
  for (const version of [1, 2]) {
    writeFileSync(join(root, 'mobile-collaborator-replicas.mjs'), `export const replicaStorageVersion = ${version};`);
    const result = spawnSync('bash', ['-c', `${helper}\nreplica_rollback_compatible "$1" "$2" "$3"`, 'test', root, data, process.execPath]);
    assert.equal(result.status, version === 2 ? 0 : 1);
  }
});
