#!/usr/bin/env node
// Aru self-hosted reference stub server.
//
// Implements the SELF-HOSTED-VPS-BRANCH.md contracts that native Aru already
// ships types for: /.well-known/aru.json manifest, one-time-token pairing that
// exchanges into a device-scoped credential, bearer-authenticated backup-vault
// upload/inventory/download, Streamable HTTP MCP tools, isolated workspace
// execution, and a layered diagnostics endpoint.
//
// Shape authority: the Swift types in packages/PolarisStore are the single
// source of truth. Manifest keys mirror SelfHostedServerManifest, the pairing
// payload mirrors SelfHostedPairingEnvelope.parse, upload/inventory responses
// mirror SelfHostedVaultRuntime's UploadResponse/InventoryResponse, and
// inventory metadata mirrors SelfHostedBackupVaultPackageMetadata. Object
// counts and archive facts are echoed verbatim from the uploaded envelope's
// own metadata; this server never fabricates archive facts.
//
// Zero dependencies. Node >= 18.
//
//   node aru-selfhost-stub.mjs [--listen-host 127.0.0.1] [--port 8787]
//     [--data-dir ~/.aru-selfhost-stub]
//     [--managed-workspace-root ~/Aru\ Workspace]
//     [--base-url http://127.0.0.1:8787] [--transport-kind lan]
//     [--display-name "Aru Stub"] [--node-kind local-device]
//     [--pairing-token <fixed token for dev>] [--max-package-mb 2048]
//     [--container-runtime docker|podman] [--container-memory 1g]
//
// Security posture (stub tier): device credentials are stored as SHA-256
// hashes only; the bootstrap pairing token is single-use with a 10 minute
// TTL; package bytes are stored as received (they are client-encrypted
// envelopes); workspace code only runs inside a hardened disposable container;
// nothing here logs secrets after the initial pairing printout.

import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPluginSupervisor } from "./plugin-supervisor.mjs";
import { createSourcePluginRuntime } from "./source-plugin-runtime.mjs";
import { createCollaboratorHost } from "./collaborator-host.mjs";
import { createNodeWorkspaceHost } from "./node-workspaces.mjs";
import { createNodeControl } from "./node-control.mjs";
import { createBackupSettings } from "./backup-settings.mjs";
import { createConversationTurnRelay } from "./conversation-turn-relay.mjs";

class HttpError extends Error {
  constructor(status, code, message, { issues = [], recovery = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.recovery = recovery;
  }
}

const args = parseArgs(process.argv.slice(2));
const configuredDataDir = expandHome(args["data-dir"] ?? "~/.aru-selfhost-stub");
const config = {
  listenHost: args["listen-host"] ?? "0.0.0.0",
  port: Number(args["port"] ?? 8787),
  dataDir: configuredDataDir,
  managedWorkspaceRoot: expandHome(
    args["managed-workspace-root"] ?? join(configuredDataDir, "workspace"),
  ),
  baseUrl: (args["base-url"] ?? `http://127.0.0.1:${Number(args["port"] ?? 8787)}`).replace(/\/+$/, ""),
  transportKind: args["transport-kind"] ?? "lan",
  displayName: args["display-name"] ?? "Aru Stub Server",
  nodeKind: args["node-kind"] ?? "local-device",
  fixedPairingToken: args["pairing-token"] ?? null,
  maxPackageBytes: Number(args["max-package-mb"] ?? 2048) * 1024 * 1024,
  maxWorkspaceBytes: Number(args["max-workspace-mb"] ?? 512) * 1024 * 1024,
  maxWorkspaceOutputBytes: Number(args["max-workspace-output-mb"] ?? 32) * 1024 * 1024,
  pluginCallTimeoutSeconds: nonnegativeInteger(
    args["plugin-call-timeout-seconds"] ?? 3600,
    "plugin-call-timeout-seconds",
  ),
  containerRuntime: requestedContainerRuntime(args["container-runtime"]),
  containerMemory: args["container-memory"] ?? "1g",
  containerCPUs: args["container-cpus"] ?? "2",
  runtimeImages: {
    node: args["node-image"] ?? "node:22-alpine",
    python: args["python-image"] ?? "python:3.13-alpine",
    shell: args["shell-image"] ?? "alpine:3.22",
  },
};

function requestedContainerRuntime(value) {
  if (value === "none") return null;
  return value ?? detectContainerRuntime();
}

function nonnegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
const MANIFEST_SCHEMA = "aru.selfhost.manifest.v1";
const PAIRING_GRANT_SCHEMA = "aru.selfhost.pairing-grant.v1";
const VAULT_METADATA_SCHEMA = "aru.selfhost.backup-package-metadata.v1";
const ENVELOPE_FORMAT = "aru-native-encrypted-package";
const WORKSPACE_RUN_SCHEMA = "aru.selfhost.workspace-run.v1";
const WORKSPACE_RESULT_SCHEMA = "aru.selfhost.workspace-result.v1";
const WORKSPACE_JOB_SCHEMA = "aru.selfhost.workspace-job.v1";
const WORKSPACE_JOB_INVENTORY_SCHEMA = "aru.selfhost.workspace-job-inventory.v1";
const WORKSPACE_JOB_EVENTS_SCHEMA = "aru.selfhost.workspace-job-events.v1";
const WORKSPACE_JOB_POLICY_SCHEMA = "aru.selfhost.workspace-job-policy.v1";
const OFFICIAL_DEFAULT_MAXIMUM_RUNTIME_SECONDS = 24 * 60 * 60;
const CONTAINER_STOP_GRACE_SECONDS = 5;
const ARTIFACT_METADATA_SCHEMA = "aru.selfhost.artifact-metadata.v1";
const WORKSPACE_RUNTIMES = ["node", "python", "shell"];
const SERVER_VERSION = "stub-0.28";
const ENCRYPTED_PACKAGE_MAGIC = Buffer.from("ARUEPKG2", "ascii");
const ENCRYPTED_PACKAGE_VERSION = 2;
const ENCRYPTED_PACKAGE_CONTENT_TYPE = "application/vnd.aru.encrypted-backup";
const MAX_ENCRYPTED_PACKAGE_HEADER_BYTES = 1024 * 1024;
const MAX_ENCRYPTED_PACKAGE_CHUNK_BYTES = 16 * 1024 * 1024;
const ARTIFACT_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip",
  ".mp3", ".m4a", ".wav", ".mp4", ".mov", ".sqlite", ".db",
  ".wasm", ".bin",
]);
const MCP_PROTOCOL_VERSION = "2025-11-25";
const mcpSessions = new Map();
const activeJobProcesses = new Map();

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, "packages"), { recursive: true });
mkdirSync(join(config.dataDir, "artifacts"), { recursive: true });

const statePath = join(config.dataDir, "state.json");
const state = loadState();
normalizeLegacyHostConsoleDevices();
const recoveredJobIds = recoverInterruptedJobs();
const nodeControl = createNodeControl({
  config,
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  log,
});
const backupSettings = createBackupSettings({
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  deletePackage: (remotePackageId, actor) => deleteBackupPackage(remotePackageId, actor, false),
  log,
});
const conversationTurnRelay = createConversationTurnRelay({
  dataDir: config.dataDir,
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  maximumRequestBytes: config.maxWorkspaceBytes,
  log,
});

// A fresh single-use pairing token on every boot (unless pinned for dev).
state.pairing = {
  token: config.fixedPairingToken ?? randomBytes(24).toString("base64url"),
  issuedAt: Date.now(),
  consumedAt: null,
};
saveState();
const sourcePluginRuntime = createSourcePluginRuntime({
  dataDir: config.dataDir,
  runnerPath: join(dirname(fileURLToPath(import.meta.url)), "source-plugin-runner.mjs"),
  nodeBinary: process.execPath,
  containerRuntime: config.containerRuntime,
  nodeImage: config.runtimeImages.node,
  maximumSourceBytes: config.maxWorkspaceBytes,
  maximumOutputBytes: config.maxWorkspaceOutputBytes,
  callTimeoutSeconds: config.pluginCallTimeoutSeconds,
  HttpError,
});
const pluginSupervisor = createPluginSupervisor({
  state,
  containerRuntime: config.containerRuntime,
  sourceRuntime: sourcePluginRuntime,
  stopGraceSeconds: CONTAINER_STOP_GRACE_SECONDS,
  saveState,
  log,
  readJSONBody,
  sendJSON,
  HttpError,
});
const collaboratorHost = createCollaboratorHost({
  dataDir: config.dataDir,
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  managedWorkspaceRoot: config.managedWorkspaceRoot,
  toolCatalog: () => [...officialMCPTools(), ...pluginSupervisor.dynamicMCPTools()],
  executeTool: executeMCPTool,
  log,
});
const nodeWorkspaceHost = createNodeWorkspaceHost({
  config,
  state,
  saveState,
  log,
  readJSONBody,
  sendJSON,
  HttpError,
  mcpOperationTool,
  mcpIdentifierSchema,
});
nodeWorkspaceHost.ensureManagedWorkspace();

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJSON(res, error.status, { error: error.code, message: error.message });
    } else {
      log(`unhandled error: ${error?.message ?? error}`);
      sendJSON(res, 500, { error: "internal", message: "internal error" });
    }
  }
});

server.listen(config.port, config.listenHost, () => {
  const manifestURL = `${config.baseUrl}/.well-known/aru.json`;
  const pairingPayload = {
    schema: "aru.selfhost.pairing-envelope.v1",
    canonicalUrl: config.baseUrl,
    manifestUrl: manifestURL,
    serverId: state.serverId,
    pairingToken: state.pairing.token,
    installSessionLabel: "stub-boot",
  };
  const pairingURL =
    `aru://pair?canonicalUrl=${encodeURIComponent(config.baseUrl)}` +
    `&serverId=${encodeURIComponent(state.serverId)}` +
    `&pairingToken=${encodeURIComponent(state.pairing.token)}` +
    `&manifestUrl=${encodeURIComponent(manifestURL)}`;

  console.log("Aru self-hosted stub server");
  console.log("===========================");
  console.log(`listening      ${config.listenHost}:${config.port} as ${config.baseUrl}`);
  console.log(`data dir       ${config.dataDir}`);
  console.log(`server id      ${state.serverId}`);
  console.log(`manifest       ${manifestURL}`);
  console.log(`runtime        ${config.containerRuntime ?? "unavailable (install Docker or Podman)"}`);
  console.log("");
  console.log("Pairing payload (paste into Aru, or encode as QR). Single use,");
  console.log(`expires in 10 minutes:`);
  console.log("");
  console.log(JSON.stringify(pairingPayload, null, 2));
  console.log("");
  console.log(pairingURL);
  console.log("");
  console.log("No secrets are logged past this point.");
  for (const jobId of recoveredJobIds) {
    setImmediate(() => executeWorkspaceJob(jobId));
  }
  setImmediate(() => pluginSupervisor.reconcileInstalledPlugins()
    .catch((error) => log(`plugin reconciliation failed: ${error?.message ?? error}`)));
});

