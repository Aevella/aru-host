import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createBackupSnapshotStore } from "../src/server/backup-snapshot-store.mjs";
const hash = data => createHash("sha256").update(data).digest("hex");
function fixture(t, fault = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "aru-snapshot-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reopen = (hook = fault) => createBackupSnapshotStore({ directory, fault: hook });
  return { directory, reopen, store: reopen() };
}
function body(store, ids, suffix = 1) {
  const bytes = Buffer.concat([Buffer.from("ARUSNAP1"), Buffer.from(store.repository().saltHex, "hex"), Buffer.alloc(40, suffix)]);
  return Buffer.from(JSON.stringify({ manifest: bytes.toString("base64"), chunks: ids }));
}
function upload(store, draft, id = "a".repeat(64)) {
  const data = Buffer.alloc(90, 7);
  return store.putChunk(draft.id, draft.deviceId, id, data, hash(data));
}
test("two snapshots share a chunk; deletion preserves every remaining owner", async t => {
  const f = fixture(t), s = f.store;
  const first = s.begin("device-a");
  const chunk = upload(s, first);
  const firstBody = body(s, [chunk.id]);
  await s.commit(first.id, first.deviceId, firstBody, {});
  assert.equal(s.inventory().length, 1);
  const second = s.begin("device-a");
  assert.deepEqual(s.retainChunk(second.id, second.deviceId, chunk.id), chunk);
  await s.commit(second.id, second.deviceId, body(s, [chunk.id], 2), {});
  s.remove(first.id);
  assert.equal(s.getChunk(second.id, chunk.id).length, 90);
  s.remove(second.id);
  assert.equal(existsSync(join(f.directory, "chunks", chunk.id)), false);
});
test("draft references survive restart and missing dependencies block publication", async t => {
  const f = fixture(t);
  const draft = f.store.begin("device-a");
  const chunk = upload(f.store, draft);
  const s = f.reopen();
  assert.equal(s.begin("device-a").id, draft.id);
  assert.equal(s.collect(), 0);
  await assert.rejects(async () => await s.commit(draft.id, draft.deviceId, body(s, ["b".repeat(64)]), {}));
  assert.equal(s.inventory().length, 0);
  assert.throws(() => s.putChunk(draft.id, "other-device", chunk.id, Buffer.alloc(90), hash(Buffer.alloc(90))));
  s.cancel(draft.id, draft.deviceId);
  assert.throws(() => upload(s, draft), /ENOENT/);
  assert.equal(existsSync(join(f.directory, "chunks", chunk.id)), false);
});
for (const boundary of ["after-chunk-reference", "after-chunk-file", "after-manifest-file", "after-publication"]) {
  test(`restart after ${boundary} preserves identity and commits once`, async t => {
    let interrupted = false;
    const f = fixture(t, point => { if (!interrupted && point === boundary) { interrupted = true; throw new Error("synthetic crash"); } });
    const draft = f.store.begin("device-a");
    const id = "a".repeat(64);
    const bytes = body(f.store, [id]);
    try { upload(f.store, draft, id); await f.store.commit(draft.id, draft.deviceId, bytes, {}); } catch {}
    const s = f.reopen(() => {});
    if (boundary !== "after-publication") upload(s, draft, id);
    const result = await s.commit(draft.id, draft.deviceId, bytes, {});
    assert.equal(result.id, draft.id);
    assert.equal(s.inventory().length, 1);
    assert.deepEqual(await s.commit(draft.id, draft.deviceId, bytes, {}), result);
    assert.equal(s.getChunk(draft.id, id).length, 90);
    assert.notEqual(s.begin("device-a").id, draft.id);
  });
}
test("corrupt index or content never permits false success or orphan collection", async t => {
  const f = fixture(t), s = f.store;
  const draft = s.begin("device-a"), chunk = upload(s, draft);
  const file = join(f.directory, "chunks", chunk.id);
  const original = readFileSync(file);
  const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
  writeFileSync(file, corrupt);
  // Admission checks header/size only; full authentication remains a publication gate.
  assert.equal(s.retainChunk(draft.id, draft.deviceId, chunk.id).id, chunk.id);
  await assert.rejects(async () => await s.commit(draft.id, draft.deviceId, body(s, [chunk.id]), {}));
  assert.equal(s.inventory().length, 0);
  writeFileSync(join(f.directory, "drafts", `${draft.id}.json`), "malformed");
  assert.throws(() => s.collect());
  assert.equal(existsSync(file), true);
  writeFileSync(join(f.directory, "repository.json"), "malformed");
  assert.throws(() => f.reopen());
});

