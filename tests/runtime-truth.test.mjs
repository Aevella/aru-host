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
test('additional routes persist, retain LAN, survive rename-only clients and can be removed', () => {
  let disk;
  const state = {};
  const config = { displayName: 'Example Host', transportKind: 'lan', baseUrl: 'http://example.local:8787' };
  const make = state => createNodeControl({ config, state, saveState: () => disk = JSON.stringify(state), log() {},
    HttpError: class extends Error { constructor(status, code, message) { super(message); this.status = status; } } });
  const owner = make(state);
  const update = (expectedRevision, extra = {}) => ({ schema: 'aru.selfhost.node-settings.v1', displayName: 'Example Host', expectedRevision, ...extra });
  const additionalTransports = [{ id: 'tailnet', kind: 'tailscale', baseUrl: 'http://100.100.100.100:8787/', priority: 20 },
    { id: 'web', kind: 'public-https', baseUrl: 'https://host.example.com', priority: 20 }];
  owner.updateSettings(update(1, { additionalTransports }), { deviceId: 'example-device' });
  assert.equal(owner.transportProfiles().length, 3);
  assert.equal(owner.transportProfiles()[0].baseUrl, config.baseUrl);
  const reopened = JSON.parse(disk); const restarted = make(reopened);
  assert.deepEqual(restarted.transportProfiles(), owner.transportProfiles());
  restarted.updateSettings(update(2, { displayName: 'Renamed Host' }), { deviceId: 'old-client' });
  assert.equal(restarted.transportProfiles().length, 3);
  assert.throws(() => restarted.updateSettings(update(2, { additionalTransports: [] }), {}), /changed/);
  restarted.updateSettings(update(3, { additionalTransports: [] }), {});
  assert.equal(restarted.transportProfiles().length, 1);
});
test('invalid or failed route saves retain the previous durable projection', () => {
  const state = {}, config = { displayName: 'Host', transportKind: 'lan', baseUrl: 'http://example.local:8787' };
  let fail = false;
  const owner = createNodeControl({ state, config, log() {}, saveState() { if (fail) throw new Error('disk full'); },
    HttpError: class extends Error { constructor(status, code, message) { super(message); } } });
  const body = additionalTransports => ({ schema: 'aru.selfhost.node-settings.v1', displayName: 'Host', expectedRevision: 1, additionalTransports });
  for (const entry of [
    { id: 'x', kind: 'public-https', baseUrl: 'http://example.com' },
    { id: 'x', kind: 'tailscale', baseUrl: 'http://example.com' },
    { id: 'primary', kind: 'tailscale', baseUrl: 'http://100.100.100.100:8787' },
    { id: 'x', kind: 'public-https', baseUrl: 'https://name:secret@example.com' },
    { id: 'x', kind: 'public-https', baseUrl: 'https://example.com/path' },
  ]) assert.throws(() => owner.updateSettings(body([entry]), {}));
  const route = { id: 'x', kind: 'tailscale', baseUrl: 'http://100.100.100.100:8787' };
  assert.throws(() => owner.updateSettings(body([route, route]), {}));
  fail = true;
  assert.throws(() => owner.updateSettings(body([route]), {}), /disk full/);
  assert.equal(owner.publicSettings().revision, 1);
  assert.equal(owner.transportProfiles().length, 1);
});
