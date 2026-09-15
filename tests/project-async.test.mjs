import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProjectCommand, createCollaboratorProjectHost } from '../collaborator-projects.mjs';

test('a pending child process leaves the Host event loop available', async () => {
  let ticked = false;
  let settled = false;
  const result = runProjectCommand(process.execPath, ['-e', 'setTimeout(() => console.log("ok"), 100)'], { encoding: 'utf8', timeout: 2000 });
  result.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(() => { ticked = true; resolve(); }));
  assert.equal(ticked, true);
  assert.equal(settled, false);
  assert.equal((await result).stdout.trim(), 'ok');
  const failure = await runProjectCommand(process.execPath, ['-e', 'process.exit(7)'], { encoding: 'utf8' });
  assert.equal(failure.status, 7);
});

test('a checkpoint cannot overwrite an archive while its compressor awaits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aru-project-async-'));
  let unblock, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let artifactCount = 0;
  class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const host = createCollaboratorProjectHost({
    dataDir: root, surfaces: {}, HttpError,
    createArtifact() { artifactCount++; return { artifactId: 'unexpected' }; },
    readJSONBody: async req => req.body, sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    runCommand: async () => { entered(); await new Promise(resolve => { unblock = resolve; }); return { status: 0, stdout: Buffer.from('archive') }; },
  });
  const id = 'hostcol_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  async function call(method, path, body) {
    const res = {}; await host.route({ method, body }, res, `/aru/v1/hosted-collaborators/${id}/projects${path}`, () => ({ deviceId: 'test' }), () => ({ collaboratorId: id })); return res.body;
  }
  try {
    const created = await call('POST', '', { title: 'Test', entryPath: 'index.html' });
    const pending = call('POST', `/${created.projectId}/checkpoint`, { expectedRevision: 1 });
    const rejected = assert.rejects(pending, error => error.code === 'project.revision_conflict');
    await waiting;
    const archived = await call('POST', `/${created.projectId}/archive`, { expectedRevision: 1 });
    unblock(); await rejected;
    const latest = await host.project(id, created.projectId);
    assert.equal(latest.revision, archived.revision);
    assert.notEqual(latest.archivedAt, null);
    assert.equal(latest.checkpointCount, 0);
    assert.equal(artifactCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
