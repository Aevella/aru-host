import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

// Exercise the actual writer with an isolated filesystem and controlled writes.
const source = fs.readFileSync(new URL('../aru-selfhost-stub.mjs', import.meta.url), 'utf8');
const writer = source.slice(source.indexOf('function saveState()'), source.indexOf('function recoverInterruptedJobs()'));
test('backup retains the last committed revision, never a damaged primary', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'aru-backup-'));
  const statePath = join(root, 'state.json');
  const context = vm.createContext({ ...fs, process, statePath, state: { revision: 1 }, lastPersistedState: null });
  try {
    vm.runInContext(writer, context);
    vm.runInContext('saveState()', context);
    const first = fs.readFileSync(statePath, 'utf8');
    context.state = { revision: 2 };
    vm.runInContext('saveState()', context);
    assert.equal(fs.readFileSync(`${statePath}.bak`, 'utf8'), first);
    const second = fs.readFileSync(statePath, 'utf8');
    fs.writeFileSync(statePath, '{damaged');
    context.state = { revision: 3 };
    vm.runInContext('saveState()', context);
    assert.equal(fs.readFileSync(`${statePath}.bak`, 'utf8'), second);
    const third = fs.readFileSync(statePath, 'utf8');
    // Failed backup publication must prevent committing a new primary.
    fs.unlinkSync(`${statePath}.bak`);
    fs.mkdirSync(`${statePath}.bak`);
    context.state = { revision: 4 };
    assert.throws(() => vm.runInContext('saveState()', context));
    assert.equal(fs.readFileSync(statePath, 'utf8'), third);
    assert.equal(context.lastPersistedState, third);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