test("published manifest references protect chunks even when index is damaged", async t => {
  const f = fixture(t), s = f.store;
  const draft = s.begin("device-a"), chunk = upload(s, draft);
  await s.commit(draft.id, draft.deviceId, body(s, [chunk.id]), {});
  const recordPath = join(f.directory, "snapshots", `${draft.id}.json`);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.chunks = [];
  writeFileSync(recordPath, JSON.stringify(record));
  assert.throws(() => s.collect(), /references_corrupt/);
  assert.equal(existsSync(join(f.directory, "chunks", chunk.id)), true);
});

test("verification yields and cancelled attempts cannot publish late", async t => {
  const f = fixture(t), s = f.store;
  const draft = s.begin("device-a");
  const a = upload(s, draft), b = upload(s, draft, "b".repeat(64));
  const pending = s.commit(draft.id, draft.deviceId, body(s, [a.id, b.id]), {});
  s.cancel(draft.id, draft.deviceId);
  await assert.rejects(pending);
  assert.equal(s.inventory().length, 0);
});
test("deleted snapshot cannot be resurrected by a lost receipt retry", async t => {
  const f = fixture(t), s = f.store;
  const draft = s.begin("device-a"), chunk = upload(s, draft);
  const bytes = body(s, [chunk.id]);
  let publications = 0;
  await s.commit(draft.id, draft.deviceId, bytes, {}, () => { publications++; });
  await s.commit(draft.id, draft.deviceId, bytes, {}, () => { publications++; });
  assert.equal(publications, 1);
  s.remove(draft.id);
  await assert.rejects(s.commit(draft.id, draft.deviceId, bytes, {}), /snapshot.deleted/);
  assert.equal(s.inventory().length, 0);
});

test('batch admission appends linear references and full verification gates publication', async t => {
  const f = fixture(t), s = f.store;
  const draft = s.begin('writer');
  const ids = Array.from({ length: 512 }, (_, i) => hash(Buffer.from(String(i))));
  for (const id of ids) upload(s, draft, id);
  const base = readFileSync(join(f.directory, 'drafts', `${draft.id}.json`));
  const log = readFileSync(join(f.directory, 'drafts', `${draft.id}.refs`));
  assert.ok(base.length < 1024);
  assert.ok(log.length < ids.length * 400);
  await s.commit(draft.id, draft.deviceId, body(s, ids), {});
  const next = s.begin('writer');
  for (let i = 0; i < ids.length; i += 128) assert.equal(s.retainChunks(next.id, next.deviceId, ids.slice(i, i + 128)).length, 128);
  const lines = readFileSync(join(f.directory, 'drafts', `${next.id}.refs`), 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  const reopened = f.reopen();
  assert.equal(reopened.begin('writer').chunks.length, 512);
  await reopened.commit(next.id, next.deviceId, body(reopened, ids, 2), {});
  reopened.remove(draft.id);
  assert.equal(reopened.getChunk(next.id, ids[0]).length, 90);
});

test('unacknowledged torn reference tail recovers; malformed committed lines fail closed', t => {
  const f = fixture(t), s = f.store, draft = s.begin('writer');
  const chunk = upload(s, draft);
  const path = join(f.directory, 'drafts', `${draft.id}.refs`);
  const complete = readFileSync(path);
  writeFileSync(path, Buffer.concat([complete, Buffer.from('[{"id":')]));
  assert.equal(f.reopen().begin('writer').chunks[0].id, chunk.id);
  assert.deepEqual(readFileSync(path), complete);
  const damaged = Buffer.from(complete); damaged[0] = 33;
  writeFileSync(path, damaged);
  assert.throws(() => f.reopen().collect());
  assert.ok(existsSync(join(f.directory, 'chunks', chunk.id)));
});

test("unknown deletion creates no tombstone; admitted deletion remains repeatable after restart", t => {
  const f = fixture(t);
  assert.throws(() => f.store.remove("missing-backup"), /snapshot.unknown/);
  assert.equal(existsSync(join(f.directory, "deleted", "missing-backup.json")), false);
  const draft = f.store.begin("device-a");
  f.store.remove(draft.id);
  const reopened = createBackupSnapshotStore({ directory: f.directory });
  reopened.remove(draft.id);
  assert.equal(existsSync(join(f.directory, "deleted", `${draft.id}.json`)), true);
});
