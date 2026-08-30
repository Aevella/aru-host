const diagnostics = {
  serverVersion: "stub-0.29",
  serverId: "home-linux-ae71",
  hostedCollaboratorCount: 3,
  activeJobCount: 1,
  artifactCount: 12,
  capabilities: [
    { id: "collaborator-host", enabled: true },
    { id: "mcp-gateway", enabled: true },
    { id: "backup-vault", enabled: true },
    { id: "workspace-jobs", enabled: false },
  ],
};
const nodeSettings = { displayName: "示例 Linux Host", revision: 4 };
const devices = {
  devices: [
    { deviceId: "console", label: "Aru Host Console", issuedAt: "2026-07-24T07:20:00Z", isCurrent: true, revokedAt: null },
    { deviceId: "phone", label: "示例 iPhone", issuedAt: "2026-07-24T07:25:00Z", isCurrent: false, revokedAt: null },
  ],
};
const collaborator = {
  collaboratorId: "root_example",
  displayName: "示例协作者",
  driverId: "codex",
  providerProfileId: null,
  activationStatus: "driver-ready",
  revision: 7,
  toolAccess: { schema: "aru.selfhost.collaborator-tool-access.v1", mode: "selected", toolNames: ["aru_node_status", "aru_artifact_inventory"] },
};
const provider = {
  profileId: "provider_19a2",
  displayName: "Local model",
  protocol: "openai-compatible",
  baseURL: "http://127.0.0.1:11434/",
  path: "v1/chat/completions",
  model: "local-model",
  authMode: "none",
  maxOutputTokens: null,
  maxToolRounds: null,
  revision: 2,
  health: "ready",
};
const failureMode = new URLSearchParams(window.location.search).has("failure");

window.aruHost = Object.freeze({
  bootstrap: async () => {
    if (failureMode) throw new Error("Linux Secret Service 暂时不可用，请先解锁当前桌面钥匙串。");
    return ({
    manifest: { serverVersion: "stub-0.29" },
    diagnostics,
    nodeSettings,
    deviceInventory: devices,
    update: { version: "0.30.1", url: "https://github.com/Aevella/aru-host/releases/latest" },
    secretStorage: "linux-secret-service",
    });
  },
  request: async (method, path) => {
    if (method === "GET" && path === "/aru/v1/diagnostics") return diagnostics;
    if (method === "GET" && path === "/aru/v1/node-settings") return nodeSettings;
    if (method === "GET" && path === "/aru/v1/devices") return devices;
    if (method === "GET" && path === "/aru/v1/agent-drivers") return { drivers: [{ id: "codex", displayName: "Codex", status: "ready" }, { id: "api", displayName: "模型 API", status: "ready" }] };
    if (method === "GET" && path === "/aru/v1/hosted-collaborators") return { collaborators: [collaborator] };
    if (method === "GET" && path === "/aru/v1/provider-profiles") return { secretStorage: { supported: true }, profiles: [provider] };
    if (method === "GET" && path.endsWith("/conversations")) return { conversations: [{ conversationId: "conversation_1", title: "Linux 入住检查", lastMessagePreview: "Host 还在这里。", updatedAt: "2026-07-24T07:50:00Z" }] };
    if (method === "GET" && path.endsWith("/surfaces")) return { surfaces: [{ surfaceId: "surface_1", title: "在场页", revision: 3, activeVersionOrdinal: 2, networkAccess: "none", delivery: "inline", archivedAt: null }] };
    if (method === "GET" && path.endsWith("/cognition")) return { revision: 5, instructionEnvironment: "isolated", systemPrompt: "保持清醒、诚实和在场。", memories: [{ memoryId: "memory_1", title: "名字", content: "她叫示例协作者。", updatedAt: "2026-07-24T07:40:00Z", archivedAt: null }], references: [] };
    throw new Error(`Visual fixture has no response for ${method} ${path}`);
  },
  mcpCatalog: async () => ({ tools: [] }),
  issueMobilePairing: async () => "aru://pair?visual-fixture",
  repairConnection: async () => true,
  chooseFolder: async () => null,
  download: async () => null,
  qr: async () => "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
  service: async () => true,
  uninstallHost: async () => true,
  checkUpdate: async () => null,
  openUpdate: async () => true,
});

await import("../src/renderer.mjs");
