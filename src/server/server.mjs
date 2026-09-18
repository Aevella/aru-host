import { createMCPGateway } from "./mcp-gateway.mjs";
import { createWorkspaceJobs } from "./workspace-jobs.mjs";
import { createArtifactVault } from "./artifact-vault.mjs";
import { createBackupVault } from "./backup-vault.mjs";
import { createMCPCatalog } from "./mcp-catalog.mjs";
import { createHostStateStore } from "./state-store.mjs";
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
  fsyncSync,
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
import { createPluginSupervisor } from "../../plugin-supervisor.mjs";
import { createSourcePluginRuntime } from "../../source-plugin-runtime.mjs";
import { createCollaboratorHost } from "../../collaborator-host.mjs";
import { createNodeWorkspaceHost } from "../../node-workspaces.mjs";
import { createNodeControl } from "../../node-control.mjs";
import { createBackupSettings } from "../../backup-settings.mjs";
import {
  createConversationTurnRelay,
  SUPPORTED_CONVERSATION_TURN_PROTOCOLS,
} from "../../conversation-turn-relay.mjs";
import { createAPNsCredentialStore, createAPNsPushHost } from "../../apns-push.mjs";
import { createWakeBridge } from "../../wake-bridge.mjs";

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
  wakeRelayBaseURL: (args["wake-relay-url"] ?? "https://wake.aelion.cn").replace(/\/+$/, ""),
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
const SERVER_VERSION = "stub-0.30";
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

const { MCP_TOOLS, mcpOperationTool, mcpIdentifierSchema } = createMCPCatalog({  });