// ---------------------------------------------------------------------------
// Routing

async function route(req, res) {
  const url = new URL(req.url, config.baseUrl);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/.well-known/aru.json") {
    return sendJSON(res, 200, manifest());
  }
  if (req.method === "POST" && path === "/aru/v1/pair") {
    return handlePair(req, res);
  }
  if (req.method === "GET" && path === "/aru/v1/diagnostics") {
    return handleDiagnostics(req, res);
  }
  if (path === "/aru/v1/backups" && req.method === "POST") {
    return handleUpload(req, res, requireDevice(req));
  }
  if (path === "/aru/v1/backups" && req.method === "GET") {
    requireDevice(req);
    return sendJSON(res, 200, inventory());
  }
  if (await backupSettings.route(req, res, path, () => requireDevice(req))) return;
  if (await conversationTurnRelay.route(req, res, path, requireDevice)) return;
  if (path === "/aru/v1/jobs" && req.method === "POST") {
    return handleWorkspaceJobSubmit(req, res, requireDevice(req));
  }
  if (path === "/aru/v1/jobs" && req.method === "GET") {
    requireDevice(req);
    return sendJSON(res, 200, workspaceJobInventory());
  }
  if (path === "/aru/v1/jobs/policy" && req.method === "GET") {
    requireDevice(req);
    return sendJSON(res, 200, publicWorkspaceJobPolicy());
  }
  if (path === "/aru/v1/jobs/policy" && req.method === "PUT") {
    return handleWorkspaceJobPolicyUpdate(req, res, requireDevice(req));
  }
  if (await nodeControl.route(req, res, path, () => requireDevice(req))) return;
  if (await nodeWorkspaceHost.route(req, res, url, path, requireDevice)) return;
  if (await collaboratorHost.route(
    req,
    res,
    path,
    () => requireDevice(req),
    () => requireLocalHostConsole(req),
  )) return;
  if (await pluginSupervisor.route(req, res, url, path, () => requireDevice(req))) return;
  if (path === "/aru/v1/artifacts" && req.method === "GET") {
    requireDevice(req);
    return sendJSON(res, 200, artifactInventory());
  }
  if (path === "/aru/v1/mcp" && req.method === "POST") {
    return handleMCP(req, res, requireDevice(req));
  }
  if (req.method === "GET" && path.startsWith("/aru/v1/backups/")) {
    requireDevice(req);
    return handleDownload(req, res, decodeURIComponent(path.split("/").pop()));
  }
  if (req.method === "DELETE" && path.startsWith("/aru/v1/backups/")) {
    return handleDelete(req, res, decodeURIComponent(path.split("/").pop()), requireDevice(req));
  }
  if (req.method === "GET" && path.startsWith("/aru/v1/artifacts/")) {
    requireDevice(req);
    return handleArtifactDownload(req, res, decodeURIComponent(path.split("/").pop()));
  }
  if (req.method === "DELETE" && path.startsWith("/aru/v1/artifacts/")) {
    return handleArtifactDelete(req, res, decodeURIComponent(path.split("/").pop()), requireDevice(req));
  }
  const jobRoute = matchWorkspaceJobRoute(path);
  if (jobRoute && req.method === "GET" && jobRoute.action === null) {
    requireDevice(req);
    return handleWorkspaceJobStatus(res, jobRoute.jobId);
  }
  if (jobRoute && req.method === "GET" && jobRoute.action === "events") {
    requireDevice(req);
    return handleWorkspaceJobEvents(res, jobRoute.jobId);
  }
  if (jobRoute && req.method === "POST" && jobRoute.action === "cancel") {
    return handleWorkspaceJobCancel(res, jobRoute.jobId, requireDevice(req));
  }
  if (jobRoute && req.method === "POST" && jobRoute.action === "retry") {
    return handleWorkspaceJobRetry(res, jobRoute.jobId, requireDevice(req));
  }
  throw new HttpError(404, "route.unknown", "unknown route");
}

// ---------------------------------------------------------------------------
// Manifest — keys mirror SelfHostedServerManifest CodingKeys exactly.

function manifest() {
  return {
    schema: MANIFEST_SCHEMA,
    serverId: state.serverId,
    nodeKind: config.nodeKind,
    displayName: nodeControl.displayName(),
    serverVersion: SERVER_VERSION,
    minClientVersion: "1.0",
    transportProfiles: [
      {
        id: "primary",
        kind: config.transportKind,
        baseUrl: config.baseUrl,
        priority: 10,
      },
    ],
    capabilities: {
      "backup-vault": {
        enabled: true,
        endpoint: "/aru/v1/backups",
        encryption: ["full-package-client-password"],
        restore: "manual-staging-only",
        packageFormats: ["aru-native-encrypted-package-v2"],
        ...backupSettings.manifestCapability(),
      },
      "sync-ledger": {
        enabled: false,
        status: "reserved",
      },
      "conversation-turn-relay": {
        enabled: true,
        endpoint: "/aru/v1/conversation-turns",
        execution: "durable-provider-response-v1",
        idempotency: "device-and-client-turn-id",
        secretRetention: "request-lifetime-only",
        restartPolicy: "interrupt-without-replay",
      },
      "workspace-runtime": {
        enabled: config.containerRuntime !== null,
        endpoint: "/aru/v1/jobs",
        runtimes: WORKSPACE_RUNTIMES,
        isolation: "non-root-container",
        network: "disabled",
        execution: "durable-jobs-v1",
      },
      "job-runtime": {
        enabled: config.containerRuntime !== null,
        endpoint: "/aru/v1/jobs",
        states: ["queued", "preparing", "running", "succeeded", "failed", "cancelled", "timed_out"],
        cancellation: "explicit",
        retry: "new-linked-job",
      },
      "mcp-gateway": {
        enabled: true,
        endpoint: "/aru/v1/mcp",
        transport: "streamable-http",
        credentialMode: "paired-node-device-credential",
        displayName: `${nodeControl.displayName()} Tools`,
      },
      "artifact-vault": {
        enabled: true,
        endpoint: "/aru/v1/artifacts",
        integrity: "sha256",
        publication: "explicit-client-import",
      },
      "plugin-supervisor": {
        enabled: config.containerRuntime !== null || sourcePluginRuntime.available,
        endpoint: "/aru/v1/plugins",
        packageModes: [
          ...(config.containerRuntime !== null ? ["oci"] : []),
          ...(sourcePluginRuntime.available ? ["source-node"] : []),
        ],
        imageIdentity: "sha256-digest-required",
        activation: "confirmed-direct-apply-or-explicit-lifecycle-control",
        workshop: sourcePluginRuntime.available ? "model-author-validate-save-draft-or-apply" : "unavailable",
      },
      "collaborator-host": {
        enabled: true,
        endpoint: "/aru/v1/hosted-collaborators",
        driverEndpoint: "/aru/v1/agent-drivers",
        authority: "computer-host",
        clientProjection: "read-only-replica",
        phase: "computer-authoritative-conversations",
        turnExecution: collaboratorHost.driverInventory().execution.enabled,
        conversationEndpoint: "/aru/v1/hosted-collaborators/{collaboratorId}/conversations",
        cognitionEndpoint: "/aru/v1/hosted-collaborators/{collaboratorId}/cognition",
        providerProfileEndpoint: "/aru/v1/provider-profiles",
        surfaceExecution: true,
        surfaceEndpoint: "/aru/v1/hosted-collaborators/{collaboratorId}/surfaces",
      },
      "node-workspaces": {
        ...nodeWorkspaceHost.manifestCapability(),
      },
      "node-settings": {
        ...nodeControl.manifestCapability(),
      },
    },
    pairing: {
      endpoint: "/aru/v1/pair",
      methods: ["qr-token"],
    },
    diagnostics: {
      endpoint: "/aru/v1/diagnostics",
    },
  };
}

// ---------------------------------------------------------------------------
// Pairing — one-time bootstrap token exchanged for a device-scoped credential.

async function handlePair(req, res) {
  const body = await readJSONBody(req, 64 * 1024);
  const token = String(body.pairingToken ?? "").trim();
  if (!token) throw new HttpError(400, "pairing.missing_token", "pairingToken required");

  const pairing = state.pairing;
  const expired = Date.now() - pairing.issuedAt > PAIRING_TOKEN_TTL_MS;
  if (pairing.consumedAt || expired || !safeEqual(token, pairing.token)) {
    throw new HttpError(401, "pairing.rejected", "pairing token rejected or expired");
  }

  pairing.consumedAt = Date.now();
  const credentialSecret = randomBytes(32).toString("base64url");
  const deviceRole = optionalPairingDeviceRole(body.deviceRole);
  if (deviceRole) {
    for (const existing of state.devices) {
      if (existing.deviceRole === deviceRole && !existing.revokedAt) {
        existing.revokedAt = pairing.consumedAt;
      }
    }
  }
  const device = {
    deviceId: `dev_${randomUUID()}`,
    label: String(body.deviceLabel ?? "").trim() || "unnamed device",
    deviceRole,
    credentialSHA256: sha256Hex(credentialSecret),
    issuedAt: Date.now(),
    revokedAt: null,
  };
  state.devices.push(device);
  saveState();
  log(`paired device ${device.deviceId} (${device.label})`);

  sendJSON(res, 200, {
    schema: PAIRING_GRANT_SCHEMA,
    serverId: state.serverId,
    deviceId: device.deviceId,
    credentialSecret,
    credentialScope: "device",
    issuedAt: device.issuedAt,
    expiresAt: null,
    rotationPolicy: "manual",
    nextRotationAt: null,
    bootstrapTokenConsumedAt: pairing.consumedAt,
  });
}

function optionalPairingDeviceRole(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value === "host-console") return value;
  throw new HttpError(400, "pairing.device_role_unsupported", "unsupported pairing device role");
}

function normalizeLegacyHostConsoleDevices() {
  const consoles = state.devices
    .filter((device) => device.deviceRole === "host-console"
      || (device.deviceRole == null && device.label === "Aru Host Console"))
    .sort((left, right) => right.issuedAt - left.issuedAt);
  for (const device of consoles) device.deviceRole = "host-console";
  const active = consoles.filter((device) => !device.revokedAt);
  for (const stale of active.slice(1)) stale.revokedAt = Date.now();
}

