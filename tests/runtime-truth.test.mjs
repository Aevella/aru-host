import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHostAddress } from '../src/server/network-address.mjs';
import { createContainerReadiness } from '../src/server/container-readiness.mjs';
import { createNodeControl } from '../node-control.mjs';

const address = (ip) => ({ WiFi: [{ family: 'IPv4', internal: false, address: ip }] });
test('automatic LAN follows interface changes; fixed user origins and no-network are distinct', () => {
  const options = { mode: 'automatic-lan', fixedURL: 'https://example.com', port: 8787, host: 'host-test' };
  assert.equal(resolveHostAddress({ ...options, interfaces: address('192.168.1.2') }).url, 'http://192.168.1.2:8787');
  assert.equal(resolveHostAddress({ ...options, interfaces: address('10.1.1.2') }).url, 'http://10.1.1.2:8787');
  assert.equal(resolveHostAddress({ ...options, mode: 'fixed', interfaces: address('10.1.1.2') }).url, 'https://example.com');
  assert.equal(resolveHostAddress({ ...options, interfaces: {} }).status, 'no-lan-interface');
  assert.equal(resolveHostAddress({ ...options, interfaces: {} }).url, 'http://host-test.local:8787');
});
test('address choice belongs to revision checked node settings and survives restart', () => {
  const state = {}; let saves = 0;
  const create = (config) => createNodeControl({ config, state, saveState: () => saves++, log() {},
    HttpError: class extends Error { constructor(status, code, message) { super(message); this.status = status; } } });
  const config = { displayName: 'Host', addressMode: 'fixed', transportKind: 'lan' };
  const owner = create(config);
  owner.updateSettings({ schema: 'aru.selfhost.node-settings.v1', expectedRevision: 1, displayName: 'Host', addressMode: 'automatic-lan' }, { deviceId: 'test' });
  assert.equal(config.addressMode, 'automatic-lan');
  const restarted = { ...config, addressMode: 'fixed' }; create(restarted);
  assert.equal(restarted.addressMode, 'automatic-lan');
  assert.throws(() => owner.updateSettings({ schema: 'aru.selfhost.node-settings.v1', expectedRevision: 1, displayName: 'Host', addressMode: 'fixed' }, {}));
  assert.equal(saves, 1);
});
test('Core verification coalesces, reports actual failure, and repairs on retry', async () => {
  let complete; let calls = 0;
  const config = { containerRuntime: 'runtime', runtimeImages: {} };
  const owner = createContainerReadiness(config, () => { calls++; return new Promise((resolve, reject) => { complete = { resolve, reject }; }); });
  const first = owner.check(); assert.equal(owner.check(), first);
  await Promise.resolve(); complete.reject(new Error('service environment cannot mount'));
  assert.equal((await first).status, 'failed'); assert.equal(owner.ready(), false);
  const next = owner.check(); await Promise.resolve(); complete.resolve();
  assert.equal((await next).status, 'ready'); assert.equal(calls, 2);
  assert.equal((await createContainerReadiness({ containerRuntime: null }).check()).status, 'unconfigured');
});
test('failed address persistence cannot publish a different mode', () => {
  const config = { displayName: 'Host', addressMode: 'fixed', transportKind: 'lan' }, state = {};
  const owner = createNodeControl({ config, state, saveState() { throw new Error('disk full'); }, log() {} });
  assert.throws(() => owner.updateSettings({ schema: 'aru.selfhost.node-settings.v1', expectedRevision: 1, displayName: 'Host', addressMode: 'automatic-lan' }, {}), /disk full/);
  assert.equal(config.addressMode, 'fixed'); assert.equal(owner.publicSettings().revision, 1);
});