const statePath = join(config.dataDir, "state.json");
const stateStore = createHostStateStore({ statePath, WORKSPACE_JOB_POLICY_SCHEMA, OFFICIAL_DEFAULT_MAXIMUM_RUNTIME_SECONDS });
function saveState() { stateStore.save(state); }
let state;
try { state = stateStore.load(); }
catch (error) {
  if (!error.message.startsWith("host.state_unreadable:")) throw error;
  console.error(error.message);
  // launchd only distinguishes successful/failed exits in KeepAlive; its
  // launcher opts into a clean stop for this permanent startup failure.
  process.exit(args["launchd-supervised"] ? 0 : 78);
}
// Read-only admission used by installers and Consoles before any service or
// release switch. It must not create files, rotate identity or run recovery.
if (args["check-state"]) process.exit(0);
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, "packages"), { recursive: true });
mkdirSync(join(config.dataDir, "artifacts"), { recursive: true });
normalizeLegacyHostConsoleDevices();
const { persistWorkspaceArtifacts, persistDirectArtifact, artifactInventory, handleArtifactDownload, handleArtifactDelete, deleteArtifact, artifactExtension, languageForWorkspacePath } = createArtifactVault({ config, state: { get artifacts() { return state.artifacts; }, set artifacts(value) { state.artifacts = value; } }, saveState, sendJSON, HttpError, log, sha256Hex, ARTIFACT_EXTENSIONS, ARTIFACT_METADATA_SCHEMA });
const { publicWorkspaceJobPolicy, handleWorkspaceJobPolicyUpdate, handleWorkspaceJobSubmit, executeWorkspaceJob, workspaceJob, publicWorkspaceJob, workspaceJobInventory, matchWorkspaceJobRoute, handleWorkspaceJobStatus, handleWorkspaceJobEvents, handleWorkspaceJobCancel, cancelWorkspaceJob, handleWorkspaceJobRetry, retryWorkspaceJob, recoverInterruptedJobs } = createWorkspaceJobs({ config, state: { get jobs() { return state.jobs; }, set jobs(value) { state.jobs = value; }, get jobPolicy() { return state.jobPolicy; }, set jobPolicy(value) { state.jobPolicy = value; } }, saveState, sendJSON, readJSONBody, HttpError, log, sha256Hex, persistWorkspaceArtifacts, artifactExtension, CONTAINER_STOP_GRACE_SECONDS, WORKSPACE_JOB_EVENTS_SCHEMA, WORKSPACE_JOB_INVENTORY_SCHEMA, WORKSPACE_JOB_POLICY_SCHEMA, WORKSPACE_JOB_SCHEMA, WORKSPACE_RESULT_SCHEMA, WORKSPACE_RUNTIMES, WORKSPACE_RUN_SCHEMA });
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
const apnsCredentialStore = createAPNsCredentialStore();
const remotePush = createAPNsPushHost({
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  serverId: state.serverId,
  credentialStore: apnsCredentialStore,
  relayBaseURL: config.wakeRelayBaseURL,
  log,
});
const wakeBridge = createWakeBridge({
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  relayBaseURL: config.wakeRelayBaseURL,
  log,
});
const { handleUpload, inventory, handleDownload, handleDelete, deleteBackupPackage } = createBackupVault({
  config, state: { get packages() { return state.packages; }, set packages(value) { state.packages = value; } }, saveState, sendJSON, HttpError, log,
  applyRetention: actor => backupSettings.applyRetention(actor),
  ENCRYPTED_PACKAGE_CONTENT_TYPE, ENCRYPTED_PACKAGE_MAGIC, ENCRYPTED_PACKAGE_VERSION, ENVELOPE_FORMAT, MAX_ENCRYPTED_PACKAGE_CHUNK_BYTES, MAX_ENCRYPTED_PACKAGE_HEADER_BYTES, VAULT_METADATA_SCHEMA
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
  onTurnUpdated: (turn) => remotePush.deliverConversationTurnRelayUpdate(turn),
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
const { handleMCP, executeMCPTool } = createMCPGateway({
  config,
  state,
  nodeControl,
  backupSettings,
  HttpError,
  readJSONBody,
  sendJSON,
  sendEmpty,
  officialMCPTools,
  workspaceJobInventory,
  workspaceJob,
  publicWorkspaceJob,
  cancelWorkspaceJob,
  retryWorkspaceJob,
  artifactInventory,
  deleteArtifact,
  MCP_PROTOCOL_VERSION,
  SERVER_VERSION,
  WORKSPACE_JOB_EVENTS_SCHEMA,
  getPluginSupervisor: () => pluginSupervisor,
  getCollaboratorHost: () => collaboratorHost,
  getNodeWorkspaceHost: () => nodeWorkspaceHost
});
const collaboratorHost = createCollaboratorHost({
  dataDir: config.dataDir,
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  managedWorkspaceRoot: config.managedWorkspaceRoot,
  maximumReplicaBytes: config.maxWorkspaceBytes,
  toolCatalog: () => [...officialMCPTools(), ...pluginSupervisor.dynamicMCPTools()],
  executeTool: executeMCPTool,
  createArtifact: persistDirectArtifact,
  onTurnSettled: remotePush.deliverHostedCollaboratorTurn,
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
  collaboratorHost.start();
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
server.on("close", () => collaboratorHost.stop());

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
  if (await remotePush.route(req, res, path, () => requireDevice(req))) return;
  if (await wakeBridge.route(req, res, path)) return;
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
        protocols: [...SUPPORTED_CONVERSATION_TURN_PROTOCOLS],
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
      "mobile-collaborator-identity": {
        enabled: true,
        endpoint: "/aru/v1/mobile-collaborator-identities/{sourceCollaboratorId}",
        authority: "phone",
        turnExecution: false,
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
        messageInputKinds: ["text", "image", "file", "audio", "video"],
        attachmentProtocol: "aru.selfhost.collaborator-conversation-attachment.v1",
        maximumAttachmentBytes: 50 * 1024 * 1024,
        maximumAttachmentsPerMessage: 8,
        cognitionEndpoint: "/aru/v1/hosted-collaborators/{collaboratorId}/cognition",
        initiativeEndpoint: "/aru/v1/hosted-collaborators/{collaboratorId}/initiative",
        mobileReplicaEndpoint: "/aru/v1/mobile-collaborator-replicas/{sourceCollaboratorId}",
        mobileReplicaAuthority: "phone-authoritative-read-only-replica",
        mobileReplicaConflictPolicy: "append-at-base-or-branch",
        projectEndpoint: "/aru/v1/hosted-collaborators/{collaboratorId}/projects",
        providerProfileEndpoint: "/aru/v1/provider-profiles",
        surfaceExecution: true,
        surfaceEndpoint: "/aru/v1/hosted-collaborators/{collaboratorId}/surfaces",
      },
      "remote-notifications": {
        ...remotePush.manifestCapability(),
      },
      "external-wake-bridge": {
        enabled: true,
        endpoint: "/aru/v1/wake-bridge/endpoints/current",
        registration: "aru.wake-bridge.registration.v2",
        wakeRelay: config.wakeRelayBaseURL,
        wakeAuthority: "official-opaque-route-v1",
        contentRetention: "host-ciphertext-only",
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

function officialMCPTools() {
  return [
    ...MCP_TOOLS,
    ...nodeWorkspaceHost.tools(),
    ...collaboratorHost.surfaceTools(),
    ...collaboratorHost.projectTools(),
  ];
}

// ---------------------------------------------------------------------------
// Workspace runtime — durable job records around disposable non-root containers.

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