function requireDevice(req) {
  const header = req.headers["authorization"] ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new HttpError(401, "credential.missing", "bearer credential required");
  const hash = sha256Hex(match[1].trim());
  const device = state.devices.find((d) => safeEqual(d.credentialSHA256, hash));
  if (!device) throw new HttpError(401, "credential.unknown", "credential rejected");
  if (device.revokedAt) throw new HttpError(403, "credential.revoked", "device revoked");
  return device;
}

function requireLocalHostConsole(req) {
  const device = requireDevice(req);
  if (device.deviceRole !== "host-console") {
    throw new HttpError(403, "credential.host_console_required", "模型 API 配置只能由本机 Aru Host Console 修改");
  }
  const address = String(req.socket?.remoteAddress ?? "");
  const loopback = address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");
  if (!loopback) {
    throw new HttpError(403, "credential.loopback_required", "模型 API 配置不能通过局域网修改");
  }
  return device;
}

// ---------------------------------------------------------------------------
// MCP gateway — authenticated Streamable HTTP, using the same paired-device
// credential as the rest of the node. Tools are ordinary MCP tools, so native
// Aru's per-tool Ask Every Time / Always Allow policy remains the sole caller
// authorization layer.

const MCP_TOOLS = [
  {
    name: "aru_node_status",
    title: "Aru node status",
    description: "Read this self-hosted Aru node's public runtime and capability status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        displayName: { type: "string" },
        serverVersion: { type: "string" },
        packageCount: { type: "integer" },
        activeDeviceCount: { type: "integer" },
        workspaceRuntimeAvailable: { type: "boolean" },
      },
      required: [
        "serverId", "displayName", "serverVersion", "packageCount",
        "activeDeviceCount", "workspaceRuntimeAvailable",
      ],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "aru_node_settings",
    title: "Aru node settings",
    description: "Read this node's editable identity settings and current revision.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        schema: { type: "string" },
        displayName: { type: "string" },
        revision: { type: "integer" },
        updatedAt: { type: "integer" },
      },
      required: ["schema", "displayName", "revision", "updatedAt"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  mcpOperationTool({
    name: "aru_node_rename",
    title: "Rename Aru node",
    description: "Rename this node using the revision returned by aru_node_settings so concurrent changes cannot be overwritten.",
    properties: {
      displayName: { type: "string", minLength: 1, maxLength: 80, description: "New user-visible node name." },
      expectedRevision: { type: "integer", minimum: 1, description: "Revision returned by aru_node_settings." },
    },
    required: ["displayName", "expectedRevision"],
    idempotentHint: true,
  }),
  {
    name: "aru_backup_inventory",
    title: "Aru backup inventory",
    description: "List encrypted backup points stored on this node without returning package bytes or credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        packages: { type: "array", items: { type: "object" } },
      },
      required: ["packages"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  mcpOperationTool({
    name: "aru_backup_settings",
    title: "Aru backup settings",
    description: "Read the Host-owned backup retention policy shared by every paired Aru client.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_backup_settings_update",
    title: "Update Aru backup settings",
    description: "Update the Host-owned backup retention policy using its current revision, then apply it immediately.",
    properties: {
      retentionMode: { type: "string", enum: ["keep-all", "keep-latest"], description: "Whether the Host keeps every backup or only the newest count." },
      keepLatestCount: { type: ["integer", "null"], minimum: 1, description: "Required for keep-latest; null for keep-all." },
      expectedRevision: { type: "integer", minimum: 1, description: "Revision returned by aru_backup_settings." },
    },
    required: ["retentionMode", "keepLatestCount", "expectedRevision"],
    idempotentHint: true,
    destructiveHint: true,
  }),
  mcpOperationTool({
    name: "aru_backup_delete",
    title: "Delete Aru remote backup",
    description: "Delete one encrypted remote backup point. This never deletes local Aru data or downloaded restore staging.",
    properties: { remotePackageId: mcpIdentifierSchema("Remote backup package id from aru_backup_inventory.") },
    required: ["remotePackageId"],
    destructiveHint: true,
    idempotentHint: false,
  }),
  {
    name: "aru_paired_devices",
    title: "Aru paired devices",
    description: "List paired device identities and revocation state without returning credential material.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        devices: { type: "array", items: { type: "object" } },
      },
      required: ["devices"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  mcpOperationTool({
    name: "aru_job_inventory",
    title: "Aru workspace job inventory",
    description: "List durable workspace jobs on this node without returning submitted workspace snapshots.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_job_status",
    title: "Aru workspace job status",
    description: "Read one durable workspace job, including its result after completion but never its submitted input snapshot.",
    properties: { jobId: mcpIdentifierSchema("Durable workspace job id.") },
    required: ["jobId"],
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_job_events",
    title: "Aru workspace job events",
    description: "Read the ordered state-event history for one durable workspace job.",
    properties: { jobId: mcpIdentifierSchema("Durable workspace job id.") },
    required: ["jobId"],
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_job_cancel",
    title: "Cancel Aru workspace job",
    description: "Explicitly cancel a queued or running durable workspace job.",
    properties: { jobId: mcpIdentifierSchema("Durable workspace job id.") },
    required: ["jobId"],
    destructiveHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_job_retry",
    title: "Retry Aru workspace job",
    description: "Create a new linked retry for a failed, cancelled, or timed-out workspace job.",
    properties: { jobId: mcpIdentifierSchema("Predecessor workspace job id.") },
    required: ["jobId"],
  }),
  mcpOperationTool({
    name: "aru_artifact_inventory",
    title: "Aru artifact inventory",
    description: "List immutable binary workspace artifacts stored on this node, including hashes and producer metadata.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_artifact_delete",
    title: "Delete Aru remote artifact",
    description: "Delete one remote artifact handle; already imported local Aru assets are not deleted.",
    properties: { artifactId: mcpIdentifierSchema("Remote artifact id.") },
    required: ["artifactId"],
    destructiveHint: true,
    idempotentHint: false,
  }),
  mcpOperationTool({
    name: "aru_plugin_inventory",
    title: "Aru plugin inventory",
    description: "List installed self-hosted plugins, reviewed permissions, desired state, health, and rollback availability.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_workshop_guide",
    title: "Read Aru plugin workshop guide",
    description: "Read the source-plugin contract, isolation rules, lifecycle, and a complete example before authoring a tool.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_source_validate",
    title: "Validate Aru source plugin",
    description: "Validate pluginId, displayName, version, sourceCode, and optional named capabilities. Omit capabilities for zero authority; supported values are persistent-storage and network-outbound.",
    properties: sourcePluginWorkshopProperties(),
    required: ["pluginId", "displayName", "version", "sourceCode"],
    destructiveHint: true,
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_source_save_draft",
    title: "Save Aru source plugin draft",
    description: "Validate and save a visible editable plugin draft without changing the installed release. Drafts are optional checkpoints, not an activation requirement.",
    properties: sourcePluginWorkshopProperties(),
    required: ["pluginId", "displayName", "version", "sourceCode"],
    destructiveHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_source_apply",
    title: "Apply Aru source plugin",
    description: "Validate, publish, and enable a source plugin in one confirmed operation. A failed update restores the previous working release; a failed first install remains visible for repair.",
    properties: sourcePluginWorkshopProperties(),
    required: ["pluginId", "displayName", "version", "sourceCode"],
    destructiveHint: true,
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_draft_inventory",
    title: "Aru plugin draft inventory",
    description: "List visible source-plugin editing checkpoints without returning their source bodies.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_status",
    title: "Aru plugin status",
    description: "Read the complete lifecycle receipt for one installed self-hosted plugin.",
    properties: { pluginId: mcpIdentifierSchema("Installed plugin id.") },
    required: ["pluginId"],
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_install",
    title: "Install Aru plugin",
    description: "Install a reviewed digest-pinned OCI plugin disabled by default. grantedPermissions must exactly match manifest.permissions.",
    properties: {
      manifest: { type: "object", description: "aru.selfhost.plugin-manifest.v1 manifest." },
      grantedPermissions: { type: "object", description: "Exact user-reviewed permission receipt." },
    },
    required: ["manifest", "grantedPermissions"],
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_enable",
    title: "Enable Aru plugin",
    description: "Explicitly start an installed self-hosted plugin under its reviewed isolation grant.",
    properties: { pluginId: mcpIdentifierSchema("Installed plugin id.") },
    required: ["pluginId"],
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_disable",
    title: "Disable Aru plugin",
    description: "Stop an installed self-hosted plugin without removing its package receipt or isolated data.",
    properties: { pluginId: mcpIdentifierSchema("Installed plugin id.") },
    required: ["pluginId"],
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_upgrade",
    title: "Upgrade Aru plugin",
    description: "Upgrade an installed plugin to a reviewed digest-pinned manifest, restoring the prior release if startup fails.",
    properties: {
      pluginId: mcpIdentifierSchema("Installed plugin id."),
      manifest: { type: "object", description: "Replacement aru.selfhost.plugin-manifest.v1 manifest." },
      grantedPermissions: { type: "object", description: "Exact user-reviewed permission receipt for the replacement manifest." },
    },
    required: ["pluginId", "manifest", "grantedPermissions"],
    destructiveHint: true,
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_rollback",
    title: "Roll back Aru plugin",
    description: "Swap an installed plugin with its retained previous release.",
    properties: { pluginId: mcpIdentifierSchema("Installed plugin id.") },
    required: ["pluginId"],
    destructiveHint: true,
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_uninstall",
    title: "Uninstall Aru plugin",
    description: "Uninstall one plugin and explicitly choose whether its isolated persistent data is deleted.",
    properties: {
      pluginId: mcpIdentifierSchema("Installed plugin id."),
      deleteData: { type: "boolean", description: "True deletes the isolated plugin volume; false retains it." },
    },
    required: ["pluginId", "deleteData"],
    destructiveHint: true,
  }),
];

function officialMCPTools() {
  return [...MCP_TOOLS, ...nodeWorkspaceHost.tools(), ...collaboratorHost.surfaceTools()];
}

function mcpIdentifierSchema(description) {
  return { type: "string", minLength: 1, description };
}

function sourcePluginWorkshopProperties() {
  return {
    pluginId: mcpIdentifierSchema("Stable lowercase plugin id."),
    displayName: { type: "string", minLength: 1, description: "User-visible plugin name." },
    version: { type: "string", minLength: 1, description: "Plugin release version." },
    sourceCode: { type: "string", minLength: 1, description: "JavaScript ESM source following aru_plugin_workshop_guide." },
    capabilities: {
      type: "array",
      description: "Optional explicit grants. Omit for zero authority.",
      items: { type: "string", enum: ["persistent-storage", "network-outbound"] },
      uniqueItems: true,
    },
  };
}

function mcpOperationTool({
  name,
  title,
  description,
  properties = {},
  required = [],
  readOnlyHint = false,
  destructiveHint = false,
  idempotentHint = false,
  openWorldHint = false,
}) {
  return {
    name,
    title,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint },
  };
}

async function handleMCP(req, res, device) {
  const body = await readJSONBody(req, config.maxWorkspaceBytes);
  if (body?.jsonrpc !== "2.0" || typeof body?.method !== "string") {
    return sendMCPError(res, body?.id ?? null, -32600, "Invalid Request");
  }

  if (body.method === "initialize") {
    const sessionId = `mcp_${randomUUID()}`;
    mcpSessions.set(sessionId, device.deviceId);
    return sendJSON(res, 200, {
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "Aru Self-Hosted MCP Gateway", version: SERVER_VERSION },
      },
    }, mcpResponseHeaders(sessionId));
  }

  const sessionId = String(req.headers["mcp-session-id"] ?? "").trim();
  if (!sessionId || mcpSessions.get(sessionId) !== device.deviceId) {
    throw new HttpError(404, "mcp.session_unknown", "MCP session is missing or expired");
  }

  if (body.method === "notifications/initialized") {
    return sendEmpty(res, 202, mcpResponseHeaders(sessionId));
  }
  if (body.method === "ping") {
    return sendMCPResult(res, sessionId, body.id, {});
  }
  if (body.method === "tools/list") {
    return sendMCPResult(res, sessionId, body.id, {
      tools: [...officialMCPTools(), ...pluginSupervisor.dynamicMCPTools()],
    });
  }
  if (body.method === "tools/call") {
    const name = String(body.params?.name ?? "").trim();
    const args = body.params?.arguments;
    if (!name) return sendMCPError(res, body.id, -32602, "Tool name is required", sessionId);
    if (args !== undefined && (args === null || Array.isArray(args) || typeof args !== "object")) {
      return sendMCPError(res, body.id, -32602, "Tool arguments must be an object", sessionId);
    }
    return await callMCPTool(res, sessionId, body.id, name, args ?? {}, device);
  }
  return sendMCPError(res, body.id ?? null, -32601, "Method not found", sessionId);
}

