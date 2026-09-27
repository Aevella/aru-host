import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaboratorHost } from '../collaborator-host.mjs';

test('driver capability reads do not request conversation statistics; full inventory reads once', t => {
  const directory = mkdtempSync(join(tmpdir(), 'aru-driver-availability-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = { hostedCollaborators: [], providerProfiles: [],
    agentDriverProbes: [{ id: 'codex', status: 'unavailable', checkedAt: 10 }] };
  let reads = 0;
  let counts = { conversationCount: 7, activeTurnCount: 2, pendingApprovalCount: 3 };
  const host = createCollaboratorHost({
    dataDir: directory, managedWorkspaceRoot: directory, state,
    saveState() {}, readJSONBody: async req => req.body, sendJSON() {}, HttpError: Error,
    providerSecretStore: { availability: () => ({ supported: true }), read: () => null },
    conversationHostFactory: () => ({ route: async () => false,
      status: () => { reads += 1; return { ...counts }; } }),
  });
  // The public inventory retains its existing fields, from one coherent read.
  const inventory = host.driverInventory();
  assert.deepEqual(inventory.execution, { enabled: false, status: 'driver-unavailable', ...counts });
  assert.equal(reads, 1);
  reads = 0;
  assert.equal(host.driverAvailability().execution.enabled, false);
  state.agentDriverProbes[0].status = 'ready';
  const ready = host.driverAvailability();
  assert.equal(ready.execution.enabled, true);
  assert.equal(ready.drivers.find(driver => driver.id === 'codex').status, 'ready');
  assert.equal('conversationCount' in ready.execution, false);
  assert.equal(reads, 0);
  counts = { conversationCount: 8, activeTurnCount: 0, pendingApprovalCount: 1 };
  assert.deepEqual(host.driverInventory().execution, { enabled: true, status: 'ready', ...counts });
  assert.equal(reads, 1);
});
