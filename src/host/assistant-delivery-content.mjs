// Request timestamps are not authored dialogue. Only remove the exact standalone
// JSON envelope emitted by Host; examples, malformed tags and other prose survive.
export function assistantDeliveryContent(content, { trim = true, partial = false } = {}) {
  let fence;
  const result = String(content ?? "").split(/(?<=\n)/).filter(line => {
    const body = line.replace(/\r?\n$/, "");
    if (/^(?: {4}|\t)/.test(body)) return true;
    const visible = body.replace(/^ {0,3}/, "");
    if (fence) {
      const closing = visible.match(/^(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
      return true;
    }
    const opening = visible.match(/^(`{3,}|~{3,})/);
    if (opening) { fence = { marker: opening[1][0], length: opening[1].length }; return true; }
    if (partial && !line.endsWith("\n") && visible &&
        ("<message_meta>".startsWith(visible.toLowerCase()) ||
         (visible.toLowerCase().startsWith("<message_meta>") && !visible.toLowerCase().includes("</message_meta>")))) return false;
    const match = visible.match(/^<message_meta>(.*)<\/message_meta>[ \t]*$/i);
    if (!match) return true;
    try {
      const value = JSON.parse(match[1]);
      const keys = ["sent_at", "sent_at_unix_ms", "updated_at", "updated_at_unix_ms"];
      if (!value || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return true;
      for (const key of ["sent_at", "updated_at"]) {
        const milliseconds = value[key + "_unix_ms"];
        if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return true;
        if (milliseconds <= 0 ? value[key] !== null : value[key] !== new Date(milliseconds).toISOString()) return true;
      }
      return false;
    } catch { return true; }
  }).join("");
  return trim ? result.trim() : result;
}