async function callMCPTool(res, sessionId, id, name, args, device) {
  try {
    const structuredContent = await executeMCPTool(name, args, device);
    return sendMCPResult(res, sessionId, id, {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const structuredContent = { code: error.code, message: error.message };
    if (error.issues?.length) structuredContent.issues = error.issues;
    if (error.recovery) structuredContent.recovery = error.recovery;
    return sendMCPResult(res, sessionId, id, {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: true,
    });
  }
}

async function executeMCPTool(name, args, device) {
    const tool = [...officialMCPTools(), ...pluginSupervisor.dynamicMCPTools()]
      .find((candidate) => candidate.name === name);
    if (!tool) throw new HttpError(400, "mcp.tool_unknown", `Unknown tool: ${name}`);
    validateMCPToolArguments(tool, args);
    let structuredContent;
    const nodeWorkspaceCall = nodeWorkspaceHost.callTool(name, args, device);
    if (nodeWorkspaceCall.matched) {
      structuredContent = nodeWorkspaceCall.value;
    } else if (name.startsWith("aru_collaborator_surface_")) {
      const surfaceCall = collaboratorHost.callSurfaceTool(name, args, device);
      if (!surfaceCall.matched) {
        throw new HttpError(400, "mcp.tool_unknown", `Unknown tool: ${name}`);
      }
      structuredContent = surfaceCall.value;
    } else if (name === "aru_node_status") {
      structuredContent = {
        serverId: state.serverId,
        displayName: nodeControl.displayName(),
        serverVersion: SERVER_VERSION,
        packageCount: state.packages.length,
        activeDeviceCount: state.devices.filter((entry) => !entry.revokedAt).length,
        workspaceRuntimeAvailable: config.containerRuntime !== null,
      };
    } else if (name === "aru_node_settings") {
      structuredContent = nodeControl.publicSettings();
    } else if (name === "aru_node_rename") {
      structuredContent = nodeControl.updateSettings({
        schema: "aru.selfhost.node-settings.v1",
        displayName: mcpRequiredString(args, "displayName"),
        expectedRevision: args.expectedRevision,
      }, device);
    } else if (name === "aru_backup_inventory") {
      structuredContent = {
        packages: [...state.packages]
          .sort((left, right) => right.uploadedAt - left.uploadedAt ||
            left.remotePackageId.localeCompare(right.remotePackageId))
          .map((entry) => ({
          remotePackageId: entry.remotePackageId,
          uploadedAt: entry.uploadedAt,
          sourceName: entry.metadata?.sourceName ?? "",
          createdAt: entry.metadata?.createdAt ?? 0,
          objectCounts: entry.metadata?.objectCounts ?? {},
          packageByteCount: entry.metadata?.packageByteCount ?? 0,
        })),
      };
    } else if (name === "aru_backup_settings") {
      structuredContent = backupSettings.publicSettings();
    } else if (name === "aru_backup_settings_update") {
      structuredContent = backupSettings.updateSettings({
        schema: "aru.selfhost.backup-settings.v1",
        retentionMode: args.retentionMode,
        keepLatestCount: args.keepLatestCount,
        expectedRevision: args.expectedRevision,
      }, device);
    } else if (name === "aru_backup_delete") {
      structuredContent = deleteBackupPackage(
        mcpRequiredString(args, "remotePackageId"), device.deviceId);
    } else if (name === "aru_paired_devices") {
      structuredContent = nodeControl.deviceInventory(device.deviceId);
    } else if (name === "aru_job_inventory") {
      structuredContent = workspaceJobInventory();
    } else if (name === "aru_job_status") {
      const job = workspaceJob(mcpRequiredString(args, "jobId"));
      if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
      structuredContent = publicWorkspaceJob(job, true);
    } else if (name === "aru_job_events") {
      const job = workspaceJob(mcpRequiredString(args, "jobId"));
      if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
      structuredContent = { schema: WORKSPACE_JOB_EVENTS_SCHEMA, jobId: job.jobId, events: job.events };
    } else if (name === "aru_job_cancel") {
      structuredContent = cancelWorkspaceJob(mcpRequiredString(args, "jobId"), device);
    } else if (name === "aru_job_retry") {
      structuredContent = retryWorkspaceJob(mcpRequiredString(args, "jobId"), device);
    } else if (name === "aru_artifact_inventory") {
      structuredContent = artifactInventory();
    } else if (name === "aru_artifact_delete") {
      structuredContent = deleteArtifact(mcpRequiredString(args, "artifactId"), device);
    } else if (name === "aru_plugin_inventory") {
      structuredContent = pluginSupervisor.inventory();
    } else if (name === "aru_plugin_workshop_guide") {
      structuredContent = pluginSupervisor.workshopGuide();
    } else if (name === "aru_plugin_source_validate") {
      structuredContent = await pluginSupervisor.validateSourceDraft(args);
    } else if (name === "aru_plugin_source_save_draft") {
      structuredContent = await pluginSupervisor.saveSourceDraft(args, device);
    } else if (name === "aru_plugin_source_apply") {
      structuredContent = await pluginSupervisor.applySource(args, device);
    } else if (name === "aru_plugin_draft_inventory") {
      structuredContent = pluginSupervisor.draftInventory();
    } else if (name === "aru_plugin_status") {
      structuredContent = pluginSupervisor.status(mcpRequiredString(args, "pluginId"));
    } else if (name === "aru_plugin_install") {
      structuredContent = await pluginSupervisor.install(mcpPluginMutation(args), device);
    } else if (name === "aru_plugin_enable") {
      structuredContent = await pluginSupervisor.enable(mcpRequiredString(args, "pluginId"), device);
    } else if (name === "aru_plugin_disable") {
      structuredContent = pluginSupervisor.disable(mcpRequiredString(args, "pluginId"), device);
    } else if (name === "aru_plugin_upgrade") {
      structuredContent = await pluginSupervisor.upgrade(
        mcpRequiredString(args, "pluginId"), mcpPluginMutation(args), device);
    } else if (name === "aru_plugin_rollback") {
      structuredContent = await pluginSupervisor.rollback(mcpRequiredString(args, "pluginId"), device);
    } else if (name === "aru_plugin_uninstall") {
      structuredContent = pluginSupervisor.uninstall(
        mcpRequiredString(args, "pluginId"), mcpRequiredBoolean(args, "deleteData"), device);
    } else {
      const dynamic = await pluginSupervisor.callDynamicMCPTool(name, args);
      if (!dynamic.matched) {
        throw new HttpError(400, "mcp.tool_unknown", `Unknown tool: ${name}`);
      }
      structuredContent = dynamic.value;
    }
    return structuredContent;
}

function mcpRequiredString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "mcp.argument_invalid", `${name} must be a non-empty string`);
  }
  return value.trim();
}

function validateMCPToolArguments(tool, args) {
  const schema = tool.inputSchema;
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (!(name in args)) {
      throw new HttpError(400, "mcp.argument_missing", `${name} is required`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property) {
      throw new HttpError(400, "mcp.argument_unknown", `${name} is not accepted by ${tool.name}`);
    }
    if (property.type === "string" && typeof value !== "string") {
      throw new HttpError(400, "mcp.argument_invalid", `${name} must be a string`);
    }
    if (property.type === "boolean" && typeof value !== "boolean") {
      throw new HttpError(400, "mcp.argument_invalid", `${name} must be a boolean`);
    }
    if (property.type === "object" &&
        (value === null || Array.isArray(value) || typeof value !== "object")) {
      throw new HttpError(400, "mcp.argument_invalid", `${name} must be an object`);
    }
  }
}

function mcpRequiredBoolean(args, name) {
  if (typeof args[name] !== "boolean") {
    throw new HttpError(400, "mcp.argument_invalid", `${name} must be a boolean`);
  }
  return args[name];
}

function mcpPluginMutation(args) {
  if (!args.manifest || Array.isArray(args.manifest) || typeof args.manifest !== "object" ||
      !args.grantedPermissions || Array.isArray(args.grantedPermissions) ||
      typeof args.grantedPermissions !== "object") {
    throw new HttpError(400, "mcp.argument_invalid", "manifest and grantedPermissions must be objects");
  }
  return {
    schema: "aru.selfhost.plugin-mutation.v1",
    manifest: args.manifest,
    grantedPermissions: args.grantedPermissions,
  };
}

