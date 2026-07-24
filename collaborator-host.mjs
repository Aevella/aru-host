import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createCollaboratorCognitionHost } from "./collaborator-cognition.mjs";
import { createCollaboratorSurfaceHost } from "./collaborator-surfaces.mjs";
import { createCodexAppServerDriver } from "./codex-app-server-driver.mjs";
import { createCollaboratorConversationHost } from "./collaborator-conversations.mjs";
import { createCollaboratorInitiativeHost } from "./collaborator-initiative.mjs";
import { createCollaboratorProjectHost } from "./collaborator-projects.mjs";
import { createDirectAPIDriver } from "./direct-api-driver.mjs";
import { createProviderProfileHost } from "./provider-profiles.mjs";
import { createProviderSecretStore } from "./provider-secret-store.mjs";

const DRIVER_INVENTORY_SCHEMA = "aru.selfhost.agent-driver-inventory.v1";
const HOSTED_COLLABORATOR_INVENTORY_SCHEMA = "aru.selfhost.hosted-collaborator-inventory.v1";
const HOSTED_COLLABORATOR_SCHEMA = "aru.selfhost.hosted-collaborator.v1";
const COLLABORATOR_TOOL_ACCESS_SCHEMA = "aru.selfhost.collaborator-tool-access.v1";

