// Metadata lifecycle, independent of message execution. A running turn must be
// stopped through its owner before its conversation can leave the live list.
export function mutateConversationLifecycle({ conversation, body, deleting, deviceId, now, save, HttpError }) {
  if (deleting && conversation.archivedAt) return;
  if (conversation.archivedAt) throw new HttpError(409, 'conversation.archived', 'Conversation has been deleted');
  if (body.expectedRevision !== conversation.revision) throw new HttpError(409, 'conversation.revision_conflict', 'Conversation changed; refresh and retry');
  if (deleting && ['queued', 'starting', 'streaming', 'waitingApproval', 'toolRunning'].includes(conversation.activeTurn?.state)) {
    throw new HttpError(409, 'conversation.busy', 'Stop the current turn before deleting this conversation');
  }
  const title = deleting ? conversation.title : String(body.title ?? '').trim();
  if (!title) throw new HttpError(400, 'conversation.title_required', 'A title is required');
  const previous = { ...conversation };
  conversation.title = title;
  if (deleting) conversation.archivedAt = now();
  conversation.revision += 1;
  conversation.updatedAt = now();
  conversation.updatedByDeviceId = deviceId;
  try { save(conversation); } catch (error) { Object.assign(conversation, previous); throw error; }
}