function sendMCPResult(res, sessionId, id, result) {
  return sendJSON(res, 200, { jsonrpc: "2.0", id: id ?? null, result },
    mcpResponseHeaders(sessionId));
}

function sendMCPError(res, id, code, message, sessionId = null) {
  return sendJSON(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    mcpResponseHeaders(sessionId));
}

function mcpResponseHeaders(sessionId = null) {
  return {
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    // MCP session identity lives in the header, not the TCP connection. A
    // fresh connection prevents the next iOS call from reusing a LAN socket
    // that became stale while a VPN or local route changed underneath it.
    connection: "close",
  };
}

// ---------------------------------------------------------------------------
// Backup vault

async function handleUpload(req, res, device) {
  const temporaryFile = join(resolve(config.dataDir, "packages"), `.upload-${randomUUID()}.tmp`);
  const received = await streamRequestToFile(req, temporaryFile, config.maxPackageBytes);
  const declaredSHA = String(req.headers["x-aru-vault-package-sha256"] ?? "").trim().toLowerCase();
  try {
    if (declaredSHA && declaredSHA !== received.sha256Hex) {
      throw new HttpError(400, "package.sha_mismatch", "declared package hash does not match body");
    }
    const parsed = inspectEncryptedPackageFile(temporaryFile);
    const envelope = parsed.header;
    const inner = envelope.metadata;

    const clientPackageId = String(req.headers["x-aru-vault-package-id"] ?? "").trim()
      || `bv_unlabeled_${received.sha256Hex.slice(0, 16)}`;
    const remotePackageId = `r_${received.sha256Hex.slice(0, 24)}`;
    const uploadedAt = Date.now();

    const metadata = {
      schema: VAULT_METADATA_SCHEMA,
      packageId: clientPackageId,
      nodeId: String(req.headers["x-aru-node-id"] ?? "").trim(),
      serverId: state.serverId,
      displayName: nodeControl.displayName(),
      restorePolicy: "manual-staging-only",
      encryptionMode: "full-package-client-password",
      envelopeFormat: envelope.format,
      envelopeVersion: envelope.version,
      envelopeAlgorithm: String(envelope.algorithm ?? ""),
      envelopeKDF: String(envelope.kdf ?? ""),
      envelopeKDFIterations: Number(envelope.kdfIterations ?? 0),
      archiveFormat: String(inner.archiveFormat ?? ""),
      archiveVersion: Number(inner.archiveVersion ?? 0),
      createdAt: Number(inner.createdAt ?? 0),
      sourcePlatform: String(inner.sourcePlatform ?? ""),
      sourceName: String(inner.sourceName ?? ""),
      objectCounts: inner.objectCounts ?? {},
      binaryCount: Number(inner.binaryCount ?? 0),
      binaryBytes: Number(inner.binaryBytes ?? 0),
      hasSecretBundle: Boolean(inner.hasSecretBundle ?? false),
      featureFlags: Array.isArray(inner.featureFlags) ? inner.featureFlags : [],
      warningCount: Number(inner.warningCount ?? 0),
      packageByteCount: received.byteCount,
      packageSHA256Hex: received.sha256Hex,
      ciphertextByteCount: parsed.ciphertextByteCount,
      ciphertextSHA256Hex: parsed.ciphertextSHA256Hex,
      plaintextByteCount: Number(inner.plaintextByteCount ?? 0),
    };

    renameSync(temporaryFile, packageFile(remotePackageId));
    state.packages = state.packages.filter((p) => p.remotePackageId !== remotePackageId);
    state.packages.push({ remotePackageId, uploadedAt, deviceId: device.deviceId, metadata });
    saveState();
    backupSettings.applyRetention(`upload:${device.deviceId}`);
    log(`stored package ${remotePackageId} (${received.byteCount} bytes) from ${device.deviceId}`);

    sendJSON(res, 200, { remotePackageId, uploadedAt });
  } catch (error) {
    if (existsSync(temporaryFile)) unlinkSync(temporaryFile);
    throw error;
  }
}

function inventory() {
  return {
    packages: state.packages.map((p) => ({
      remotePackageId: p.remotePackageId,
      metadata: p.metadata,
      uploadedAt: p.uploadedAt,
    })),
  };
}

function handleDownload(req, res, remotePackageId) {
  const validatedPackageId = validateRemotePackageId(remotePackageId);
  const entry = state.packages.find((p) => p.remotePackageId === validatedPackageId);
  const file = packageFile(validatedPackageId);
  if (!entry || !existsSync(file)) {
    throw new HttpError(404, "package.unknown", "unknown package");
  }
  const byteCount = statSync(file).size;
  res.writeHead(200, {
    "content-type": ENCRYPTED_PACKAGE_CONTENT_TYPE,
    "content-length": byteCount,
    "x-aru-vault-package-sha256": entry.metadata.packageSHA256Hex,
  });
  createReadStream(file).pipe(res);
}

function handleDelete(req, res, remotePackageId, device) {
  sendJSON(res, 200, deleteBackupPackage(remotePackageId, device.deviceId));
}

function deleteBackupPackage(remotePackageId, actor, persist = true) {
  const validatedPackageId = validateRemotePackageId(remotePackageId);
  const index = state.packages.findIndex((p) => p.remotePackageId === validatedPackageId);
  const file = packageFile(validatedPackageId);
  const fileExists = existsSync(file);
  if (index === -1 && !fileExists) {
    throw new HttpError(404, "package.unknown", "unknown package");
  }
  if (index !== -1) {
    state.packages.splice(index, 1);
  }
  if (fileExists) {
    unlinkSync(file);
  }
  if (persist) saveState();
  log(`deleted package ${validatedPackageId} for ${actor}`);
  return { remotePackageId: validatedPackageId, deleted: true, deletedAt: Date.now() };
}

function validateRemotePackageId(value) {
  const packageId = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(packageId)) {
    throw new HttpError(400, "package.id_invalid", "backup package id is invalid");
  }
  return packageId;
}

function packageFile(remotePackageId) {
  const packagesRoot = resolve(config.dataDir, "packages");
  const target = resolve(packagesRoot, `${validateRemotePackageId(remotePackageId)}.aruencpkg`);
  if (!target.startsWith(packagesRoot + sep)) {
    throw new HttpError(400, "package.id_invalid", "backup package path escaped the vault");
  }
  return target;
}

async function streamRequestToFile(req, file, limit) {
  const output = createWriteStream(file, { flags: "wx", mode: 0o600 });
  const outputError = once(output, "error").then(([error]) => { throw error; });
  const hash = createHash("sha256");
  let byteCount = 0;
  try {
    for await (const chunk of req) {
      byteCount += chunk.length;
      if (Number.isFinite(limit) && limit > 0 && byteCount > limit) {
        throw new HttpError(413, "package.too_large", "body exceeds configured package budget");
      }
      hash.update(chunk);
      if (!output.write(chunk)) await Promise.race([once(output, "drain"), outputError]);
    }
    output.end();
    await Promise.race([once(output, "finish"), outputError]);
    return { byteCount, sha256Hex: hash.digest("hex") };
  } catch (error) {
    output.destroy();
    if (existsSync(file)) unlinkSync(file);
    throw error;
  }
}