const LOCAL_DRIVER_DEFINITIONS = [
  {
    id: "codex",
    displayName: "Codex",
    command: "codex",
    executableCandidates: [
      "codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      `${homedir()}/Applications/Codex.app/Contents/Resources/codex`,
      `${homedir()}/.local/bin/codex`,
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ],
    adapter: "codex-app-server",
    transport: "loopback-websocket",
    integrationGuide: "https://github.com/openai/codex/tree/main/codex-rs/app-server",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    command: "claude",
    executableCandidates: [
      "claude",
      `${homedir()}/.local/bin/claude`,
      `${homedir()}/.claude/local/claude`,
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
    adapter: "claude-agent-sdk",
    transport: "stream-json",
    integrationGuide: "https://docs.anthropic.com/en/docs/claude-code/sdk",
  },
];
const API_DRIVER_DEFINITION = {
  id: "api",
  displayName: "模型 API",
  command: null,
  adapter: "direct-provider-api",
  transport: "https",
  integrationGuide: null,
};
const DRIVER_DEFINITIONS = [...LOCAL_DRIVER_DEFINITIONS, API_DRIVER_DEFINITION];

export function createCollaboratorHost({
  dataDir,
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  managedWorkspaceRoot,
  toolCatalog = () => [],
  executeTool = async () => {
    throw new Error("Aru tool execution is unavailable");
  },
  createArtifact = () => {
    throw new Error("Aru artifact publication is unavailable");
  },
  providerSecretStore = createProviderSecretStore(),
  conversationHostFactory = createCollaboratorConversationHost,
  onTurnSettled = async () => {},
  log = () => {},
  now = Date.now,
}) {
  state.agentDriverProbes ??= [];
  state.hostedCollaborators ??= [];
  let codexExecutable = resolveDriverExecutable(LOCAL_DRIVER_DEFINITIONS[0]);
  const surfaces = createCollaboratorSurfaceHost({
    dataDir,
    readJSONBody,
    sendJSON,
    HttpError,
    now,
  });
  const projects = createCollaboratorProjectHost({
    dataDir,
    surfaces,
    createArtifact,
    readJSONBody,
    sendJSON,
    HttpError,
    now,
  });
  const cognition = createCollaboratorCognitionHost({
    dataDir,
    readJSONBody,
    sendJSON,
    HttpError,
    now,
  });
  const codexDriver = createCodexAppServerDriver({
    resolveExecutable: () => codexExecutable,
    log,
  });
  let providerProfiles;
  const directAPIDriver = createDirectAPIDriver({
    profileForId: (profileId) => providerProfiles.profileForId(profileId),
    readSecret: (profileId) => providerSecretStore.read(profileId),
    log,
  });
  providerProfiles = createProviderProfileHost({
    state,
    saveState,
    readJSONBody,
    sendJSON,
    HttpError,
    secretStore: providerSecretStore,
    testProfile: directAPIDriver.testProfile,
    isProfileInUse: (profileId) => state.hostedCollaborators.some(
      (collaborator) => collaborator.providerProfileId === profileId && !collaborator.archivedAt,
    ),
    now,
  });
  let initiative;
  const conversations = conversationHostFactory({
    dataDir,
    driverForCollaborator,
    collaboratorForId,
    readJSONBody,
    sendJSON,
    HttpError,
    toolCatalog: conversationToolCatalog,
    executeTool: executeConversationTool,
    requestInstructions: cognition.requestInstructions,
    configurationRevision: (collaborator) => cognition.summary(collaborator.collaboratorId).revision,
    onTurnSettled: async (event) => {
      const collaborator = collaboratorForId(event.conversation.collaboratorId);
      const enriched = { ...event, collaborator };
      initiative?.settle(enriched);
      await onTurnSettled(enriched);
    },
    now,
  });
  initiative = createCollaboratorInitiativeHost({
    dataDir,
    readJSONBody,
    sendJSON,
    HttpError,
    collaboratorForId,
    collaboratorIds: () => state.hostedCollaborators
      .filter((collaborator) => !collaborator.archivedAt)
      .map((collaborator) => collaborator.collaboratorId),
    trigger: (collaborator, rule) => conversations.runProactive(collaborator, rule),
    now,
    log,
  });

  function conversationToolCatalog() {
    return [
      ...toolCatalog().filter((tool) =>
        !tool.name.startsWith("aru_collaborator_surface_")
        && !tool.name.startsWith("aru_collaborator_project_")),
      ...surfaces.selfTools(),
      ...projects.selfTools(),
      ...cognition.selfTools(),
      ...initiative.selfTools(),
    ];
  }

  async function executeConversationTool(name, args, device, collaborator) {
    const surfaceCall = surfaces.callSelfTool(name, args, device, collaborator);
    if (surfaceCall.matched) return surfaceCall.value;
    const projectCall = projects.callSelfTool(name, args, device, collaborator);
    if (projectCall.matched) return projectCall.value;
    const cognitionCall = cognition.callSelfTool(name, args, device, collaborator);
    if (cognitionCall.matched) return cognitionCall.value;
    const initiativeCall = initiative.callSelfTool(name, args, device, collaborator);
    if (initiativeCall.matched) return initiativeCall.value;
    return executeTool(name, args, device);
  }

  function refreshDrivers() {
    state.agentDriverProbes = LOCAL_DRIVER_DEFINITIONS.map((definition) => probeDriver(definition, now()));
    codexExecutable = resolveDriverExecutable(LOCAL_DRIVER_DEFINITIONS[0]);
    saveState();
    return driverInventory();
  }

  function driverInventory() {
    const providerInventory = providerProfiles.inventory();
    const drivers = driverInventoryWithoutExecution(providerInventory).drivers;
    const execution = driverStatus(drivers, providerInventory);
    return {
      schema: DRIVER_INVENTORY_SCHEMA,
      refreshedAt: state.agentDriverProbes.reduce(
        (latest, probe) => Math.max(latest, Number(probe.checkedAt) || 0),
        0,
      ) || null,
      drivers,
      execution: {
        enabled: execution.enabled,
        status: execution.status,
        conversationCount: conversations.status().conversationCount,
        activeTurnCount: conversations.status().activeTurnCount,
        pendingApprovalCount: conversations.status().pendingApprovalCount,
      },
    };
  }

  function collaboratorInventory() {
    const projection = collaboratorProjection();
    return {
      schema: HOSTED_COLLABORATOR_INVENTORY_SCHEMA,
      collaborators: state.hostedCollaborators.map((collaborator) => publicCollaborator(collaborator, projection)),
    };
  }

  function publicCollaborator(collaborator, projection = collaboratorProjection()) {
    const driver = projection.drivers.find((candidate) => candidate.id === collaborator.driverId);
    const providerProfile = collaborator.driverId === "api"
      ? projection.providerProfiles.get(collaborator.providerProfileId)
      : null;
    const turnExecution = collaboratorTurnExecution(collaborator, driver, providerProfile);
    const activationStatus = collaborator.driverId === "api" && turnExecution && providerProfile?.health === "unhealthy"
      ? "driver-unhealthy"
      : (turnExecution ? "driver-ready" : "driver-unavailable");
    return {
      schema: HOSTED_COLLABORATOR_SCHEMA,
      collaboratorId: collaborator.collaboratorId,
      displayName: collaborator.displayName,
      driverId: collaborator.driverId,
      providerProfileId: collaborator.providerProfileId ?? null,
      driverDisplayName: providerProfile?.displayName ?? driver?.displayName ?? collaborator.driverId,
      driverDetail: providerProfile?.model ?? null,
      revision: collaborator.revision,
      createdAt: collaborator.createdAt,
      updatedAt: collaborator.updatedAt,
      archivedAt: collaborator.archivedAt,
      authority: "computer-host",
      clientProjection: "read-only-replica",
      activationStatus,
      turnExecution,
      toolAccess: publicToolAccess(collaborator.toolAccess),
      cognition: cognition.summary(collaborator.collaboratorId),
    };
  }

  async function route(req, res, path, requireDevice, requireLocalHostConsole) {
    if (await providerProfiles.route(req, res, path, requireDevice, requireLocalHostConsole)) {
      return true;
    }
    if (path === "/aru/v1/agent-drivers" && req.method === "GET") {
      requireDevice();
      sendJSON(res, 200, driverInventory());
      return true;
    }
    if (path === "/aru/v1/agent-drivers/refresh" && req.method === "POST") {
      requireDevice();
      sendJSON(res, 200, refreshDrivers());
      return true;
    }
    if (path === "/aru/v1/hosted-collaborators" && req.method === "GET") {
      requireDevice();
      sendJSON(res, 200, collaboratorInventory());
      return true;
    }
    if (path === "/aru/v1/hosted-collaborators" && req.method === "POST") {
      const device = requireDevice();
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 201, createHostedCollaborator(body, device));
      return true;
    }
    if (await conversations.route(req, res, path, requireDevice)) {
      return true;
    }
    if (await initiative.route(req, res, path, requireDevice)) {
      return true;
    }
    if (await cognition.route(req, res, path, requireDevice, collaboratorForId)) {
      return true;
    }
    if (await surfaces.route(req, res, path, requireDevice, collaboratorForId)) {
      return true;
    }
    if (await projects.route(req, res, path, requireDevice, collaboratorForId)) {
      return true;
    }
    const match = path.match(/^\/aru\/v1\/hosted-collaborators\/([^/]+)$/);
    if (!match) return false;
    const collaboratorId = match[1];
    if (!/^hostcol_[A-Fa-f0-9-]+$/.test(collaboratorId)) {
      throw new HttpError(400, "collaborator.id_invalid", "invalid hosted collaborator id");
    }
    const collaborator = collaboratorForId(collaboratorId);
    if (req.method === "GET") {
      requireDevice();
      sendJSON(res, 200, publicCollaborator(collaborator));
      return true;
    }
    if (req.method === "PUT") {
      const device = requireDevice();
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, updateHostedCollaborator(collaborator, body, device));
      return true;
    }
    return false;
  }

  function collaboratorForId(value) {
    const collaboratorId = String(value ?? "").trim();
    if (!/^hostcol_[A-Fa-f0-9-]+$/.test(collaboratorId)) {
      throw new HttpError(400, "collaborator.id_invalid", "invalid hosted collaborator id");
    }
    const collaborator = state.hostedCollaborators.find(
      (candidate) => candidate.collaboratorId === collaboratorId,
    );
    if (!collaborator) {
      throw new HttpError(404, "collaborator.unknown", "unknown hosted collaborator");
    }
    return collaborator;
  }

  function createHostedCollaborator(body, device) {
    const timestamp = now();
    const collaborator = {
      collaboratorId: `hostcol_${randomUUID()}`,
      displayName: validatedDisplayName(body.displayName),
      driverId: validatedDriverId(body.driverId),
      providerProfileId: validatedProviderProfileId(body.driverId, body.providerProfileId),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      toolAccess: validatedToolAccess(body.toolAccess),
      createdByDeviceId: device.deviceId,
      updatedByDeviceId: device.deviceId,
    };
    state.hostedCollaborators.push(collaborator);
    cognition.initialize(collaborator.collaboratorId, "isolated");
    initiative.initialize(collaborator.collaboratorId);
    saveState();
    return publicCollaborator(collaborator);
  }

  function updateHostedCollaborator(collaborator, body, device) {
    if (!Number.isSafeInteger(body.expectedRevision)) {
      throw new HttpError(400, "collaborator.expected_revision_required", "expectedRevision required");
    }
    if (body.expectedRevision !== collaborator.revision) {
      throw new HttpError(409, "collaborator.revision_conflict", "hosted collaborator changed since it was read");
    }
    if (body.displayName === undefined && body.driverId === undefined
        && body.providerProfileId === undefined && body.toolAccess === undefined) {
      throw new HttpError(400, "collaborator.no_changes", "displayName, driverId, providerProfileId, or toolAccess required");
    }
    if (body.displayName !== undefined) collaborator.displayName = validatedDisplayName(body.displayName);
    if (body.driverId !== undefined || body.providerProfileId !== undefined) {
      const driverId = body.driverId === undefined ? collaborator.driverId : validatedDriverId(body.driverId);
      collaborator.driverId = driverId;
      collaborator.providerProfileId = validatedProviderProfileId(
        driverId,
        body.providerProfileId === undefined ? collaborator.providerProfileId : body.providerProfileId,
      );
    }
    if (body.toolAccess !== undefined) collaborator.toolAccess = validatedToolAccess(body.toolAccess);
    collaborator.revision += 1;
    collaborator.updatedAt = now();
    collaborator.updatedByDeviceId = device.deviceId;
    saveState();
    return publicCollaborator(collaborator);
  }

  function validatedDisplayName(value) {
    const displayName = String(value ?? "").trim();
    if (!displayName) {
      throw new HttpError(400, "collaborator.display_name_required", "displayName required");
    }
    if ([...displayName].length > 80) {
      throw new HttpError(400, "collaborator.display_name_too_long", "displayName must be 80 characters or fewer");
    }
    return displayName;
  }

  function validatedDriverId(value) {
    const driverId = String(value ?? "").trim();
    if (!DRIVER_DEFINITIONS.some((driver) => driver.id === driverId)) {
      throw new HttpError(400, "agent_driver.unknown", "driverId must name a supported agent driver");
    }
    return driverId;
  }

  function validatedProviderProfileId(driverId, value) {
    if (driverId !== "api") return null;
    const profileId = String(value ?? "").trim();
    if (!profileId) {
      throw new HttpError(400, "collaborator.provider_profile_required", "使用模型 API 时必须选择一个 API 配置");
    }
    providerProfiles.profileForId(profileId);
    return profileId;
  }

  function validatedToolAccess(value) {
    if (value === undefined) return { mode: "all", toolNames: [] };
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new HttpError(400, "collaborator.tool_access_invalid", "toolAccess must be an object");
    }
    const mode = String(value.mode ?? "").trim();
    if (mode !== "all" && mode !== "selected") {
      throw new HttpError(400, "collaborator.tool_access_invalid", "toolAccess.mode must be all or selected");
    }
    if (!Array.isArray(value.toolNames)) {
      throw new HttpError(400, "collaborator.tool_access_invalid", "toolAccess.toolNames must be an array");
    }
    const toolNames = [...new Set(value.toolNames.map((item) => validatedToolName(item)))].sort();
    return { mode, toolNames: mode === "all" ? [] : toolNames };
  }

  function validatedToolName(value) {
    if (typeof value !== "string") {
      throw new HttpError(400, "collaborator.tool_access_invalid", "tool names must be strings");
    }
    const toolName = value.trim();
    if (!toolName || /[\u0000-\u001f\u007f]/.test(toolName)) {
      throw new HttpError(400, "collaborator.tool_access_invalid", "tool names must be non-empty printable strings");
    }
    return toolName;
  }

  function publicToolAccess(value) {
    const normalized = value ?? { mode: "all", toolNames: [] };
    return {
      schema: COLLABORATOR_TOOL_ACCESS_SCHEMA,
      mode: normalized.mode === "selected" ? "selected" : "all",
      toolNames: normalized.mode === "selected" && Array.isArray(normalized.toolNames)
        ? [...normalized.toolNames]
        : [],
    };
  }

  if (state.agentDriverProbes.length === 0) refreshDrivers();

  function driverStatus(drivers, providerInventory) {
    const codexReady = drivers.some((driver) => driver.id === "codex" && driver.status === "ready");
    const apiConfigured = providerInventory.profiles.some((profile) => profile.hasSecret);
    if (!codexReady && !apiConfigured) {
      return { enabled: false, status: "driver-unavailable" };
    }
    return { enabled: true, status: codexDriver.status() === "running" ? "running" : "ready" };
  }

  function driverInventoryWithoutExecution(providerInventory = providerProfiles.inventory()) {
    const probes = new Map(state.agentDriverProbes.map((probe) => [probe.id, probe]));
    return {
      drivers: [
        ...LOCAL_DRIVER_DEFINITIONS.map((definition) => ({
          ...publicDriverDefinition(definition),
          ...(probes.get(definition.id) ?? unavailableProbe(definition, null)),
        })),
        apiDriverInventory(providerInventory),
      ],
    };
  }

  function apiDriverInventory(inventory = providerProfiles.inventory()) {
    const configured = inventory.profiles.filter((profile) => profile.hasSecret);
    const ready = configured.filter((profile) => profile.health === "ready");
    return {
      ...API_DRIVER_DEFINITION,
      status: ready.length > 0 ? "ready" : (configured.length > 0 ? "unhealthy" : "unavailable"),
      version: configured.length > 0 ? `${configured.length} 个 API 配置` : null,
      checkedAt: inventory.profiles.reduce(
        (latest, profile) => Math.max(latest, Number(profile.lastCheckedAt) || 0),
        0,
      ) || null,
      failure: inventory.secretStorage.supported ? (configured.length > 0 ? null : "provider-profile-required")
        : inventory.secretStorage.failure,
    };
  }

  function collaboratorTurnExecution(collaborator, driver, providerProfile) {
    if (collaborator.driverId === "codex") return driver?.status === "ready";
    if (collaborator.driverId === "api") return providerProfile?.hasSecret === true;
    return false;
  }

  function collaboratorProjection() {
    const providerInventory = providerProfiles.inventory();
    return {
      drivers: driverInventoryWithoutExecution(providerInventory).drivers,
      providerProfiles: new Map(providerInventory.profiles.map((profile) => [profile.profileId, profile])),
    };
  }

  function driverForCollaborator(collaborator) {
    if (collaborator.driverId === "codex") return codexDriver;
    if (collaborator.driverId === "api") {
      return directAPIDriver.forProfile(collaborator.providerProfileId);
    }
    throw new Error(`${collaborator.driverId} 还没有可执行的 Host 驱动`);
  }

  return {
    route,
    driverInventory,
    collaboratorInventory,
    surfaceTools: surfaces.tools,
    projectTools: projects.tools,
    callSurfaceTool(name, args, device) {
      return surfaces.callTool(name, args, device, collaboratorForId);
    },
    callProjectTool(name, args, device) {
      return projects.callTool(name, args, device, collaboratorForId);
    },
    conversationStatus: conversations.status,
    start: initiative.start,
    stop: initiative.stop,
  };
}

function probeDriver(definition, checkedAt) {
  for (const executable of definition.executableCandidates) {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 3_000,
      windowsHide: true,
    });
    if (result.error?.code === "ENOENT") continue;
    const version = firstLine(result.stdout) || firstLine(result.stderr);
    if (result.status === 0 && version) {
      return {
        id: definition.id,
        status: "ready",
        version,
        checkedAt,
        failure: null,
      };
    }
    return {
      id: definition.id,
      status: "unhealthy",
      version: version || null,
      checkedAt,
      failure: result.error?.code === "ETIMEDOUT" ? "version-probe-timed-out" : "version-probe-failed",
    };
  }
  return unavailableProbe(definition, checkedAt);
}

function publicDriverDefinition({ executableCandidates: _, ...definition }) {
  return definition;
}

function unavailableProbe(definition, checkedAt) {
  return {
    id: definition.id,
    status: "unavailable",
    version: null,
    checkedAt,
    failure: "command-not-found",
  };
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/, 1)[0].trim().slice(0, 160);
}

function resolveDriverExecutable(definition) {
  for (const executable of definition.executableCandidates) {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 3_000,
      windowsHide: true,
    });
    if (result.status === 0) return executable;
  }
  return null;
}
