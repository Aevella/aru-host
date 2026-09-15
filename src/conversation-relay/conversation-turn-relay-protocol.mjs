import { readFileSync } from "node:fs";

// Provider admission and error projection. No turn state or request replay.
export const SUPPORTED_CONVERSATION_TURN_PROTOCOLS = Object.freeze([
  "openai-compatible",
  "anthropic-messages",
  "claude-subscription",
  "chatgpt-codex-subscription",
  "kimi-code-subscription",
]);

export function providerFailureMessage(resultPath, status) {
  const fallback = `Provider returned HTTP ${status}.`;
  try {
    const value = JSON.parse(readFileSync(resultPath, "utf8"));
    const detail = [value?.error?.message, value?.error, value?.message]
      .find((candidate) => typeof candidate === "string" && candidate.trim());
    if (!detail) return fallback;
    const safe = detail
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    return safe ? `Provider returned HTTP ${status}: ${safe}` : fallback;
  } catch {
    return fallback;
  }
}

export function requiredText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

export function requiredProtocol(value) {
  if (!SUPPORTED_CONVERSATION_TURN_PROTOCOLS.includes(value)) {
    throw new Error("protocolId is unsupported");
  }
  return value;
}

export function validatedProviderEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(requiredText(value, "request.endpoint")); }
  catch { throw new Error("request.endpoint is invalid"); }
  if (endpoint.protocol !== "https:") throw new Error("provider endpoint must use HTTPS");
  const host = endpoint.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local")) {
    throw new Error("provider endpoint cannot target the local host");
  }
  return endpoint;
}

export function validatedHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request.headers must be an object");
  }
  const headers = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") throw new Error("request header values must be strings");
    const normalized = key.toLowerCase();
    if (["host", "content-length", "connection", "transfer-encoding"].includes(normalized)) continue;
    headers[key] = headerValue;
  }
  return headers;
}

export function decodedBody(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("request.bodyBase64 is required");
  }
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("request.bodyBase64 must be canonical Base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("request.bodyBase64 must be canonical Base64");
  }
  return decoded;
}
