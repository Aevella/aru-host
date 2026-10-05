import test from 'node:test';
import assert from 'node:assert/strict';
import { createMCPGateway } from '../src/server/mcp-gateway.mjs';

test('backup tools project both owners and dispatch deletion with paired actor', async () => {
  const deleted = [];
  const gateway = createMCPGateway({
    state: { packages: [] },
    backupInventory: () => [
      { remotePackageId: 'r_old', uploadedAt: 1, metadata: { packageByteCount: 100 } },
      { remotePackageId: 'snapshot', uploadedAt: 2, metadata: {
        envelopeFormat: 'aru-native-backup-snapshot', packageByteCount: 20, plaintextByteCount: 5000,
      } },
    ],
    deleteBackupPackage: (id, actor) => { deleted.push([id, actor]); return { remotePackageId: id, deleted: true }; },
    officialMCPTools: () => [
      { name: 'aru_backup_inventory', inputSchema: {} },
      { name: 'aru_backup_delete', inputSchema: { properties: { remotePackageId: { type: 'string' } }, required: ['remotePackageId'] } },
    ],
    getPluginSupervisor: () => ({ dynamicMCPTools: () => [] }),
    getNodeWorkspaceHost: () => ({ callTool: () => ({ matched: false }) }),
    HttpError: Error,
  });
  const inventory = await gateway.executeMCPTool('aru_backup_inventory', {}, { deviceId: 'phone' });
  assert.deepEqual(inventory.packages.map(p => p.remotePackageId), ['snapshot', 'r_old']);
  assert.equal(inventory.packages[0].plaintextByteCount, 5000);
  assert.equal(inventory.packages[0].packageByteCount, 20);
  assert.equal(inventory.packages[0].envelopeFormat, 'aru-native-backup-snapshot');
  await gateway.executeMCPTool('aru_backup_delete', { remotePackageId: 'snapshot' }, { deviceId: 'phone' });
  assert.deepEqual(deleted, [['snapshot', 'phone']]);
});

test('retention spans formats and preserves the just-verified point even at a timestamp tie', async () => {
  const { createBackupSettings } = await import('../src/host/backup-settings.mjs');
  const state = { packages: [{ remotePackageId: 'r_old', uploadedAt: 10 }],
    backupSettings: { retentionMode: 'keep-latest', keepLatestCount: 1 } };
  let snapshots = [{ remotePackageId: 'z_new', uploadedAt: 10 }];
  const removed = [];
  const settings = createBackupSettings({ state, saveState: () => {}, log: () => {},
    packageInventory: () => [...state.packages, ...snapshots],
    deletePackage: id => { removed.push(id); state.packages = state.packages.filter(p => p.remotePackageId !== id); snapshots = snapshots.filter(p => p.remotePackageId !== id); },
  });
  settings.applyRetention('fixture', 'z_new');
  assert.deepEqual(removed, ['r_old']);
  assert.equal(snapshots[0].remotePackageId, 'z_new');
});
