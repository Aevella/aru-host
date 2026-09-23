import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateConversationLifecycle } from '../src/conversations/collaborator-conversation-lifecycle.mjs';
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const mutate = (conversation, body, deleting, save = () => {}) => mutateConversationLifecycle({ conversation, body, deleting, save, deviceId: 'phone', now: () => 100, HttpError });
test('metadata lifecycle rejects stale edits and active deletion; deletion retries are idempotent', () => {
  const record = { title: 'First', revision: 1, archivedAt: null, activeTurn: { state: 'streaming' } };
  assert.throws(() => mutate(record, { expectedRevision: 1 }, true), { code: 'conversation.busy' });
  mutate(record, { expectedRevision: 1, title: 'Renamed' }, false);
  assert.equal(record.title, 'Renamed');
  assert.throws(() => mutate(record, { expectedRevision: 1, title: 'Stale' }, false), { code: 'conversation.revision_conflict' });
  record.activeTurn.state = 'complete';
  assert.throws(() => mutate(record, { expectedRevision: 2 }, true, () => { throw new Error('disk'); }));
  assert.equal(record.archivedAt, null);
  assert.equal(record.revision, 2);
  mutate(record, { expectedRevision: 2 }, true);
  mutate(record, { expectedRevision: 2 }, true);
  assert.equal(record.revision, 3);
  assert.throws(() => mutate(record, { expectedRevision: 3, title: 'Late' }, false), { code: 'conversation.archived' });
});
