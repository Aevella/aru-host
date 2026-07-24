const SAFE_PATHS = [
  ["GET", /^\/\.well-known\/aru\.json$/],
  ["GET", /^\/aru\/v1\/(diagnostics|node-settings|devices|backups|backups\/settings|plugins|plugin-workshop\/drafts|node-workspaces|jobs|jobs\/policy|artifacts|agent-drivers|hosted-collaborators|provider-profiles)$/],
  ["POST", /^\/aru\/v1\/(pair|devices\/revoke|agent-drivers\/refresh|hosted-collaborators|provider-profiles|plugin-workshop\/(validate|apply)|plugin-workshop\/drafts|node-workspaces)$/],
  ["PUT", /^\/aru\/v1\/(node-settings|backups\/settings|jobs\/policy|provider-profiles\/provider_[A-Fa-f0-9-]+)$/],
  ["DELETE", /^\/aru\/v1\/(backups|artifacts)\/[A-Za-z0-9._~-]+$/],
  ["GET", /^\/aru\/v1\/(backups|artifacts)\/[A-Za-z0-9._~-]+$/],
  ["GET", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+\/(surfaces|conversations|cognition)$/],
  ["POST", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+\/(surfaces|conversations)$/],
  ["PUT", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+(?:\/(?:cognition|conversations\/[A-Za-z0-9_-]+\/(?:messages|approvals\/[A-Za-z0-9_-]+)|surfaces\/[A-Za-z0-9_-]+(?:\/runtime)?))?$/],
  ["POST", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+\/conversations\/[A-Za-z0-9_-]+\/turns\/[A-Za-z0-9_-]+\/cancel$/],
  ["POST", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+\/surfaces\/[A-Za-z0-9_-]+\/(?:rollback|archive|restore)$/],
  ["GET", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+\/conversations\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+\/surfaces\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/aru\/v1\/plugins\/[A-Za-z0-9._~-]+\/source$/],
  ["DELETE", /^\/aru\/v1\/(plugins|plugin-workshop\/drafts)\/[A-Za-z0-9._~-]+(?:\/source)?(?:\?deleteData=(?:true|false))?$/],
  ["POST", /^\/aru\/v1\/plugins\/[A-Za-z0-9._~-]+\/(enable|disable|rollback)$/],
  ["POST", /^\/aru\/v1\/plugin-workshop\/drafts\/[A-Za-z0-9._~-]+\/apply$/],
  ["DELETE", /^\/aru\/v1\/node-workspaces\/[A-Za-z0-9_-]+$/],
  ["POST", /^\/aru\/v1\/jobs\/[A-Za-z0-9_-]+\/(cancel|retry)$/],
  ["DELETE", /^\/aru\/v1\/provider-profiles\/provider_[A-Fa-f0-9-]+$/],
  ["POST", /^\/aru\/v1\/provider-profiles\/provider_[A-Fa-f0-9-]+\/test$/],
  ["POST", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+\/cognition\/(memories|references)$/],
  ["PUT", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+\/cognition\/(memories|references)\/[A-Za-z0-9_-]+$/],
  ["POST", /^\/aru\/v1\/hosted-collaborators\/[A-Za-z0-9_-]+\/cognition\/(memories|references)\/[A-Za-z0-9_-]+\/(archive|restore)$/],
];

export function validateHostRequest(method, path) {
  const normalizedMethod = String(method ?? "GET").toUpperCase();
  const value = String(path ?? "");
  if (!value.startsWith("/") || value.includes("..") || /%2f|%5c/i.test(value)) {
    throw new Error("Invalid Host request path");
  }
  if (!SAFE_PATHS.some(([allowedMethod, pattern]) => allowedMethod === normalizedMethod && pattern.test(value))) {
    throw new Error(`Host request is outside the Console contract: ${normalizedMethod} ${value}`);
  }
  return { method: normalizedMethod, path: value };
}

export function parsePairingLink(output) {
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith("aru://pair?")) continue;
    const url = new URL(candidate);
    if (url.searchParams.get("canonicalUrl") && url.searchParams.get("serverId") && url.searchParams.get("pairingToken")) {
      return candidate;
    }
  }
  throw new Error("Aru Host did not issue a valid pairing link");
}

export function readInstalledVersion(contents) {
  const match = String(contents ?? "").match(/^ARU_INSTALL_RELEASE_VERSION=(.*)$/m);
  if (!match) return null;
  const value = match[1].trim().replace(/^['"]|['"]$/g, "");
  return value || null;
}

export function readPort(contents) {
  const match = String(contents ?? "").match(/^ARU_PORT=([0-9]+)$/m);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8787;
}

export function linuxReleaseAsset(version, architecture = process.arch) {
  const arch = architecture === "arm64" ? "arm64" : architecture === "x64" ? "x64" : null;
  if (!arch) return null;
  return `aru-host-linux-${version}-${arch}.deb`;
}
