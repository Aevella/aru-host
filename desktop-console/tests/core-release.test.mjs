import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForCoreRelease } from '../src/core-release.mjs';
import { hostReleaseLabel, turnActions, driverGuidance } from '../src/host-presentation.mjs';
test('upgrade accepts live target release on the same identity, not the protocol or receipt', async () => {
  let calls = 0;
  const value = await waitForCoreRelease(async () => ({ serverId: 'host', serverVersion: 'stub-0.30', releaseVersion: ++calls > 1 ? '0.34.0' : '0.33.1' }),
    { version: '0.34.0', serverId: 'host', intervalMs: 1, timeoutMs: 100 });
  assert.equal(value.releaseVersion, '0.34.0');
  await assert.rejects(waitForCoreRelease(async () => ({ serverId: 'wrong', releaseVersion: '0.34.0' }), { version: '0.34.0', serverId: 'host' }), /identity changed/);
  await assert.rejects(waitForCoreRelease(async () => ({ serverId: 'host', serverVersion: 'stub-0.30' }), { version: '0.34.0', timeoutMs: 10, intervalMs: 1 }), /not verified/);
});
test('hanging startup requests are aborted', async () => {
  await assert.rejects(waitForCoreRelease(signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), { version: '1', timeoutMs: 10 }), /not verified/);
});
test('presentation follows owner actions including tool work, and explains empty drivers', () => {
  assert.equal(turnActions({ state: 'toolRunning', canCancel: true }).canCancel, true);
  assert.equal(turnActions({ state: 'streaming', canCancel: false }).canCancel, false);
  assert.equal(hostReleaseLabel({ serverVersion: 'stub-0.30', releaseVersion: '0.33.1' }), '0.33.1');
  assert.equal(hostReleaseLabel({ serverVersion: 'stub-0.30' }), 'Release unknown');
  assert.match(driverGuidance([], 'zh'), /Codex/);
  assert.equal(driverGuidance([{ status: 'ready' }]), null);
});
