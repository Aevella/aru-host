import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderSecretStore } from '../provider-secret-store.mjs';
import { createProviderProfileHost } from '../provider-profiles.mjs';
import { createCollaboratorHost } from '../collaborator-host.mjs';
import { createDirectAPIDriver } from '../direct-api-driver.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('real collaborator manifest projection never performs credential IO while startup probe is pending', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aru-provider-projection-'));
  const pending = deferred(); let calls = 0;
  const store = createProviderSecretStore({ platform: 'win32', run: () => { calls++; return pending.promise; } });
  const host = createCollaboratorHost({ dataDir: directory, managedWorkspaceRoot: directory,
    state: { providerProfiles: [{ profileId: 'provider_aaaa', authMode: 'bearer', revision: 1 }] }, saveState() {},
    providerSecretStore: store, probeLocalDriver: definition => ({ id: definition.id, status: 'unavailable', checkedAt: 1 }),
    conversationHostFactory: () => ({ recoverReplicaDelivery: () => null, status: () => ({ activeTurnCount: 0 }) }) });
  t.after(() => { pending.resolve({ status: 1 }); host.stop(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 20; i++) {
    assert.equal(host.driverInventory().execution.enabled, true, 'unverified credentials allow an explicit attempt');
  }
  assert.equal(calls, 1, 'manifest polling must reuse projection, not re-read secrets');
});

test('late credential inspection cannot override a newer profile revision', async () => {
  const pending = deferred(); const entered = deferred();
  const profile = { profileId: 'provider_aaaa', authMode: 'bearer', revision: 1 };
  let secret = null;
  const host = createProviderProfileHost({ state: { providerProfiles: [profile] }, secretStore: {
    availability: () => ({ supported: true }), read: () => { entered.resolve(); return pending.promise; },
  } });
  await entered.promise;
  profile.revision = 2;
  pending.resolve(secret);
  await host.refresh();
  assert.equal(host.inventory().profiles[0].credentialState, 'checking', 'stale missing observation is not applied');
});

test('cancel during asynchronous key read ends startup and late key cannot send a model request', async () => {
  const pending = deferred(); let sent = 0;
  const controller = new AbortController();
  const driver = createDirectAPIDriver({ profileForId: () => ({ authMode: 'bearer', credentialState: 'unavailable' }),
    readSecret: () => pending.promise, fetchImpl: async () => { sent++; throw new Error('must not send'); } }).forProfile('provider_aaaa');
  assert.equal(driver.status(), 'ready');
  const attempt = driver.startTurn({ signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(attempt, /cancelled/);
  pending.resolve('synthetic-key');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 0);
});

test('profile mutations remain serialized across asynchronous OS writes', async () => {
  class HttpError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } }
  const profile = { profileId: 'provider_aaaa', authMode: 'bearer', revision: 1,
    displayName: 'Synthetic', protocol: 'openai-compatible', baseURL: 'https://example.invalid', path: 'v1/chat/completions', model: 'test' };
  const pending = deferred(), entered = deferred(); let writes = 0;
  const host = createProviderProfileHost({ state: { providerProfiles: [profile] }, HttpError, saveState() {},
    readJSONBody: async req => req.body, sendJSON() {}, testProfile: async () => {}, secretStore: {
      availability: () => ({ supported: true }), read: () => 'existing',
      write: async () => { writes++; entered.resolve(); await pending.promise; },
    } });
  await host.refresh();
  const update = () => host.route({ method: 'PUT', body: { ...profile, expectedRevision: 1, apiKey: 'synthetic' } }, {},
    '/aru/v1/provider-profiles/provider_aaaa', () => ({ deviceRole: 'host-console' }));
  const first = update(); await entered.promise;
  const second = assert.rejects(update(), error => error.status === 409);
  pending.resolve(); await first; await second;
  assert.equal(writes, 1);
  assert.equal(profile.revision, 2);
});

test('async credential subprocess receives secret input on stdin', async () => {
  const { runSecretCommand } = await import('../provider-secret-store.mjs');
  const result = await runSecretCommand(process.execPath, ['-e',
    'let value="";process.stdin.on("data",x=>value+=x);process.stdin.on("end",()=>process.stdout.write(String(value.length)));'],
    { input: 'synthetic\n', encoding: 'utf8', timeout: 2_000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '10');
});

test('a slow failed probe gets backoff after completion instead of immediately probing again', async () => {
  let now = 0, calls = 0;
  const store = createProviderSecretStore({ platform: 'win32', now: () => now,
    run: async () => { calls++; now += 10_000; return { status: null, error: { code: 'ETIMEDOUT' } }; } });
  assert.equal((await store.availability()).supported, false);
  await assert.rejects(store.read('provider_aaaa'), /安全凭据存储/);
  assert.equal(calls, 1);
});

test('a key read across a profile revision change cannot send credentials to the previous endpoint', async () => {
  const pending = deferred(); let revision = 1, sent = 0;
  const driver = createDirectAPIDriver({ profileForId: () => ({ authMode: 'bearer', revision }),
    readSecret: () => pending.promise, fetchImpl: async () => { sent++; } }).forProfile('provider_aaaa');
  const attempt = driver.startTurn({});
  revision = 2; pending.resolve('synthetic-new-key');
  await assert.rejects(attempt, /配置已改变/);
  assert.equal(sent, 0);
});
