const DRAFT_SCHEMA = "aru.selfhost.plugin-draft.v1";
const DRAFT_INVENTORY_SCHEMA = "aru.selfhost.plugin-draft-inventory.v1";
const PLUGIN_MANIFEST_SCHEMA = "aru.selfhost.plugin-manifest.v1";

export function createPluginWorkshop({
  state,
  sourceRuntime,
  saveState,
  log,
  readJSONBody,
  sendJSON,
  HttpError,
  pluginRecord,
  publicPlugin,
  validPluginId,
  validatePluginManifest,
  stopPlugin,
  enablePlugin,
  rollbackPlugin,
  appendPluginEvent,
  assertDynamicToolNamesAvailable,
  removeSourcePackageIfUnreferenced,
}) {
  async function route(req, res, path, authorize) {
    if (path === "/aru/v1/plugin-workshop/guide" && req.method === "GET") {
      authorize();
      sendJSON(res, 200, workshopGuide());
      return true;
    }
    if (path === "/aru/v1/plugin-workshop/drafts" && req.method === "GET") {
      authorize();
      sendJSON(res, 200, draftInventory());
      return true;
    }
    if (path === "/aru/v1/plugin-workshop/validate" && req.method === "POST") {
      authorize();
      const body = await readJSONBody(req, 256 * 1024);
      sendJSON(res, 200, await validateSourceDraft(body));
      return true;
    }
    if (path === "/aru/v1/plugin-workshop/drafts" && req.method === "POST") {
      const device = authorize();
      const body = await readJSONBody(req, 256 * 1024);
      sendJSON(res, 200, await saveSourceDraft(body, device));
      return true;
    }
    if (path === "/aru/v1/plugin-workshop/apply" && req.method === "POST") {
      const device = authorize();
      const body = await readJSONBody(req, 256 * 1024);
      sendJSON(res, 200, await applySource(body, device));
      return true;
    }

    const draftRoute = matchDraftRoute(path);
    if (draftRoute) {
      if (req.method === "GET" && draftRoute.action === null) {
        authorize();
        sendJSON(res, 200, requiredDraft(draftRoute.pluginId));
        return true;
      }
      if (req.method === "DELETE" && draftRoute.action === null) {
        sendJSON(res, 200, deleteDraft(draftRoute.pluginId, authorize()));
        return true;
      }
      if (req.method === "POST" && draftRoute.action === "apply") {
        sendJSON(res, 200, await applyDraft(draftRoute.pluginId, authorize()));
        return true;
      }
    }

    const sourceRoute = matchInstalledSourceRoute(path);
    if (sourceRoute && req.method === "GET") {
      authorize();
      sendJSON(res, 200, installedSource(sourceRoute.pluginId));
      return true;
    }
    return false;
  }

  function workshopGuide() {
    const guide = sourceRuntime.guide();
    return {
      ...guide,
      lifecycle: [
        "validate",
        "apply-and-enable immediately or save an optional reviewable draft",
        "refresh MCP catalog or begin the next model turn",
        "call",
      ],
      activation: {
        direct: "AI and the Host Console may validate, publish, and enable in one confirmed operation",
        draft: "drafts are optional visible editing checkpoints, never an approval gate",
        failure: "a failed update restores the previous working release; a failed first install stays visible for repair",
      },
    };
  }

  function draftInventory() {
    return {
      schema: DRAFT_INVENTORY_SCHEMA,
      drafts: state.pluginDrafts
        .map(draftSummary)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    };
  }

  async function validateSourceDraft(args) {
    const request = validateSourceWorkshopRequest(args);
    const validated = await sourceRuntime.validateDraft(request);
    assertDynamicToolNamesAvailable(request.pluginId, validated.tools);
    return { ...validated, permissions: request.permissions, capabilities: request.capabilities };
  }

  async function saveSourceDraft(args, device) {
    const request = validateSourceWorkshopRequest(args);
    const installed = pluginRecord(request.pluginId);
    if (installed && installed.manifest.packageMode !== "source-node") {
      throw new HttpError(409, "plugin.package_mode_mismatch", "An OCI plugin already owns this plugin id");
    }
    const validated = await sourceRuntime.validateDraft(request);
    assertDynamicToolNamesAvailable(request.pluginId, validated.tools);
    const previous = draftRecord(request.pluginId);
    const now = Date.now();
    const draft = {
      schema: DRAFT_SCHEMA,
      pluginId: request.pluginId,
      displayName: request.displayName,
      version: request.version,
      sourceCode: request.sourceCode,
      capabilities: request.capabilities,
      permissions: request.permissions,
      resources: request.resources,
      digest: validated.digest,
      tools: validated.tools,
      target: installed ? "update" : "create",
      installedVersion: installed?.manifest.version ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      authoredByDeviceId: device.deviceId,
    };
    state.pluginDrafts = state.pluginDrafts.filter((candidate) => candidate.pluginId !== request.pluginId);
    state.pluginDrafts.push(draft);
    saveState();
    log(`source plugin draft saved ${request.pluginId} version=${request.version} device=${device.deviceId}`);
    return draft;
  }

  async function saveSourceDraftSummary(args, device) {
    return draftSummary(await saveSourceDraft(args, device));
  }

  async function applySource(args, device) {
    const draft = await saveSourceDraft(args, device);
    return applyDraft(draft.pluginId, device);
  }

  async function applyDraft(pluginId, device) {
    const hadInstalledRelease = pluginRecord(pluginId) !== null;
    const plugin = await publishDraft(pluginId, device);
    try {
      const enabled = await enablePlugin(pluginId, device);
      return { schema: "aru.selfhost.plugin-apply-result.v1", plugin: enabled, tools: enabled.tools };
    } catch (error) {
      if (hadInstalledRelease && pluginRecord(pluginId)?.rollback) {
        await rollbackPlugin(pluginId, device);
        throw new HttpError(503, "plugin.apply_rolled_back", "The new plugin could not start; the previous working release was restored");
      }
      throw error;
    }
  }

  async function publishDraft(pluginId, device) {
    const draft = requiredDraft(pluginId);
    const installed = pluginRecord(pluginId);
    if (installed && installed.manifest.packageMode !== "source-node") {
      throw new HttpError(409, "plugin.package_mode_mismatch", "An OCI plugin already owns this plugin id");
    }
    if (installed && installed.manifest.version === draft.version && installed.manifest.image === draft.digest) {
      throw new HttpError(409, "plugin.apply_unchanged", "Change the plugin version or source before applying an update");
    }
    const request = validateSourceWorkshopRequest(draft);
    const validated = await sourceRuntime.validateDraft(request);
    if (validated.digest !== draft.digest) {
      throw new HttpError(409, "plugin.source_changed", "Plugin source changed after draft validation");
    }
    assertDynamicToolNamesAvailable(pluginId, validated.tools);
    sourceRuntime.store(request.sourceCode, validated.digest);

    const now = Date.now();
    const manifest = {
      schema: PLUGIN_MANIFEST_SCHEMA,
      pluginId,
      displayName: request.displayName,
      version: request.version,
      publisher: "Aru workshop",
      source: "model-authored-on-paired-node",
      packageMode: "source-node",
      image: validated.digest,
      protocols: ["mcp-tools-v1"],
      permissions: request.permissions,
      resources: request.resources,
    };
    if (installed) {
      const abandonedRollbackDigest = installed.rollback?.manifest?.packageMode === "source-node"
        ? installed.rollback.manifest.image : null;
      stopPlugin(installed);
      installed.rollback = {
        manifest: installed.manifest,
        grantedPermissions: installed.grantedPermissions,
        toolCatalog: installed.toolCatalog ?? [],
      };
      installed.manifest = manifest;
      installed.grantedPermissions = request.permissions;
      installed.toolCatalog = validated.tools;
      installed.desiredState = "disabled";
      installed.updatedAt = now;
      installed.lastErrorCode = null;
      installed.lastErrorMessage = null;
      appendPluginEvent(installed, "published", "succeeded", device, `Published ${request.version} from reviewed draft`);
      if (abandonedRollbackDigest) removeSourcePackageIfUnreferenced(abandonedRollbackDigest);
    } else {
      const plugin = {
        pluginId,
        manifest,
        grantedPermissions: request.permissions,
        toolCatalog: validated.tools,
        desiredState: "disabled",
        rollback: null,
        installedAt: now,
        updatedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        installedByDeviceId: device.deviceId,
        events: [],
      };
      appendPluginEvent(plugin, "published", "succeeded", device, `Published ${request.version} from reviewed draft`);
      state.plugins.push(plugin);
    }
    state.pluginDrafts = state.pluginDrafts.filter((candidate) => candidate.pluginId !== pluginId);
    saveState();
    log(`source plugin published ${pluginId} version=${request.version} disabled device=${device.deviceId}`);
    return publicPlugin(pluginRecord(pluginId));
  }

  function deleteDraft(pluginId, device) {
    requiredDraft(pluginId);
    state.pluginDrafts = state.pluginDrafts.filter((candidate) => candidate.pluginId !== pluginId);
    saveState();
    log(`source plugin draft deleted ${pluginId} device=${device.deviceId}`);
    return { pluginId, deleted: true };
  }

  function installedSource(pluginId) {
    const plugin = pluginRecord(pluginId);
    if (!plugin) throw new HttpError(404, "plugin.unknown", "Unknown plugin");
    if (plugin.manifest.packageMode !== "source-node") {
      throw new HttpError(409, "plugin.source_unavailable", "OCI plugin source is not stored on this node");
    }
    return {
      schema: "aru.selfhost.plugin-source.v1",
      pluginId,
      displayName: plugin.manifest.displayName,
      version: plugin.manifest.version,
      sourceCode: sourceRuntime.readPackage(plugin.manifest.image),
      capabilities: capabilitiesForPermissions(plugin.grantedPermissions),
      digest: plugin.manifest.image,
      tools: plugin.toolCatalog ?? [],
    };
  }

  function draftRecord(pluginId) {
    return state.pluginDrafts.find((draft) => draft.pluginId === pluginId) ?? null;
  }

  function requiredDraft(pluginId) {
    if (!validPluginId(pluginId)) {
      throw new HttpError(400, "plugin.id_invalid", "Plugin id is invalid");
    }
    const draft = draftRecord(pluginId);
    if (!draft) throw new HttpError(404, "plugin.draft_unknown", "Unknown plugin draft");
    return draft;
  }

  function draftSummary(draft) {
    const { sourceCode: _, ...summary } = draft;
    return summary;
  }

  function matchDraftRoute(path) {
    const prefix = "/aru/v1/plugin-workshop/drafts/";
    if (!path.startsWith(prefix)) return null;
    const parts = path.slice(prefix.length).split("/").map(decodeURIComponent);
    if (parts.length < 1 || parts.length > 2 || !validPluginId(parts[0])) return null;
    const action = parts[1] ?? null;
    if (action !== null && action !== "apply") return null;
    return { pluginId: parts[0], action };
  }

  function matchInstalledSourceRoute(path) {
    const match = path.match(/^\/aru\/v1\/plugins\/([^/]+)\/source$/);
    if (!match) return null;
    const pluginId = decodeURIComponent(match[1]);
    return validPluginId(pluginId) ? { pluginId } : null;
  }

  function validateSourceWorkshopRequest(args) {
    if (!sourceRuntime?.available) {
      throw new HttpError(503, "plugin.source_runtime_unavailable", "Source plugins require Node.js 22+ permission mode or a container runtime");
    }
    if (!validPluginId(args?.pluginId)) {
      throw new HttpError(400, "plugin.id_invalid", "pluginId must use lowercase letters, numbers, dots, underscores, or hyphens");
    }
    for (const field of ["displayName", "version", "sourceCode"]) {
      if (typeof args?.[field] !== "string" || args[field].trim() === "") {
        throw new HttpError(400, "plugin.workshop_request_invalid", `${field} is required`);
      }
    }
    const capabilities = normalizeSourceCapabilities(args.capabilities);
    const permissions = {
      network: capabilities.includes("network-outbound") ? "outbound" : "none",
      persistentVolume: capabilities.includes("persistent-storage"),
      secretHandles: [],
      hostPaths: [],
      deviceAccess: false,
    };
    const resources = { memoryMiB: null, cpuMillis: null, pids: null };
    validatePluginManifest({
      schema: PLUGIN_MANIFEST_SCHEMA,
      pluginId: args.pluginId,
      displayName: args.displayName,
      version: args.version,
      publisher: "Aru workshop",
      source: "model-authored-on-paired-node",
      packageMode: "source-node",
      image: `sha256:${"0".repeat(64)}`,
      protocols: ["mcp-tools-v1"],
      permissions,
      resources,
    });
    return {
      pluginId: args.pluginId,
      displayName: args.displayName.trim(),
      version: args.version.trim(),
      sourceCode: args.sourceCode,
      capabilities,
      permissions,
      resources,
    };
  }

  function normalizeSourceCapabilities(value) {
    if (value === undefined) return [];
    const supported = new Set(["persistent-storage", "network-outbound"]);
    if (!Array.isArray(value) || value.some((capability) => typeof capability !== "string" || !supported.has(capability))) {
      throw new HttpError(400, "plugin.capabilities_invalid", "Source plugin capabilities are invalid", {
        issues: [{ field: "capabilities", problem: "unsupported_value", expected: "persistent-storage or network-outbound" }],
        recovery: { action: "correct_arguments", fields: ["capabilities"] },
      });
    }
    return [...new Set(value)];
  }

  function capabilitiesForPermissions(permissions) {
    return [
      ...(permissions?.persistentVolume ? ["persistent-storage"] : []),
      ...(permissions?.network === "outbound" ? ["network-outbound"] : []),
    ];
  }

  return {
    route,
    workshopGuide,
    draftInventory,
    validateSourceDraft,
    saveSourceDraft,
    saveSourceDraftSummary,
    applySource,
    applyDraft,
  };
}
