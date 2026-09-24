import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createProviderSecretStore } from '../provider-secret-store.mjs';

test('headless credentials survive reopening, update atomically and delete without a desktop bus', () => {
  const root = mkdtempSync(join(tmpdir(), 'aru-credentials-'));
  try {
    chmodSync(root, 0o700);
    writeFileSync(join(root, 'master.key'), randomBytes(32), { mode: 0o600 });
    const open = () => createProviderSecretStore({ platform: 'linux', env: { ARU_PROVIDER_SECRET_ROOT: root }, run() { throw Error('must not call Secret Service'); } });
    const store = open();
    assert.equal(store.availability().supported, true);
    store.write('provider_abc', 'secret-one');
    assert.equal(readFileSync(join(root, 'provider_abc.sealed')).includes(Buffer.from('secret-one')), false);
    assert.equal(open().read('provider_abc'), 'secret-one');
    store.write('provider_abc', 'secret-two');
    assert.equal(open().read('provider_abc'), 'secret-two');
    assert.throws(() => store.read('../escape'));
    const bytes = readFileSync(join(root, 'provider_abc.sealed')); bytes[bytes.length - 1] ^= 1;
    writeFileSync(join(root, 'provider_abc.sealed'), bytes);
    assert.throws(() => open().read('provider_abc'));
    store.remove('provider_abc');
    store.remove('provider_abc');
    assert.equal(store.read('provider_abc'), null);
    unlinkSync(join(root, 'master.key'));
    assert.equal(open().availability().supported, false);
    assert.throws(() => open().write('provider_abc', 'new'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unsafe key permissions fail closed and recover once repaired', () => {
  const root = mkdtempSync(join(tmpdir(), 'aru-credentials-'));
  try {
    chmodSync(root, 0o700); writeFileSync(join(root, 'master.key'), randomBytes(32), { mode: 0o600 });
    const store = createProviderSecretStore({ platform: 'linux', env: { ARU_PROVIDER_SECRET_ROOT: root } });
    chmodSync(join(root, 'master.key'), 0o644); assert.equal(store.availability().supported, false);
    chmodSync(join(root, 'master.key'), 0o600); assert.equal(store.availability().supported, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a damaged profile key stays visible and can be replaced without replacing the profile', async () => {
  const { createProviderProfileHost } = await import('../provider-profiles.mjs');
  const root = mkdtempSync(join(tmpdir(), 'aru-credentials-'));
  try {
    chmodSync(root, 0o700); writeFileSync(join(root, 'master.key'), randomBytes(32), { mode: 0o600 });
    const store = createProviderSecretStore({ platform: 'linux', env: { ARU_PROVIDER_SECRET_ROOT: root } });
    store.write('provider_abc', 'before');
    writeFileSync(join(root, 'provider_abc.sealed'), 'damaged');
    const state = { providerProfiles: [{profileId:'provider_abc',authMode:'bearer',displayName:'Existing profile'}] };
    const host = createProviderProfileHost({state,secretStore:store});
    const broken = host.inventory();
    assert.equal(broken.profiles.length, 1); assert.equal(broken.profiles[0].hasSecret, false);
    assert.match(broken.profiles[0].lastError, /API Key/);
    store.write('provider_abc', 'repaired');
    assert.equal(host.inventory().profiles[0].hasSecret, true);
    assert.equal(state.providerProfiles[0].profileId, 'provider_abc');
    assert.equal(readFileSync(join(root, 'legacy-import-complete'),'utf8'), '1\n');
  } finally { rmSync(root, {recursive:true,force:true}); }
});
