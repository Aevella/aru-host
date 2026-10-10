const addressError = (message, code) => Object.assign(new Error(message), { code });

// User-entered origins cross from the renderer into the privileged network probe.
export function connectionOrigin(kind, value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw addressError("Enter a complete HTTPS or Tailscale address.", "invalid_address"); }
  const parts = url.hostname.split('.').map(Number);
  const tailnet = (parts.length === 4 && parts.every(x => Number.isInteger(x) && x >= 0 && x <= 255)
    && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || url.hostname.endsWith('.ts.net');
  if (!["public-https", "tailscale"].includes(kind) || !["https:", "http:"].includes(url.protocol)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (kind === "public-https" && url.protocol !== "https:") || (url.protocol === "http:" && !tailnet)) {
    throw addressError("Use public HTTPS or a Tailscale address, without a path, credentials, query or fragment.", "invalid_address");
  }
  return url.origin;
}

export async function verifyConnectionAddress(kind, value, expectedServerId, { fetchManifest = fetch, timeoutMs = 10_000 } = {}) {
  const origin = connectionOrigin(kind, value);
  if (!expectedServerId) throw new Error("Read the local Host identity before checking an address.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchManifest(`${origin}/.well-known/aru.json`, {
      headers: { Accept: "application/json" }, credentials: "omit", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Connection check returned HTTP ${response.status}.`);
    const manifest = await response.json();
    if (manifest.serverId !== expectedServerId) throw addressError("This address belongs to a different Host.", "different_host");
    return { baseUrl: origin, serverId: manifest.serverId };
  } finally { clearTimeout(timer); }
}
