// Status evidence only. Arguments, provider payloads and credentials do not
// belong in mobile delivery, and these receipts are not protocol replay data.
export function mobileToolReceipts(conversation, turn) {
  const receipts = new Map();
  for (const event of conversation.events ?? []) {
    const p = event.payload;
    if (p?.turnId !== turn.turnId || !p.toolCallId || !p.toolName) continue;
    if (!["tool.started", "tool.completed", "tool.failed"].includes(event.kind)) continue;
    const previous = receipts.get(p.toolCallId);
    receipts.set(p.toolCallId, {
      toolCallId: p.toolCallId, toolName: p.toolName, title: p.title || p.toolName,
      status: event.kind === "tool.completed" ? "complete" : event.kind === "tool.failed" ? "failed" : "interrupted",
      failure: event.kind === "tool.failed" ? p.message ?? null : null,
      createdAt: previous?.createdAt ?? event.at, updatedAt: event.at,
    });
  }
  return [...receipts.values()];
}
