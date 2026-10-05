import { createDraftReferences } from "./backup-snapshot-references.mjs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, readSync, fsyncSync, renameSync, unlinkSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldEventLoop } from "node:timers/promises";

const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identity = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const fail = (code) => { throw new Error(`backup.snapshot.${code}`); };
const maxChunkBytes = 4 * 1024 * 1024 + 28;

/** Opaque encrypted snapshot storage. Reference admission, publication and
 * collection are synchronous. Full verification yields between bounded chunks,
 * then re-admits the draft before publishing, so backup cannot monopolize Host. */
export function createBackupSnapshotStore({ directory, fault = () => {} }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of ["chunks", "snapshots", "drafts", "deleted"]) mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
  const repositoryPath = join(directory, "repository.json");
  const references = createDraftReferences({ atomic });
  const referencePath = id => join(directory, "drafts", `${id}.refs`);
  let repository;
  try { repository = JSON.parse(readFileSync(repositoryPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (exists(repositoryPath)) fail("repository_unreadable");
    if (["chunks", "snapshots", "drafts", "deleted"].some((folder) => readdirSync(join(directory, folder)).length > 0)) fail("repository_missing");
    repository = { format: "aru.backup.repository.v1", saltHex: randomBytes(16).toString("hex") };
    atomic(repositoryPath, Buffer.from(JSON.stringify(repository)));
  }
  if (repository.format !== "aru.backup.repository.v1" || !/^[a-f0-9]{32}$/.test(repository.saltHex)) fail("repository_invalid");

  function atomic(path, data) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temporary, path); syncDirectory(path.slice(0, path.lastIndexOf("/"))); }
    finally { if (exists(temporary)) unlinkSync(temporary); }
  }
  function syncDirectory(path) {
    if (process.platform === "win32") return;
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  function exists(path) {
    try { lstatSync(path); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  function path(folder, id) {
    if (!identity(id)) fail("identity_invalid");
    return join(directory, folder, `${id}.json`);
  }
  function chunkPath(id) {
    if (!digest(id)) fail("chunk_identity_invalid");
    return join(directory, "chunks", id);
  }
  function readRecord(folder, id, includeReferences = true) {
    const record = JSON.parse(readFileSync(path(folder, id), "utf8"));
    if (folder === "drafts" && includeReferences) {
      const merged = new Map(record.chunks.map(item => [item.id, item]));
      for (const item of references.read(referencePath(id))) merged.set(item.id, item);
      record.chunks = [...merged.values()];
    }
    validateRecord(record, folder === "snapshots");
    if (record.id !== id) fail("record_identity_mismatch");
    return record;
  }
  function validateRecord(record, published) {
    if (!record || record.format !== "aru.backup.snapshot-record.v1" || !identity(record.id)
        || typeof record.deviceId !== "string" || !record.deviceId || !Array.isArray(record.chunks)
        || !record.chunks.every((item) => digest(item.id) && digest(item.sha256)
          && Number.isSafeInteger(item.byteCount) && item.byteCount > 28 && item.byteCount <= maxChunkBytes)
        || new Set(record.chunks.map((item) => item.id)).size !== record.chunks.length) fail("record_invalid");
    if (published && (!digest(record.manifestSHA256) || !Number.isSafeInteger(record.manifestByteCount)
        || record.manifestByteCount <= 52 || !Number.isSafeInteger(record.publishedAt))) fail("record_invalid");
  }
  function records(folder) {
    return readdirSync(join(directory, folder)).filter((name) => name.endsWith(".json"))
      .map((name) => {
        const record = readRecord(folder, name.slice(0, -5));
        if (folder === "snapshots") {
          const envelope = JSON.parse(manifest(record.id).toString("utf8"));
          if (!Array.isArray(envelope.chunks) || !envelope.chunks.every(digest)
              || [...new Set(envelope.chunks)].sort().join(",") !== record.chunks.map((item) => item.id).sort().join(",")) fail("references_corrupt");
        }
        return record;
      });
  }
  function save(folder, record) {
    validateRecord(record, folder === "snapshots");
    atomic(path(folder, record.id), Buffer.from(JSON.stringify(record)));
  }
  function ownDraft(id, deviceId, includeReferences = true) {
    const draft = readRecord("drafts", id, includeReferences);
    if (draft.deviceId !== deviceId) fail("wrong_device");
    return draft;
  }
  function begin(deviceId) {
    if (typeof deviceId !== "string" || !deviceId) fail("wrong_device");
    for (const draft of records("drafts")) {
      if (exists(path("deleted", draft.id))) {
        unlinkSync(path("drafts", draft.id));
      } else if (exists(path("snapshots", draft.id))) {
        manifest(draft.id);
        unlinkSync(path("drafts", draft.id));
      }
    }
    collect();
    const current = records("drafts").find((item) => item.deviceId === deviceId);
    if (current) return current;
    const draft = { format: "aru.backup.snapshot-record.v1", id: randomUUID(), deviceId, createdAt: Date.now(), chunks: [] };
    save("drafts", draft);
    return draft;
  }
  function chunkInfo(id, verify = true) {
    const file = chunkPath(id);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size <= 60 || stat.size > maxChunkBytes + 32) fail("chunk_invalid");
      if (!verify) {
        const fd = openSync(file, "r");
        const prefix = Buffer.alloc(32);
        try { if (readSync(fd, prefix, 0, 32, 0) !== 32) fail("chunk_invalid"); } finally { closeSync(fd); }
        return { id, byteCount: stat.size - 32, sha256: prefix.toString("hex") };
      }
      const stored = readFileSync(file);
      const data = stored.subarray(32);
      const expected = stored.subarray(0, 32).toString("hex");
      if (hash(data) !== expected) fail("chunk_corrupt");
      return { id, byteCount: data.length, sha256: expected };
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function retainChunks(draftId, deviceId, ids) {
    if (!Array.isArray(ids) || !ids.every(digest)) fail("chunk_identity_invalid");
    const draft = ownDraft(draftId, deviceId, false);
    const previous = new Map([...draft.chunks, ...references.lookup(referencePath(draftId), ids)].map(item => [item.id, item]));
    const retained = [], added = [];
    for (const id of new Set(ids)) {
      const info = chunkInfo(id, false);
      if (!info) continue;
      const old = previous.get(id);
      if (old && (old.sha256 !== info.sha256 || old.byteCount !== info.byteCount)) fail("chunk_changed");
      retained.push(info);
      if (!old) added.push(info);
    }
    references.append(referencePath(draftId), added);
    return retained;
  }
  function retainChunk(draftId, deviceId, id) { return retainChunks(draftId, deviceId, [id])[0] ?? null; }
  function putChunk(draftId, deviceId, id, data, expectedHash) {
    ownDraft(draftId, deviceId, false);
    if (!Buffer.isBuffer(data) || data.length <= 28 || data.length > maxChunkBytes || hash(data) !== expectedHash) fail("chunk_invalid");
    const file = chunkPath(id);
    const existing = chunkInfo(id, false);
    if (existing) return retainChunk(draftId, deviceId, id);
    const info = { id, byteCount: data.length, sha256: expectedHash };
    references.append(referencePath(draftId), [info]); // Durable reference first; a missing file blocks commit.
    fault("after-chunk-reference");
    atomic(file, Buffer.concat([Buffer.from(expectedHash, "hex"), data]));
    fault("after-chunk-file");
    return info;
  }
  async function commit(draftId, deviceId, body, metadata, didPublish = () => {}) {
    const manifestSHA256 = hash(body);
    const envelope = JSON.parse(body.toString("utf8"));
    const encryptedManifest = Buffer.from(envelope.manifest ?? "", "base64");
    const chunkIDs = envelope.chunks;
    if (exists(path("deleted", draftId))) fail("deleted");
    const publishedPath = path("snapshots", draftId);
    if (exists(publishedPath)) {
      const published = readRecord("snapshots", draftId);
      if (published.deviceId !== deviceId || published.manifestSHA256 !== manifestSHA256) fail("commit_conflict");
      if (exists(path("drafts", draftId))) unlinkSync(path("drafts", draftId));
      return published;
    }
    const draft = ownDraft(draftId, deviceId);
    if (!Buffer.isBuffer(encryptedManifest) || encryptedManifest.length <= 52
        || encryptedManifest.subarray(0, 8).toString() !== "ARUSNAP1"
        || encryptedManifest.subarray(8, 24).toString("hex") !== repository.saltHex
        || !Array.isArray(chunkIDs) || !chunkIDs.every(digest)) fail("manifest_invalid");
    const references = new Map(draft.chunks.map((item) => [item.id, item]));
    const chunks = [];
    for (const id of new Set(chunkIDs)) {
      const expected = references.get(id);
      const actual = chunkInfo(id);
      if (!expected || !actual || actual.sha256 !== expected.sha256 || actual.byteCount !== expected.byteCount) fail("chunk_unavailable");
      chunks.push(expected);
      await yieldEventLoop();
    }
    // Draft references protect blocks while verification yields to other Host
    // work. Cancellation/deletion and a competing commit are re-admitted here.
    if (exists(path("deleted", draftId))) fail("deleted");
    if (exists(publishedPath)) {
      const published = readRecord("snapshots", draftId);
      if (published.deviceId !== deviceId || published.manifestSHA256 !== manifestSHA256) fail("commit_conflict");
      return published;
    }
    ownDraft(draftId, deviceId);
    const record = { ...draft, chunks, manifestSHA256, manifestByteCount: body.length,
      publishedAt: Date.now(), metadata };
    atomic(join(directory, "snapshots", `${draftId}.arusnapshot`), body);
    fault("after-manifest-file");
    save("snapshots", record); // Publication point; inventory only reads these records.
    fault("after-publication");
    unlinkSync(path("drafts", draftId));
    didPublish(record);
    return record;
  }
  function inventory() { return records("snapshots"); }
  function manifest(id) {
    const record = readRecord("snapshots", id);
    const data = readFileSync(join(directory, "snapshots", `${id}.arusnapshot`));
    if (hash(data) !== record.manifestSHA256 || data.length !== record.manifestByteCount) fail("manifest_corrupt");
    return data;
  }
  function getChunk(snapshotId, id) {
    const record = readRecord("snapshots", snapshotId);
    const expected = record.chunks.find((item) => item.id === id);
    if (!expected) fail("unreferenced_chunk");
    const data = readFileSync(chunkPath(id)).subarray(32);
    if (data.length !== expected.byteCount || hash(data) !== expected.sha256) fail("chunk_corrupt");
    return data;
  }
  function remove(id) {
    atomic(path("deleted", id), Buffer.from(JSON.stringify({ id, deletedAt: Date.now() })));
    const file = path("snapshots", id);
    if (exists(file)) {
      readRecord("snapshots", id); // Corruption is not permission to erase.
      unlinkSync(file);
      syncDirectory(join(directory, "snapshots"));
    }
    const manifestFile = join(directory, "snapshots", `${id}.arusnapshot`);
    if (exists(manifestFile)) unlinkSync(manifestFile);
    collect();
  }
  function cancel(id, deviceId) {
    ownDraft(id, deviceId);
    unlinkSync(path("drafts", id));
    syncDirectory(join(directory, "drafts"));
    collect();
  }
  function collect() {
    // Read and validate every owner before deleting anything. An unreadable index
    // cannot be interpreted as an empty set of references.
    const snapshots = records("snapshots");
    const drafts = records("drafts");
    const live = new Set([...snapshots, ...drafts].flatMap((item) => item.chunks.map((chunk) => chunk.id)));
    let removed = 0;
    for (const name of readdirSync(join(directory, "chunks"))) {
      if (digest(name) && !live.has(name)) { unlinkSync(chunkPath(name)); removed += 1; }
    }
    const snapshotIDs = new Set([...snapshots, ...drafts].map((item) => item.id));
    for (const folder of ["chunks", "snapshots", "drafts"]) {
      for (const name of readdirSync(join(directory, folder))) {
        const referenceOwner = name.endsWith(".refs-head") ? name.slice(0, -10)
          : name.endsWith(".refs") ? name.slice(0, -5) : null;
        const orphanReferences = folder === "drafts" && referenceOwner !== null
          && !drafts.some(item => item.id === referenceOwner);
        const temporary = /\.[a-f0-9-]{36}\.tmp$/.test(name);
        const orphanManifest = folder === "snapshots" && name.endsWith(".arusnapshot")
          && !snapshotIDs.has(name.slice(0, -12));
        if (temporary || orphanManifest || orphanReferences) {
          const file = join(directory, folder, name);
          unlinkSync(file);
          if (orphanReferences) references.forget(referencePath(referenceOwner));
        }
      }
    }
    return removed;
  }
  return { repository: () => ({ ...repository }), begin, retainChunk, retainChunks, putChunk, commit, inventory, manifest, getChunk, remove, cancel, collect };
}
