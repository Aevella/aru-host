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