function inspectEncryptedPackageFile(file) {
  const fd = openSync(file, "r");
  try {
    const prefix = readFileRange(fd, 0, 12);
    if (!prefix.subarray(0, 8).equals(ENCRYPTED_PACKAGE_MAGIC)) {
      throw new HttpError(400, "package.unsupported_format", "encrypted package magic is not supported");
    }
    const headerByteCount = prefix.readUInt32BE(8);
    if (headerByteCount === 0 || headerByteCount > MAX_ENCRYPTED_PACKAGE_HEADER_BYTES) {
      throw new HttpError(400, "package.invalid_header", "encrypted package header size is invalid");
    }
    const encodedHeader = readFileRange(fd, 12, headerByteCount);
    let header;
    try {
      header = JSON.parse(encodedHeader.toString("utf8"));
    } catch {
      throw new HttpError(400, "package.invalid_header", "encrypted package header is not JSON");
    }
    validateEncryptedPackageHeader(header);

    const ciphertextHash = createHash("sha256");
    let ciphertextByteCount = 0;
    let offset = 12 + headerByteCount;
    for (let index = 0; index < header.chunkCount; index += 1) {
      const plaintextByteCount = readFileRange(fd, offset, 4).readUInt32BE(0);
      offset += 4;
      if (plaintextByteCount === 0 || plaintextByteCount > header.chunkByteCount) {
        throw new HttpError(400, "package.invalid_chunk", "encrypted package chunk size is invalid");
      }
      const ciphertext = readFileRange(fd, offset, plaintextByteCount);
      ciphertextHash.update(ciphertext);
      ciphertextByteCount += ciphertext.length;
      offset += plaintextByteCount;
      readFileRange(fd, offset, 16);
      offset += 16;
    }
    const packageByteCount = statSync(file).size;
    if (offset !== packageByteCount ||
        ciphertextByteCount !== Number(header.metadata.plaintextByteCount)) {
      throw new HttpError(400, "package.invalid_length", "encrypted package length does not match its header");
    }
    return {
      header,
      ciphertextByteCount,
      ciphertextSHA256Hex: ciphertextHash.digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

function validateEncryptedPackageHeader(header) {
  if (!header || typeof header !== "object" ||
      header.format !== ENVELOPE_FORMAT ||
      header.version !== ENCRYPTED_PACKAGE_VERSION ||
      header.algorithm !== "AES-256-GCM-CHUNKED" ||
      header.kdf !== "PBKDF2-HMAC-SHA256") {
    throw new HttpError(400, "package.unsupported_format", "unsupported encrypted package format/version");
  }
  if (!Number.isSafeInteger(header.kdfIterations) || header.kdfIterations < 1 ||
      header.kdfIterations > 1_000_000 ||
      !Number.isSafeInteger(header.chunkByteCount) || header.chunkByteCount < 1 ||
      header.chunkByteCount > MAX_ENCRYPTED_PACKAGE_CHUNK_BYTES ||
      !Number.isSafeInteger(header.chunkCount) || header.chunkCount < 1 ||
      !/^[0-9a-f]{32}$/i.test(String(header.saltHex ?? "")) ||
      !/^[0-9a-f]{16}$/i.test(String(header.noncePrefixHex ?? ""))) {
    throw new HttpError(400, "package.invalid_header", "encrypted package cryptographic header is invalid");
  }
  const inner = header.metadata;
  if (!inner || typeof inner !== "object" ||
      inner.archiveFormat !== "polaris-native-archive" || inner.archiveVersion !== 1 ||
      !Number.isSafeInteger(inner.plaintextByteCount) || inner.plaintextByteCount < 1) {
    throw new HttpError(400, "package.invalid_metadata", "encrypted package archive metadata is invalid");
  }
  const expectedChunks = Math.ceil(inner.plaintextByteCount / header.chunkByteCount);
  if (expectedChunks !== header.chunkCount) {
    throw new HttpError(400, "package.invalid_length", "encrypted package chunk count is invalid");
  }
}

function readFileRange(fd, offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, offset + read);
    if (count === 0) {
      throw new HttpError(400, "package.truncated", "encrypted package is truncated");
    }
    read += count;
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Workspace runtime — durable job records around disposable non-root containers.

function publicWorkspaceJobPolicy() {
  return {
    schema: WORKSPACE_JOB_POLICY_SCHEMA,
    defaultMaximumRuntimeSeconds: state.jobPolicy.defaultMaximumRuntimeSeconds,
    updatedAt: state.jobPolicy.updatedAt,
  };
}

async function handleWorkspaceJobPolicyUpdate(req, res, device) {
  const body = await readJSONBody(req, 64 * 1024);
  if (body?.schema !== WORKSPACE_JOB_POLICY_SCHEMA) {
    throw new HttpError(400, "job.policy_schema_unsupported", "unsupported workspace job policy schema");
  }
  const value = body.defaultMaximumRuntimeSeconds;
  const maximumRepresentableSeconds = Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 1000);
  if (value !== null &&
      (!Number.isSafeInteger(value) || value <= 0 || value > maximumRepresentableSeconds)) {
    throw new HttpError(400, "job.policy_runtime_invalid", "maximum runtime must be a positive integer or null");
  }
  state.jobPolicy = {
    schema: WORKSPACE_JOB_POLICY_SCHEMA,
    defaultMaximumRuntimeSeconds: value,
    updatedAt: Date.now(),
  };
  saveState();
  log(`workspace job policy updated by ${device.deviceId} maximum=${value ?? "unlimited"}`);
  sendJSON(res, 200, publicWorkspaceJobPolicy());
}

async function handleWorkspaceJobSubmit(req, res, device) {
  if (!config.containerRuntime) {
    throw new HttpError(503, "workspace.runtime_unavailable", "Docker or Podman is required");
  }
  const body = await readJSONBody(req, config.maxWorkspaceBytes);
  const run = validateWorkspaceRun(body);
  const inputHash = sha256Hex(Buffer.from(JSON.stringify(run)));
  const existing = state.jobs.find((job) => job.runId === run.runId);
  if (existing) {
    if (existing.inputHash !== inputHash) {
      throw new HttpError(409, "job.run_id_conflict", "runId already belongs to a different input snapshot");
    }
    return sendJSON(res, 200, publicWorkspaceJob(existing, true));
  }
  const job = createWorkspaceJob(run, device, null, inputHash);
  state.jobs.push(job);
  appendWorkspaceJobEvent(job, "queued", "Workspace job accepted");
  saveState();
  log(`workspace job queued ${job.jobId} run=${job.runId} device=${device.deviceId}`);
  sendJSON(res, 202, publicWorkspaceJob(job, true));
  setImmediate(() => executeWorkspaceJob(job.jobId));
}

function createWorkspaceJob(run, device, predecessorJobId, inputHash = null) {
  const now = Date.now();
  const maximumRuntimeSeconds = state.jobPolicy.defaultMaximumRuntimeSeconds;
  return {
    schema: WORKSPACE_JOB_SCHEMA,
    jobId: `job_${randomUUID()}`,
    runId: run.runId,
    projectId: run.projectId,
    runtime: run.runtime,
    state: "queued",
    predecessorJobId,
    queuedAt: now,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    failureCode: null,
    failureMessage: null,
    result: null,
    maximumRuntimeSeconds,
    budgetSource: maximumRuntimeSeconds === null ? "node_unlimited" : "node_default",
    deadlineAt: null,
    input: run,
    inputHash: inputHash ?? sha256Hex(Buffer.from(JSON.stringify(run))),
    createdByDeviceId: device.deviceId,
    cancelledByDeviceId: null,
    events: [],
  };
}

async function executeWorkspaceJob(jobId) {
  const job = workspaceJob(jobId);
  if (!job || job.state !== "queued") return;
  if (!config.containerRuntime) {
    failWorkspaceJob(job, "workspace.runtime_unavailable", "Docker or Podman is required");
    return;
  }
  transitionWorkspaceJob(job, "preparing", "Preparing isolated workspace");
  const workspaceDirectory = mkdtempSync(join(tmpdir(), "aru-workspace-"));
  chmodSync(workspaceDirectory, 0o777);
  const run = job.input;
  const temporaryEntry = run.code === null ? null : temporaryEntryName(run.runtime, run.runId);
  try {
    for (const file of run.files) {
      writeWorkspaceFile(workspaceDirectory, file.path, file.content);
    }
    if (temporaryEntry) {
      writeWorkspaceFile(workspaceDirectory, temporaryEntry, run.code, validateRuntimeEntryPath);
    }
    makeWorkspaceTreeWritable(workspaceDirectory);
    const entryPath = temporaryEntry ?? run.entryPath;
    const entryValidator = temporaryEntry ? validateRuntimeEntryPath : validateWorkspacePath;
    if (!entryPath || !existsSync(resolveWorkspacePath(workspaceDirectory, entryPath, entryValidator))) {
      throw new HttpError(400, "workspace.entry_missing", "entryPath does not name a workspace file");
    }

    if (job.state === "cancelled") return;
    job.startedAt ??= Date.now();
    if (job.maximumRuntimeSeconds !== null && job.maximumRuntimeSeconds !== undefined) {
      job.deadlineAt ??= job.startedAt + job.maximumRuntimeSeconds * 1000;
      if (job.deadlineAt <= Date.now()) {
        timeOutWorkspaceJob(job);
        return;
      }
    }
    transitionWorkspaceJob(job, "running", "Workspace container started");
    const execution = await runWorkspaceContainer({
      jobId: job.jobId,
      runtime: run.runtime,
      workspaceDirectory,
      entryPath,
      inputJSON: run.inputJSON,
      maximumRuntimeSeconds: remainingRuntimeSeconds(job),
    });
    if (job.state === "cancelled") return;
    let output;
    try {
      output = readWorkspaceOutputs(workspaceDirectory, temporaryEntry);
    } catch (error) {
      if (!execution.timedOut) throw error;
      output = { files: [], binaryFiles: [] };
    }
    const device = { deviceId: job.createdByDeviceId };
    const artifacts = persistWorkspaceArtifacts(output.binaryFiles, run, device, job.jobId);
    const completedAt = Date.now();
    job.exitCode = execution.exitCode;
    job.result = {
      schema: WORKSPACE_RESULT_SCHEMA,
      runId: run.runId,
      runtime: run.runtime,
      exitCode: execution.exitCode,
      standardOutput: execution.standardOutput,
      standardError: execution.standardError,
      files: output.files,
      artifacts,
      startedAt: job.startedAt,
      completedAt,
    };
    job.completedAt = completedAt;
    if (execution.timedOut) {
      job.failureCode = "workspace.execution_timed_out";
      job.failureMessage = job.maximumRuntimeSeconds === null
        ? "Workspace job reached its execution budget"
        : `Workspace job reached its ${job.maximumRuntimeSeconds} second execution budget`;
      transitionWorkspaceJob(job, "timed_out", job.failureMessage);
    } else if (execution.exitCode === 0) {
      transitionWorkspaceJob(job, "succeeded", "Workspace job completed");
    } else {
      job.failureCode = "workspace.process_failed";
      job.failureMessage = `Workspace process exited with code ${execution.exitCode}`;
      transitionWorkspaceJob(job, "failed", job.failureMessage);
    }
    log(`workspace job ${job.jobId} run=${run.runId} runtime=${run.runtime} exit=${execution.exitCode}`);
  } catch (error) {
    if (job.state !== "cancelled") {
      const code = error instanceof HttpError ? error.code : "workspace.execution_failed";
      const message = error instanceof HttpError ? error.message : "Workspace execution failed";
      failWorkspaceJob(job, code, message);
      log(`workspace job failed ${job.jobId} code=${code}`);
    }
  } finally {
    activeJobProcesses.delete(job.jobId);
    rmSync(workspaceDirectory, { recursive: true, force: true });
  }
}

function workspaceJob(jobId) {
  return state.jobs.find((job) => job.jobId === jobId) ?? null;
}

function publicWorkspaceJob(job, includeResult = false) {
  return {
    schema: WORKSPACE_JOB_SCHEMA,
    jobId: job.jobId,
    runId: job.runId,
    projectId: job.projectId,
    runtime: job.runtime,
    state: job.state,
    predecessorJobId: job.predecessorJobId,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    exitCode: job.exitCode,
    failureCode: job.failureCode,
    failureMessage: job.failureMessage,
    maximumRuntimeSeconds: job.maximumRuntimeSeconds ?? null,
    budgetSource: job.budgetSource ?? null,
    deadlineAt: job.deadlineAt ?? null,
    result: includeResult ? job.result : null,
  };
}

function workspaceJobInventory() {
  return {
    schema: WORKSPACE_JOB_INVENTORY_SCHEMA,
    jobs: state.jobs
      .slice()
      .sort((a, b) => b.queuedAt - a.queuedAt || a.jobId.localeCompare(b.jobId))
      .map((job) => publicWorkspaceJob(job, false)),
  };
}

function matchWorkspaceJobRoute(path) {
  const match = /^\/aru\/v1\/jobs\/([^/]+)(?:\/(events|cancel|retry))?$/.exec(path);
  if (!match) return null;
  return { jobId: decodeURIComponent(match[1]), action: match[2] ?? null };
}

function handleWorkspaceJobStatus(res, jobId) {
  const job = workspaceJob(jobId);
  if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
  sendJSON(res, 200, publicWorkspaceJob(job, true));
}

function handleWorkspaceJobEvents(res, jobId) {
  const job = workspaceJob(jobId);
  if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
  sendJSON(res, 200, {
    schema: WORKSPACE_JOB_EVENTS_SCHEMA,
    jobId: job.jobId,
    events: job.events,
  });
}

function handleWorkspaceJobCancel(res, jobId, device) {
  sendJSON(res, 200, cancelWorkspaceJob(jobId, device));
}

function cancelWorkspaceJob(jobId, device) {
  const job = workspaceJob(jobId);
  if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
  if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.state)) {
    return publicWorkspaceJob(job, true);
  }
  job.cancelledByDeviceId = device.deviceId;
  job.completedAt = Date.now();
  transitionWorkspaceJob(job, "cancelled", "Workspace job cancelled explicitly");
  stopActiveJobProcess(job.jobId);
  log(`workspace job cancelled ${job.jobId} device=${device.deviceId}`);
  return publicWorkspaceJob(job, true);
}

