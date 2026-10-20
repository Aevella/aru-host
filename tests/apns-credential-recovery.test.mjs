import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createAPNsCredentialStore } from '../apns-push.mjs';
test('Windows transient probe expires in the same store; absent and failed reads remain distinct', () => {
  let time = 0, calls = 0, result = { status: null, error: { code: 'ETIMEDOUT' } };
  const store = createAPNsCredentialStore({ platform: 'win32', now: () => time, run: () => { calls++; return result; } });
  assert.equal(store.availability().supported, false);
  assert.throws(() => store.read(), { code: 'apns.credential_storage_unavailable' });
  assert.equal(calls, 1);
  time = 5_001; result = { status: 0, stdout: '' };
  assert.equal(store.availability().supported, true);
  result = { status: 44 }; assert.equal(store.read(), null);
  result = { status: 1 }; assert.throws(() => store.read(), /APNs/);
  const privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const credentials = { teamId: 'TEAMID0000', keyId: 'AAAAAAAAAA', privateKey };
  result = { status: 0, stdout: 'aru-apns-v1:' + Buffer.from(JSON.stringify(credentials)).toString('base64url') };
  assert.deepEqual(store.read(), { ...credentials, privateKey: privateKey.trim() });
});
