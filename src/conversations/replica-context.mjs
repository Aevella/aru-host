import { messageContentWithTime, historyRoleLabel, validatedReplicaRole } from "./driver-projection.mjs";

// A history-only admission budget, not a model-specific token/window claim.
// 64 KiB budgets content rather than an arbitrary message count, preventing
// multi-megabyte phone windows from entering each scheduled model request.
// Instructions, tools and output have separate owners; basisMessages is never
// passed through this projection because phone receipt validation needs it intact.
export const REPLICA_HISTORY_BYTES = 64 * 1024;
const OMITTED_PREFIX = "[Earlier content of this message omitted from model context.]\n";

function historyBytes(message) {
  const content = messageContentWithTime(message);
  return Math.max(
    Buffer.byteLength(`${historyRoleLabel(message.role)}: ${content}\n\n`),
    Buffer.byteLength(JSON.stringify({ role: message.role, content })) + 1,
  );
}

export function replicaContextMessages(messages, timestamp, budget = REPLICA_HISTORY_BYTES) {
  const selected = [];
  // Include the structured history array delimiters as well as per-row framing.
  let remaining = Math.max(0, budget - 2);
  for (let index = messages.length - 1; index >= 0; index--) {
    const item = messages[index];
    const content = String(item.content ?? "").trim();
    if (!content) continue;
    const message = {
      role: validatedReplicaRole(item.role), content,
      createdAt: Number(item.createdAt) || timestamp,
      updatedAt: Number(item.updatedAt) || Number(item.createdAt) || timestamp,
    };
    const cost = historyBytes(message);
    if (cost <= remaining) {
      selected.push(message);
      remaining -= cost;
      continue;
    }
    // Keep a contiguous recent suffix. Never jump over a large intervening
    // message to admit older material, or fragment an ordinary boundary row.
    if (selected.length === 0) {
      const bytes = Buffer.from(content);
      let low = 0;
      let high = Math.min(bytes.length, remaining);
      let fitted = null;
      while (low <= high) {
        const length = Math.floor((low + high) / 2);
        let start = bytes.length - length;
        // UTF-8 continuation bytes cannot start a valid retained suffix.
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
        const candidate = { ...message, content: OMITTED_PREFIX + bytes.subarray(start).toString("utf8") };
        if (historyBytes(candidate) <= remaining) {
          fitted = candidate;
          low = length + 1;
        } else high = length - 1;
      }
      if (fitted) selected.push(fitted);
    }
    break;
  }
  return selected.reverse();
}