function handleWorkspaceJobRetry(res, jobId, device) {
  const next = retryWorkspaceJob(jobId, device);
  sendJSON(res, 202, next);
}

function retryWorkspaceJob(jobId, device) {
  const previous = workspaceJob(jobId);
  if (!previous) throw new HttpError(404, "job.unknown", "unknown workspace job");
  if (!["failed", "cancelled", "timed_out"].includes(previous.state)) {
    throw new HttpError(409, "job.retry_not_allowed", "only failed, cancelled, or timed-out jobs can be retried");
  }
  const run = {
    ...previous.input,
    runId: `retry_${randomUUID()}`,
  };
  const next = createWorkspaceJob(run, device, previous.jobId);
  state.jobs.push(next);
  appendWorkspaceJobEvent(next, "queued", `Retry of ${previous.jobId}`);
  saveState();
  log(`workspace job retry ${previous.jobId} -> ${next.jobId}`);
  setImmediate(() => executeWorkspaceJob(next.jobId));
  return publicWorkspaceJob(next, true);
}

function transitionWorkspaceJob(job, nextState, message) {
  job.state = nextState;
  appendWorkspaceJobEvent(job, nextState, message);
  saveState();
}

function appendWorkspaceJobEvent(job, kind, message) {
  job.events.push({
    sequence: job.events.length + 1,
    kind,
    at: Date.now(),
    message,
  });
}

function failWorkspaceJob(job, code, message) {
  job.failureCode = code;
  job.failureMessage = message;
  job.completedAt = Date.now();
  transitionWorkspaceJob(job, "failed", message);
}

function timeOutWorkspaceJob(job) {
  job.failureCode = "workspace.execution_timed_out";
  job.failureMessage = job.maximumRuntimeSeconds === null
    ? "Workspace job reached its execution budget"
    : `Workspace job reached its ${job.maximumRuntimeSeconds} second execution budget`;
  job.completedAt = Date.now();
  transitionWorkspaceJob(job, "timed_out", job.failureMessage);
}

function remainingRuntimeSeconds(job) {
  if (job.maximumRuntimeSeconds === null || job.maximumRuntimeSeconds === undefined) return null;
  const deadlineAt = job.deadlineAt ?? (job.startedAt + job.maximumRuntimeSeconds * 1000);
  return Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
}

function validateWorkspaceRun(body) {
  if (body?.schema !== WORKSPACE_RUN_SCHEMA) {
    throw new HttpError(400, "workspace.schema_unsupported", "unsupported workspace run schema");
  }
  const runId = String(body.runId ?? "").trim();
  const projectId = String(body.projectId ?? "").trim();
  const runtime = String(body.runtime ?? "").trim();
  if (!runId || !projectId) {
    throw new HttpError(400, "workspace.identity_missing", "runId and projectId are required");
  }
  if (!WORKSPACE_RUNTIMES.includes(runtime)) {
    throw new HttpError(400, "workspace.runtime_unsupported", "unsupported runtime");
  }
  const files = Array.isArray(body.files) ? body.files : [];
  const paths = new Set();
  const normalizedFiles = files.map((file) => {
    const path = validateWorkspacePath(file?.path);
    if (paths.has(path)) {
      throw new HttpError(400, "workspace.path_duplicate", `duplicate workspace path: ${path}`);
    }
    paths.add(path);
    if (typeof file?.content !== "string") {
      throw new HttpError(400, "workspace.content_invalid", `workspace file must be text: ${path}`);
    }
    return {
      path,
      content: file.content,
      language: String(file.language ?? ""),
    };
  });
  const code = body.code === null || body.code === undefined ? null : String(body.code);
  const entryPath = body.entryPath === null || body.entryPath === undefined
    ? null
    : validateWorkspacePath(body.entryPath);
  if (code === null && entryPath === null) {
    throw new HttpError(400, "workspace.entry_missing", "entryPath or code is required");
  }
  let inputJSON = String(body.inputJSON ?? "{}");
  try {
    JSON.parse(inputJSON);
  } catch {
    throw new HttpError(400, "workspace.input_invalid", "inputJSON is not valid JSON");
  }
  return { runId, projectId, runtime, entryPath, code, inputJSON, files: normalizedFiles };
}

function validateWorkspacePath(value) {
  return normalizeWorkspacePath(value, false);
}

function validateRuntimeEntryPath(value) {
  const path = normalizeWorkspacePath(value, true);
  if (!/^\.aru-runtime-[A-Za-z0-9_-]{1,48}\.(mjs|py|sh)$/.test(path)) {
    throw new HttpError(400, "workspace.path_invalid", "runtime entry path is invalid");
  }
  return path;
}

function normalizeWorkspacePath(value, allowRuntimeEntry) {
  const path = String(value ?? "").replaceAll("\\", "/").trim();
  const segments = path.split("/");
  if (!path || isAbsolute(path) || path.includes("\0") ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      (!allowRuntimeEntry && path.startsWith(".aru-runtime-"))) {
    throw new HttpError(400, "workspace.path_invalid", "workspace paths must be safe relative paths");
  }
  return segments.join("/");
}

function resolveWorkspacePath(root, path, validator = validateWorkspacePath) {
  const target = resolve(root, validator(path));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new HttpError(400, "workspace.path_invalid", "workspace path escaped the run root");
  }
  return target;
}

function writeWorkspaceFile(root, path, content, validator = validateWorkspacePath) {
  const target = resolveWorkspacePath(root, path, validator);
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o777 });
  writeFileSync(target, content, { encoding: "utf8", mode: 0o666 });
  chmodSync(target, 0o666);
}

function makeWorkspaceTreeWritable(directory) {
  chmodSync(directory, 0o777);
  for (const name of readdirSync(directory)) {
    const absolute = join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      makeWorkspaceTreeWritable(absolute);
    } else if (stat.isFile()) {
      chmodSync(absolute, 0o666);
    }
  }
}

function temporaryEntryName(runtime, runId) {
  const safeID = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || randomBytes(8).toString("hex");
  const extension = runtime === "node" ? "mjs" : runtime === "python" ? "py" : "sh";
  return `.aru-runtime-${safeID}.${extension}`;
}

