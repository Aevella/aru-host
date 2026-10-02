// Read-only wire projections. The conversation ledger remains the sole durable owner.
export const SYNC_SCHEMA = "aru.selfhost.collaborator-conversation-sync.v1";
export const PAGE_SCHEMA = "aru.selfhost.collaborator-conversation-message-page.v1";
const pageSize = 64;
const eventPageSize = 128;
const publicMessage = ({ clientRequestId: _, driverText: __, ...value }, position) => ({ ...value, position });

export function messagePage(conversation, before, HttpError) {
  const source = conversation.messages;
  const end = before ? source.findLastIndex(item => item.role !== "system" && item.messageId === before) : source.length;
  if (end < 0) throw new HttpError(409, "conversation.anchor_unknown", "history anchor no longer exists");
  const messages = [];
  let hasMore = false;
  for (let i = end - 1; i >= 0; i--) {
    if (source[i].role === "system") continue;
    if (messages.length === pageSize) { hasMore = true; break; }
    messages.push(publicMessage(source[i], i));
  }
  messages.reverse();
  return { schema: PAGE_SCHEMA, collaboratorId: conversation.collaboratorId,
    conversationId: conversation.conversationId, messages,
    before: messages[0]?.messageId ?? null, hasMore };
}

function eventsAfter(events, after) {
  let low = 0, high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle].sequence <= after) low = middle + 1; else high = middle;
  }
  return events.slice(low, low + eventPageSize);
}

function changedMessages(conversation, ids) {
  const remaining = new Set(ids);
  const messages = [];
  for (let i = conversation.messages.length - 1; i >= 0 && remaining.size; i--) {
    const item = conversation.messages[i];
    if (remaining.delete(item.messageId) && item.role !== "system") messages.push(publicMessage(item, i));
  }
  return messages.reverse();
}

export function syncProjection(conversation, metadata, version, after) {
  const tail = conversation.events.at(-1)?.sequence ?? 0;
  const reset = after === null || after > tail;
  const history = reset ? messagePage(conversation, null) : null;
  // Initial presentation needs current activity, not every historical text delta.
  const initialEvents = [];
  if (reset && conversation.activeTurn) {
    for (let i = conversation.events.length - 1; i >= 0; i--) {
      const event = conversation.events[i];
      if (event.payload?.turnId !== conversation.activeTurn.turnId) continue;
      if (event.kind !== "assistant.delta") initialEvents.push(event);
      if (initialEvents.length === eventPageSize || event.kind === "message.accepted") break;
    }
    initialEvents.reverse();
  }
  const page = reset ? initialEvents : eventsAfter(conversation.events, after);
  const cursor = reset ? tail : (page.at(-1)?.sequence ?? after);
  const ids = new Set();
  for (const event of page) {
    for (const key of ["messageId", "userMessageId", "assistantMessageId"]) {
      if (event.payload?.[key]) ids.add(event.payload[key]);
    }
  }
  const turns = new Set(page.map(event => event.payload?.turnId).filter(Boolean));
  for (let i = conversation.events.length - 1; i >= 0 && turns.size; i--) {
    const event = conversation.events[i];
    if (event.kind === "message.accepted" && turns.has(event.payload?.turnId)) {
      ids.add(event.payload.userMessageId); ids.add(event.payload.assistantMessageId);
      turns.delete(event.payload.turnId);
    }
  }
  if (conversation.activeTurn) {
    ids.add(conversation.activeTurn.userMessageId);
    ids.add(conversation.activeTurn.assistantMessageId);
  }
  return { schema: SYNC_SCHEMA, collaboratorId: conversation.collaboratorId,
    conversationId: conversation.conversationId, version, unchanged: false, reset,
    conversation: { ...metadata,
      messages: reset ? history.messages : changedMessages(conversation, ids),
      approvals: conversation.approvals.filter(item => item.state === "pending")
        .map(({ resolvedByDeviceId: _, ...item }) => item) },
    events: page.filter(event => event.kind !== "assistant.delta"), cursor, hasMore: cursor < tail,
    history: history ? { before: history.before, hasMore: history.hasMore } : null };
}
