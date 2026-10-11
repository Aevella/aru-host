import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionOrigin, verifyConnectionAddress } from '../src/connection-address.mjs';

test('connection origins follow Core public HTTPS and Tailscale admission', () => {
  assert.equal(connectionOrigin('public-https', ' https://host.example.com:443/ '), 'https://host.example.com');
  assert.equal(connectionOrigin('tailscale', 'http://100.64.0.1:8787'), 'http://100.64.0.1:8787');
  assert.equal(connectionOrigin('tailscale', 'http://machine.example.ts.net'), 'http://machine.example.ts.net');
  for (const [kind, url] of [
    ['public-https', 'http://host.example.com'], ['tailscale', 'http://100.128.0.1'],
    ['tailscale', 'http://127.0.0.1:8787'], ['public-https', 'https://name:secret@host.example.com'],
    ['public-https', 'https://host.example.com/path'], ['public-https', 'https://host.example.com/?q=x'],
    ['public-https', 'https://host.example.com/#fragment'], ['unknown', 'https://host.example.com'],
  ]) assert.throws(() => connectionOrigin(kind, url));
});

test('check reads only the public manifest without credentials or redirects', async () => {
  let requests = 0;
  const result = await verifyConnectionAddress('public-https', 'https://host.example.com', 'test-host', {
    fetchManifest: async (url, options) => {
      requests++;
      assert.equal(url, 'https://host.example.com/.well-known/aru.json');
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => ({ serverId: 'test-host' }) };
    },
  });
  assert.equal(requests, 1); assert.equal(result.serverId, 'test-host');
});

test('wrong Host, malformed manifest and non-success response never verify', async () => {
  for (const response of [
    { ok: true, json: async () => ({ serverId: 'different-host' }) },
    { ok: true, json: async () => ({}) },
    { ok: true, json: async () => { throw Error('invalid JSON'); } },
    { ok: false, status: 403 },
  ]) await assert.rejects(verifyConnectionAddress('public-https', 'https://host.example.com', 'test-host', { fetchManifest: async () => response }));
});

test('check bounds body reads, and a new attempt can succeed after timeout', async () => {
  let aborted = false;
  await assert.rejects(verifyConnectionAddress('public-https', 'https://host.example.com', 'test-host', {
    timeoutMs: 10,
    fetchManifest: async (_, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(Error('timeout')); });
    }) }),
  }), /timeout/);
  assert.equal(aborted, true);
  await verifyConnectionAddress('public-https', 'https://host.example.com', 'test-host', {
    fetchManifest: async () => ({ ok: true, json: async () => ({ serverId: 'test-host' }) }),
  });
});

test('invalid origin or absent local identity does not initiate a request', async () => {
  const options = { fetchManifest: async () => assert.fail('unexpected outbound request') };
  await assert.rejects(verifyConnectionAddress('public-https', 'http://host.example.com', 'test-host', options));
  await assert.rejects(verifyConnectionAddress('public-https', 'https://host.example.com', undefined, options));
});
