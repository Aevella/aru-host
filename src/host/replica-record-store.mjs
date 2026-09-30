import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// A single-writer record store for mobile execution receipts. A durable redo
// transaction precedes publication of records and scheduler state. Recovery never
// calls a driver. Full historical bodies are not resident in the scheduler ledger.
export function createReplicaRecordStore(root, { fault = () => {}, onRead = () => {} } = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = join(root, 'records-v2');
  const legacy = join(root, 'ledger.json');
  const backup = join(root, 'ledger.v1.backup.json');
  const guard = 'Aru Host replica storage migrated to records-v2. Do not start an older writer.\n';
  const valid = value => {
    if (!/^[A-Za-z0-9_-]+$/.test(String(value))) throw new Error('invalid replica record identity');
    return String(value);
  };
  const scope = (source, epoch) => `${valid(source)}/${valid(epoch)}`;
  const pathFor = (kind, source, epoch, id) => `${kind}/${scope(source, epoch)}/${valid(id)}.json`;
  const read = path => { onRead(path); return JSON.parse(readFileSync(path, 'utf8')); };
  function atomic(path, value) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  }
  function recordOps(kind, record) {
    const { sourceCollaboratorId: source, epoch, deliveryId: id } = record;
    if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0) throw new Error('invalid replica record timestamp');
    const recordPath = pathFor(kind, source, epoch, id);
    const index = `${kind}-index/${scope(source, epoch)}/${String(record.createdAt).padStart(16, '0')}_${valid(id)}.json`;
    const ops = [{ path: recordPath, value: record }, { path: index, value: { deliveryId: id } }];
    const pending = pathFor(kind === 'executions' ? 'running' : 'pending', source, epoch, id);
    ops.push({ path: pending, value: (kind === 'executions' ? record.state === 'running' : !record.acknowledgedAt) ? { deliveryId: id } : null });
    if (kind === 'deliveries') ops.push({ path: index.replace('deliveries-index/', 'continuation/'), value: { deliveryId: id } });
    return ops;
  }
  function apply(base, transaction) {
    for (const op of transaction.operations) {
      const path = join(base, op.path);
      if (op.value === null) { if (existsSync(path)) unlinkSync(path); }
      else atomic(path, op.value);
    }
    if (transaction.ledger) atomic(join(base, 'scheduler.json'), transaction.ledger);
  }
  if (!existsSync(directory)) {
    let old = { replicas: [], deliveries: [], executions: [], revokedExecutions: [] };
    if (existsSync(legacy)) {
      const text = readFileSync(legacy, 'utf8');
      old = text === guard && existsSync(backup) ? read(backup) : JSON.parse(text);
    }
    if (!old || typeof old !== 'object' || Array.isArray(old) || (old.schema && old.schema !== 'aru.selfhost.mobile-collaborator-ledger.v1')) throw new Error('unsupported or unreadable mobile replica ledger');
    for (const key of ['replicas', 'deliveries', 'executions', 'revokedExecutions']) {
      old[key] ??= [];
      if (!Array.isArray(old[key])) throw new Error(`mobile replica ${key} is unreadable`);
    }
    const stage = join(root, `records-stage-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    const { executions, deliveries, ...state } = old;
    for (const record of executions) apply(stage, { operations: recordOps('executions', record), ledger: null });
    for (const record of deliveries) apply(stage, { operations: recordOps('deliveries', record), ledger: null });
    atomic(join(stage, 'scheduler.json'), { ...state, schema: 'aru.selfhost.mobile-collaborator-ledger.v2' });
    // Keep a lossless pre-migration backup. Old readers fail closed instead of
    // treating the new layout as an empty ledger and replaying accepted work.
    if (existsSync(legacy) && readFileSync(legacy, 'utf8') !== guard) copyFileSync(legacy, backup);
    else if (!existsSync(backup)) atomic(backup, old);
    const guardTemporary = `${legacy}.${randomUUID()}.tmp`;
    const guardFD = openSync(guardTemporary, 'wx', 0o600);
    try { writeFileSync(guardFD, guard); fsyncSync(guardFD); } finally { closeSync(guardFD); }
    renameSync(guardTemporary, legacy);
    fault('before-migration-activate');
    renameSync(stage, directory);
  }
  const pendingTransaction = join(directory, 'transaction.json');
  if (existsSync(pendingTransaction)) { apply(directory, read(pendingTransaction)); unlinkSync(pendingTransaction); }
  const ledger = read(join(directory, 'scheduler.json'));
  if (ledger.schema !== 'aru.selfhost.mobile-collaborator-ledger.v2' || !Array.isArray(ledger.replicas)) throw new Error('unreadable replica scheduler state');
  let failed = false;
  let operations = [];
  const staged = new Map();
  function assertHealthy() { if (failed) throw new Error('replica storage write failed; restart Host to recover'); }
  function get(kind, source, epoch, id) {
    assertHealthy();
    const key = pathFor(kind, source, epoch, id);
    if (staged.has(key)) return structuredClone(staged.get(key));
    const path = join(directory, key);
    return existsSync(path) ? read(path) : null;
  }
  function put(kind, record) {
    assertHealthy();
    operations.push(...recordOps(kind, record));
    staged.set(pathFor(kind, record.sourceCollaboratorId, record.epoch, record.deliveryId), structuredClone(record));
  }
  function names(path) {
    try { return readdirSync(path).filter(name => name.endsWith('.json')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function indexed(kind, source, epoch, { after = null, limit = 50, newest = true } = {}) {
    assertHealthy();
    let files = names(join(directory, `${kind}-index`, scope(source, epoch))).sort();
    if (newest) files.sort((a, b) => b.slice(0, 16).localeCompare(a.slice(0, 16)) || a.slice(17).localeCompare(b.slice(17)));
    if (after) {
      const index = files.findIndex(name => name.slice(17, -5) === after);
      if (index < 0) return null;
      files = files.slice(index + 1);
    }
    // Only requested page bodies are read. The index contains filenames, not
    // generated text or conversation context.
    return files.slice(0, limit).map(name => get(kind, source, epoch, name.slice(17, -5)));
  }
  function pending(kind, source, epoch) {
    assertHealthy();
    const index = kind === 'executions' ? 'running' : 'pending';
    return names(join(directory, index, scope(source, epoch)))
      .map(name => get(kind, source, epoch, name.slice(0, -5)));
  }
  return {
    ledger, get, put, indexed, pending,
    continuation(source, epoch, conversationId, limit) {
      assertHealthy();
      const files = names(join(directory, 'continuation', scope(source, epoch))).sort().reverse();
      const result = [];
      for (const name of files) {
        const delivery = get('deliveries', source, epoch, name.slice(17, -5));
        if (delivery.sourceConversationId === conversationId) result.push(delivery);
        if (result.length === limit) break;
      }
      return result;
    },
    retireContinuation(source, epoch, revision) {
      assertHealthy();
      const prefix = `continuation/${scope(source, epoch)}/`;
      const entries = new Set([...names(join(directory, prefix)), ...operations
        .filter(op => op.path.startsWith(prefix) && op.value !== null).map(op => op.path.slice(prefix.length))]);
      for (const name of entries) {
        const delivery = get('deliveries', source, epoch, name.slice(17, -5));
        const reflected = Number.isSafeInteger(delivery.replicaRevision)
          ? revision > delivery.replicaRevision : Boolean(delivery.acknowledgedAt);
        if (reflected) operations.push({ path: `continuation/${scope(source, epoch)}/${name}`, value: null });
      }
    },
    running() {
      const base = join(directory, 'running');
      if (!existsSync(base)) return [];
      return readdirSync(base).flatMap(source => readdirSync(join(base, source))
        .flatMap(epoch => pending('executions', source, epoch)));
    },
    commit(ledger) {
      assertHealthy();
      try {
        const transaction = { ledger, operations };
        atomic(pendingTransaction, transaction);
        fault('after-journal');
        apply(directory, transaction);
        fault('after-publication');
        unlinkSync(pendingTransaction);
        operations = []; staged.clear();
      } catch (error) { failed = true; throw error; }
    },
  };
}
