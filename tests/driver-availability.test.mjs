import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaboratorHost } from '../collaborator-host.mjs';

test('driver inventory reports live capabilities without conversation statistics', t => {
  const directory = mkdtempSync(join(tmpdir(), 'aru-driver-availability-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = { hostedCollaborators: [], providerProfiles: [],
    agentDriverProbes: [{ id: 'codex', status: 'unavailable', checkedAt: 10 }] };
  let reads = 0;
  const host = createCollaboratorHost({
    dataDir: directory, managedWorkspaceRoot: directory, state,
    probeLocalDriver: definition => ({ id: definition.id, status: "unavailable", checkedAt: Date.now() }),
    saveState() {}, readJSONBody: async req => req.body, sendJSON() {}, HttpError: Error,
    providerSecretStore: { availability: () => ({ supported: true }), read: () => null },
    conversationHostFactory: () => ({ route: async () => false,
      status: () => { reads += 1; throw new Error("Driver inventory must not request history statistics"); } }),
  });
  assert.deepEqual(host.driverInventory().execution, { enabled: false, status: 'driver-unavailable' });
  state.agentDriverProbes[0].status = 'ready';
  const ready = host.driverInventory();
  assert.deepEqual(ready.execution, { enabled: true, status: 'ready' });
  assert.equal(ready.drivers.find(driver => driver.id === 'codex').status, 'ready');
  assert.equal(reads, 0);
});
