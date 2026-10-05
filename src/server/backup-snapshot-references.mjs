import { openSync, closeSync, readFileSync, writeFileSync, fsyncSync, statSync, truncateSync } from 'node:fs';
import { createHash } from 'node:crypto';
const checkpointBytes = length => Buffer.from(JSON.stringify({ length, sha256: hash(String(length)) }));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// The checkpoint distinguishes an unacknowledged append from damage to committed
// bytes. Appends and checkpoint replacement are durable before chunk publication.
export function createDraftReferences({ atomic }) {
  const cached = new Map();
  function checkpoint(path) {
    try {
      const value = JSON.parse(readFileSync(path + '-head', 'utf8'));
      if (!Number.isSafeInteger(value.length) || value.length < 0 || value.sha256 !== hash(String(value.length))) throw new Error('backup.snapshot.references_invalid');
      return value.length;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function load(path) {
    const length = checkpoint(path);
    let stat;
    try { stat = statSync(path); } catch (error) {
      if (error.code === 'ENOENT' && !length) { cached.delete(path); return new Map(); }
      throw error;
    }
    if (length === null || stat.size < length) throw new Error('backup.snapshot.references_incomplete');
    if (stat.size > length) { truncateSync(path, length); stat = statSync(path); }
    const previous = cached.get(path);
    if (previous?.size === stat.size && previous.mtime === stat.mtimeMs) return previous.refs;
    const bytes = readFileSync(path);
    if (bytes.length && bytes[bytes.length - 1] !== 10) throw new Error('backup.snapshot.references_invalid');
    const refs = new Map();
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (!Array.isArray(record.items) || hash(JSON.stringify(record.items)) !== record.sha256) throw new Error('backup.snapshot.references_invalid');
      for (const item of record.items) refs.set(item.id, item);
    }
    cached.set(path, { size: stat.size, mtime: stat.mtimeMs, refs });
    return refs;
  }
  function append(path, items) {
    if (!items.length) return;
    const refs = load(path);
    if (checkpoint(path) === null) atomic(path + '-head', checkpointBytes(0));
    const fd = openSync(path, 'a', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ items, sha256: hash(JSON.stringify(items)) }) + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const stat = statSync(path);
    atomic(path + '-head', checkpointBytes(stat.size));
    for (const item of items) refs.set(item.id, item);
    cached.set(path, { size: stat.size, mtime: stat.mtimeMs, refs });
  }
  return { read: path => [...load(path).values()],
    lookup: (path, ids) => { const refs = load(path); return ids.map(id => refs.get(id)).filter(Boolean); },
    append, forget: path => cached.delete(path) };
}
