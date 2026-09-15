import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostStateStore } from '../src/server/state-store.mjs';

test('backup retains the last committed revision, never a damaged primary', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'aru-backup-'));
  const statePath = join(root, 'state.json');
  const store = createHostStateStore({ statePath });
  let state = { revision: 1 };
  try {
    store.save(state);
    const first = fs.readFileSync(statePath, 'utf8');
    state = { revision: 2 };
    store.save(state);
    assert.equal(fs.readFileSync(`${statePath}.bak`, 'utf8'), first);
    const second = fs.readFileSync(statePath, 'utf8');
    fs.writeFileSync(statePath, '{damaged');
    state = { revision: 3 };
    store.save(state);
    assert.equal(fs.readFileSync(`${statePath}.bak`, 'utf8'), second);
    const third = fs.readFileSync(statePath, 'utf8');
    // Failed backup publication must prevent committing a new primary.
    fs.unlinkSync(`${statePath}.bak`);
    fs.mkdirSync(`${statePath}.bak`);
    state = { revision: 4 };
    assert.throws(() => store.save(state));
    assert.equal(fs.readFileSync(statePath, 'utf8'), third);
    fs.rmSync(`${statePath}.bak`, { recursive: true });
    store.save({ revision: 5 });
    assert.equal(fs.readFileSync(`${statePath}.bak`, "utf8"), third);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
