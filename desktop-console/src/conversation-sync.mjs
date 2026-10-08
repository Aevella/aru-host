// The ledger owns truth; this foreground session retains only applied wire state.
export async function pollConversation(state, path, request, isCurrent, apply) {
  const params = new URLSearchParams({ after: String(state.cursor) });
  if (state.version) params.set('version', state.version);
  const sync = await request('GET', `${path}/sync?${params}`);
  if (!isCurrent()) return;
  if (!sync.unchanged) {
    apply(sync.conversation, sync.reset);
    state.cursor = sync.cursor;
    state.hasMore = sync.hasMore;
  }
  // Never cache a file version until all event pages have been applied.
  state.version = state.hasMore ? null : sync.version;
}

export function patchMessageRows(container, rows, messages, reset = false) {
  const pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 24;
  const scrollTop = container.scrollTop;
  if (reset) {
    const retained = new Set(messages.map(message => message.messageId));
    for (const [id, row] of rows) if (!retained.has(id)) { row.remove(); rows.delete(id); }
  }
  if (!rows.size && messages.length) container.replaceChildren();
  for (const message of messages) {
    let row = rows.get(message.messageId);
    if (!row) {
      row = container.ownerDocument.createElement('div');
      row.dataset.messageId = message.messageId;
      row.dataset.position = String(message.position);
      let next = container.lastElementChild;
      while (next && Number(next.dataset.position) > message.position) next = next.previousElementSibling;
      container.insertBefore(row, next ? next.nextElementSibling : container.firstElementChild);
      rows.set(message.messageId, row);
    }
    const className = `message ${message.role}`;
    if (row.className !== className) row.className = className;
    if (row.textContent !== message.content) row.textContent = message.content;
  }
  container.scrollTop = pinned ? container.scrollHeight : scrollTop;
}

export function conversationRunning(turn) {
  return ["queued", "starting", "streaming", "waitingApproval", "toolRunning"].includes(turn?.state);
}
