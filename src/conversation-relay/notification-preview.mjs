// A bounded, display-only projection. It never changes provider execution/results.
export function createNotificationPreviewCollector(protocolId, contentType) {
  const decoder = new TextDecoder();
  const sse = contentType.toLowerCase().includes("text/event-stream");
  let buffer = "", text = "", invalid = false;
  const parts = new Map();
  const cap = value => Array.from(value).slice(0, 700).join("");
  const visible = blocks => Array.isArray(blocks)
    ? blocks.filter(x => x?.type === "text" || x?.type === "output_text").map(x => x.text ?? "").join("") : "";
  function accept(value) {
    if (!value || typeof value !== "object") return;
    if (value.error || value.type === "error" || value.type === "response.failed" || value.type === "response.incomplete") {
      invalid = true; return;
    }
    if (protocolId === "chatgpt-codex-subscription" || value.type?.startsWith("response.")) {
      const key = `${value.output_index ?? 0}:${value.content_index ?? 0}`;
      if (value.type === "response.output_text.delta") parts.set(key, cap((parts.get(key) ?? "") + (value.delta ?? "")));
      if (value.type === "response.output_text.done") parts.set(key, cap(value.text ?? ""));
      if (value.type === "response.content_part.done" && value.part?.type === "output_text") parts.set(key, cap(value.part.text ?? ""));
      const output = value.response?.output ?? value.output;
      if (Array.isArray(output)) {
        const full = output.filter(x => x.type === "message" && (!x.role || x.role === "assistant"))
          .map(x => visible(x.content)).join("");
        if (full) { text = cap(full); parts.clear(); }
      }
      if (value.type === "response.output_item.done" && value.item?.type === "message") {
        for (const [i, part] of (value.item.content ?? []).entries()) {
          if (part.type === "output_text") parts.set(`${value.output_index ?? 0}:${i}`, cap(part.text ?? ""));
        }
      }
      if (parts.size) text = cap([...parts].sort((a,b) => {
        const x=a[0].split(":").map(Number), y=b[0].split(":").map(Number);
        return x[0]-y[0] || x[1]-y[1];
      }).map(x => x[1]).join(""));
    } else if (["anthropic-messages", "claude-subscription"].includes(protocolId) || value.type?.startsWith("content_block")) {
      if (value.type === "content_block_start" && value.content_block?.type === "text") text = cap(text + (value.content_block.text ?? ""));
      if (value.type === "content_block_delta" && value.delta?.type === "text_delta") text = cap(text + (value.delta.text ?? ""));
      if (value.type === "message" && value.role === "assistant") text = cap(visible(value.content));
    } else {
      const choice = value.choices?.find(x => x.index === 0) ?? value.choices?.[0];
      const message = choice?.delta ?? choice?.message;
      if (!message || (message.role && message.role !== "assistant")) return;
      const content = typeof message.content === "string" ? message.content : visible(message.content);
      text = cap(text + content);
    }
  }
  function event(raw) {
    const data = raw.split(/\r?\n/).filter(x => x.startsWith("data:")).map(x => x.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    try { accept(JSON.parse(data)); } catch { invalid = true; }
  }
  return {
    append(chunk) {
      if (invalid) return;
      buffer += decoder.decode(chunk, {stream: true});
      if (sse) {
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          event(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
        }
      }
      // Only the preview projection stops on oversized/unknown envelopes; the reply continues.
      if (buffer.length > 1024 * 1024 || parts.size > 1024) { invalid = true; buffer = ""; parts.clear(); }
    },
    finish() {
      buffer += decoder.decode();
      if (!invalid) {
        if (sse) event(buffer);
        else { try { accept(JSON.parse(buffer)); } catch { invalid = true; } }
      }
      return invalid ? null : text.replace(/\s+/gu, " ").trim() || null;
    },
  };
}