async function runWorkspaceContainer({
  jobId, runtime, workspaceDirectory, entryPath, inputJSON, maximumRuntimeSeconds,
}) {
  const image = config.runtimeImages[runtime];
  const containerName = workspaceJobContainerName(jobId);
  const command = runtime === "node"
    ? ["node", `/workspace/${entryPath}`]
    : runtime === "python"
      ? ["python3", `/workspace/${entryPath}`]
      : ["sh", `/workspace/${entryPath}`];
  const args = [
    "run", "--rm", "--init",
    "--name", containerName,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", config.containerMemory,
    "--cpus", config.containerCPUs,
    "--user", "65532:65532",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${workspaceDirectory},dst=/workspace,rw`,
    "--workdir", "/workspace",
    "--env", `ARU_WORKSPACE_INPUT=${inputJSON}`,
    image,
    ...command,
  ];
  return runProcess(config.containerRuntime, args, config.maxWorkspaceOutputBytes, {
    jobId,
    containerName,
    maximumRuntimeSeconds,
  });
}

function runProcess(command, args, maxOutputBytes, jobControl = null) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (jobControl !== null) {
      activeJobProcesses.set(jobControl.jobId, {
        child,
        containerRuntime: command,
        containerName: jobControl.containerName,
      });
    }
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const timeout = jobControl?.maximumRuntimeSeconds === null ||
      jobControl?.maximumRuntimeSeconds === undefined
      ? null
      : scheduleExecutionDeadline(jobControl.maximumRuntimeSeconds, () => {
          timedOut = true;
          stopActiveJobProcess(jobControl.jobId);
        });
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        terminateChildProcess(child, "SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => {
      timeout?.cancel();
      if (jobControl !== null) activeJobProcesses.delete(jobControl.jobId);
      reject(new HttpError(503, "workspace.runtime_unavailable", "container runtime failed"));
    });
    child.on("close", (code) => {
      timeout?.cancel();
      if (jobControl !== null) activeJobProcesses.delete(jobControl.jobId);
      const standardError = Buffer.concat(stderr).toString("utf8");
      resolvePromise({
        exitCode: timedOut ? 124 : outputExceeded ? 137 : Number(code ?? 1),
        timedOut,
        standardOutput: Buffer.concat(stdout).toString("utf8"),
        standardError: outputExceeded
          ? `${standardError}\nAru stopped the run because process output exceeded the configured server safety boundary.`.trim()
          : standardError,
      });
    });
  });
}

function scheduleExecutionDeadline(maximumRuntimeSeconds, expire) {
  const deadlineAt = Date.now() + maximumRuntimeSeconds * 1000;
  let timer = null;
  let cancelled = false;
  const scheduleNext = () => {
    if (cancelled) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(scheduleNext, Math.min(remaining, 60_000));
  };
  scheduleNext();
  return {
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

function workspaceJobContainerName(jobId) {
  return `aru-${String(jobId).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 48)}`;
}

function stopActiveJobProcess(jobId) {
  const active = activeJobProcesses.get(jobId);
  if (!active) return;
  spawnSync(active.containerRuntime, [
    "stop", "--time", String(CONTAINER_STOP_GRACE_SECONDS), active.containerName,
  ], { stdio: "ignore" });
  terminateChildProcess(active.child, "SIGTERM");
  setTimeout(() => terminateChildProcess(active.child, "SIGKILL"),
             CONTAINER_STOP_GRACE_SECONDS * 1000);
}

function terminateChildProcess(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

function removeStaleJobContainer(jobId) {
  if (!config.containerRuntime) return;
  spawnSync(config.containerRuntime, ["rm", "-f", workspaceJobContainerName(jobId)], {
    stdio: "ignore",
  });
}

function readWorkspaceOutputs(root, excludedPath) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files = [];
  const binaryFiles = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new HttpError(422, "workspace.symlink_rejected", "workspace result cannot contain symbolic links");
      }
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) continue;
      const path = relative(root, absolute).split(sep).join("/");
      if (path === excludedPath) continue;
      const data = readFileSync(absolute);
      if (artifactExtension(path) !== null) {
        binaryFiles.push({ path, data });
        continue;
      }
      let content;
      try {
        content = decoder.decode(data);
      } catch {
        binaryFiles.push({ path, data });
        continue;
      }
      files.push({ path, content, language: languageForWorkspacePath(path) });
    }
  };
  walk(root);
  return { files, binaryFiles };
}

function persistWorkspaceArtifacts(binaryFiles, run, device, jobId = null) {
  if (binaryFiles.length === 0) return [];
  const createdAt = Date.now();
  const metadata = binaryFiles.map(({ path, data }) => {
    const sha256 = sha256Hex(data);
    const artifactId = `artifact_${randomUUID()}`;
    const blobPath = join(config.dataDir, "artifacts", sha256);
    if (!existsSync(blobPath)) writeFileSync(blobPath, data, { mode: 0o600 });
    const entry = {
      schema: ARTIFACT_METADATA_SCHEMA,
      artifactId,
      filename: path,
      mimeType: mimeTypeForArtifactPath(path),
      byteCount: data.length,
      sha256,
      createdAt,
      producer: {
        kind: "workspace-run",
        runId: run.runId,
        projectId: run.projectId,
        runtime: run.runtime,
        jobId,
      },
      downloadPath: `/aru/v1/artifacts/${encodeURIComponent(artifactId)}`,
      deletedAt: null,
      createdByDeviceId: device.deviceId,
    };
    state.artifacts.push(entry);
    return publicArtifactMetadata(entry);
  });
  saveState();
  return metadata;
}

function artifactInventory() {
  return {
    artifacts: state.artifacts
      .filter((entry) => entry.deletedAt === null)
      .sort((a, b) => b.createdAt - a.createdAt || a.artifactId.localeCompare(b.artifactId))
      .map(publicArtifactMetadata),
  };
}

function publicArtifactMetadata(entry) {
  const { createdByDeviceId: _, deletedAt: __, ...metadata } = entry;
  return metadata;
}

function handleArtifactDownload(req, res, artifactId) {
  const entry = state.artifacts.find((candidate) => candidate.artifactId === artifactId);
  if (!entry || entry.deletedAt !== null) {
    throw new HttpError(404, "artifact.unknown", "unknown artifact");
  }
  const file = join(config.dataDir, "artifacts", entry.sha256);
  if (!existsSync(file)) {
    throw new HttpError(410, "artifact.bytes_missing", "artifact metadata exists but bytes are missing");
  }
  const data = readFileSync(file);
  if (data.length !== entry.byteCount || sha256Hex(data) !== entry.sha256) {
    throw new HttpError(500, "artifact.integrity_failed", "stored artifact failed integrity verification");
  }
  res.writeHead(200, {
    "content-type": entry.mimeType,
    "content-length": data.length,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
    "x-aru-artifact-sha256": entry.sha256,
    "x-aru-artifact-id": entry.artifactId,
  });
  res.end(data);
}

function handleArtifactDelete(req, res, artifactId, device) {
  sendJSON(res, 200, deleteArtifact(artifactId, device));
}

function deleteArtifact(artifactId, device) {
  const entry = state.artifacts.find((candidate) => candidate.artifactId === artifactId);
  if (!entry || entry.deletedAt !== null) {
    throw new HttpError(404, "artifact.unknown", "unknown artifact");
  }
  entry.deletedAt = Date.now();
  const stillReferenced = state.artifacts.some((candidate) =>
    candidate.artifactId !== artifactId && candidate.deletedAt === null && candidate.sha256 === entry.sha256);
  if (!stillReferenced) {
    rmSync(join(config.dataDir, "artifacts", entry.sha256), { force: true });
  }
  saveState();
  log(`deleted artifact ${artifactId} for ${device.deviceId}`);
  return { artifactId, deleted: true, deletedAt: entry.deletedAt };
}

function mimeTypeForArtifactPath(path) {
  return ({
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
    ".zip": "application/zip", ".json": "application/json", ".csv": "text/csv",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
    ".mp4": "video/mp4", ".mov": "video/quicktime",
    ".sqlite": "application/vnd.sqlite3", ".db": "application/octet-stream",
    ".wasm": "application/wasm", ".bin": "application/octet-stream",
  })[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function artifactExtension(path) {
  const extension = extname(path).toLowerCase();
  return ARTIFACT_EXTENSIONS.has(extension) ? extension : null;
}

function languageForWorkspacePath(path) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return ({
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", py: "python",
    sh: "shell", bash: "shell", json: "json", md: "markdown",
    html: "html", htm: "html", css: "css",
  })[extension] ?? "text";
}

// ---------------------------------------------------------------------------
// Diagnostics — layered, machine-readable, never leaks secrets.

function handleDiagnostics(req, res) {
  let authStatus = "missing";
  try {
    requireDevice(req);
    authStatus = "ok";
  } catch (error) {
    if (error instanceof HttpError) {
      authStatus = error.code;
    }
  }
  sendJSON(res, 200, {
    schema: "aru.selfhost.diagnostics.v1",
    serverId: state.serverId,
    displayName: nodeControl.displayName(),
    serverVersion: SERVER_VERSION,
    serverTime: Date.now(),
    manifest: "ok",
    auth: authStatus,
    capabilities: [
      { id: "node-settings", enabled: true },
      { id: "backup-vault", enabled: true },
      { id: "workspace-runtime", enabled: config.containerRuntime !== null },
      { id: "job-runtime", enabled: config.containerRuntime !== null },
      { id: "mcp-gateway", enabled: true },
      { id: "artifact-vault", enabled: true },
      { id: "plugin-supervisor", enabled: config.containerRuntime !== null },
      { id: "collaborator-host", enabled: true },
      nodeWorkspaceHost.diagnosticsCapability(),
      conversationTurnRelay.diagnosticsCapability(),
      { id: "sync-ledger", enabled: false },
    ],
    packageCount: state.packages.length,
    artifactCount: state.artifacts.filter((entry) => entry.deletedAt === null).length,
    jobCount: state.jobs.length,
    activeJobCount: state.jobs.filter((job) => ["queued", "preparing", "running"].includes(job.state)).length,
    pluginCount: state.plugins.length,
    activePluginCount: state.plugins.filter((plugin) => plugin.desiredState === "enabled").length,
    hostedCollaboratorCount: state.hostedCollaborators.length,
    nodeWorkspaceCount: nodeWorkspaceHost.count(),
    readyAgentDriverCount: collaboratorHost.driverInventory().drivers.filter((driver) => driver.status === "ready").length,
    deviceCount: state.devices.filter((d) => !d.revokedAt).length,
  });
}

// ---------------------------------------------------------------------------
// State + helpers

function loadState() {
  if (existsSync(statePath)) {
    try {
      const loaded = JSON.parse(readFileSync(statePath, "utf8"));
      loaded.devices ??= [];
      loaded.packages ??= [];
      loaded.artifacts ??= [];
      loaded.jobs ??= [];
      loaded.plugins ??= [];
      loaded.pluginDrafts ??= [];
      for (const plugin of loaded.plugins) {
        plugin.events ??= [];
        plugin.lastErrorMessage ??= null;
      }
      loaded.agentDriverProbes ??= [];
      loaded.hostedCollaborators ??= [];
      loaded.nodeWorkspaces ??= [];
      loaded.conversationTurns ??= [];
      loaded.jobPolicy ??= {
        schema: WORKSPACE_JOB_POLICY_SCHEMA,
        defaultMaximumRuntimeSeconds: OFFICIAL_DEFAULT_MAXIMUM_RUNTIME_SECONDS,
        updatedAt: Date.now(),
      };
      return loaded;
    } catch {
      log("state.json unreadable; starting fresh");
    }
  }
  return {
    serverId: `stub-${randomBytes(6).toString("hex")}`,
    devices: [],
    packages: [],
    artifacts: [],
    jobs: [],
    plugins: [],
    pluginDrafts: [],
    agentDriverProbes: [],
    hostedCollaborators: [],
    nodeWorkspaces: [],
    conversationTurns: [],
    nodeSettings: null,
    jobPolicy: {
      schema: WORKSPACE_JOB_POLICY_SCHEMA,
      defaultMaximumRuntimeSeconds: OFFICIAL_DEFAULT_MAXIMUM_RUNTIME_SECONDS,
      updatedAt: Date.now(),
    },
  };
}

function saveState() {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporaryPath, statePath);
}

function recoverInterruptedJobs() {
  const interrupted = state.jobs.filter((job) =>
    ["queued", "preparing", "running"].includes(job.state));
  const recoveredJobIds = [];
  for (const job of interrupted) {
    job.events ??= [];
    removeStaleJobContainer(job.jobId);
    if (job.maximumRuntimeSeconds !== null && job.maximumRuntimeSeconds !== undefined &&
        job.startedAt !== null && job.startedAt !== undefined) {
      job.deadlineAt ??= job.startedAt + job.maximumRuntimeSeconds * 1000;
      if (job.deadlineAt <= Date.now()) {
        job.failureCode = "workspace.execution_timed_out";
        job.failureMessage = `Workspace job reached its ${job.maximumRuntimeSeconds} second execution budget`;
        job.completedAt = Date.now();
        job.state = "timed_out";
        appendWorkspaceJobEvent(job, "timed_out", job.failureMessage);
        continue;
      }
    }
    job.state = "queued";
    job.completedAt = null;
    job.exitCode = null;
    job.failureCode = null;
    job.failureMessage = null;
    job.result = null;
    appendWorkspaceJobEvent(job, "recovered", "Capability host resumed the durable workspace job");
    recoveredJobIds.push(job.jobId);
  }
  if (interrupted.length > 0) {
    saveState();
    log(`recovered ${recoveredJobIds.length} interrupted workspace job(s) for execution`);
  }
  return recoveredJobIds;
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = "true";
    }
  }
  return result;
}

function detectContainerRuntime() {
  for (const candidate of ["docker", "podman"]) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (result.status === 0) return candidate;
  }
  return null;
}

function expandHome(value) {
  return value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sendJSON(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendEmpty(res, status, extraHeaders = {}) {
  res.writeHead(status, { "content-length": "0", ...extraHeaders });
  res.end();
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new HttpError(413, "package.too_large", "body exceeds limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJSONBody(req, limit) {
  const raw = await readRawBody(req, limit);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "body.invalid_json", "body is not JSON");
  }
}
