import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createPluginWorkshop } from "./plugin-workshop.mjs";

const PLUGIN_MANIFEST_SCHEMA = "aru.selfhost.plugin-manifest.v1";
const PLUGIN_MUTATION_SCHEMA = "aru.selfhost.plugin-mutation.v1";
const PLUGIN_SCHEMA = "aru.selfhost.plugin.v1";
const PLUGIN_INVENTORY_SCHEMA = "aru.selfhost.plugin-inventory.v1";

export function createPluginSupervisor({
  state,
  containerRuntime,
  sourceRuntime,
  stopGraceSeconds,
  saveState,
  log,
  readJSONBody,
  sendJSON,
  HttpError,
}) {
  let workshop;

  async function route(req, res, url, path, authorize) {
    if (await workshop.route(req, res, path, authorize)) return true;
    if (path === "/aru/v1/plugins" && req.method === "GET") {
      authorize();
      sendJSON(res, 200, inventory());
      return true;
    }
    if (path === "/aru/v1/plugins" && req.method === "POST") {
      const body = await readJSONBody(req, 256 * 1024);
      sendJSON(res, 201, await install(body, authorize()));
      return true;
    }

    const matched = matchPluginRoute(path);
    if (!matched) return false;
    if (req.method === "GET" && matched.action === null) {
      authorize();
      sendJSON(res, 200, status(matched.pluginId));
      return true;
    }
    if (req.method === "POST" && matched.action === "enable") {
      sendJSON(res, 200, await enable(matched.pluginId, authorize()));
      return true;
    }
    if (req.method === "POST" && matched.action === "disable") {
      sendJSON(res, 200, disable(matched.pluginId, authorize()));
      return true;
    }
    if (req.method === "POST" && matched.action === "upgrade") {
      const body = await readJSONBody(req, 256 * 1024);
      sendJSON(res, 200, await upgrade(matched.pluginId, body, authorize()));
      return true;
    }
    if (req.method === "POST" && matched.action === "rollback") {
      sendJSON(res, 200, await rollback(matched.pluginId, authorize()));
      return true;
    }
    if (req.method === "DELETE" && matched.action === null) {
      sendJSON(res, 200, uninstall(
        matched.pluginId,
        url.searchParams.get("deleteData") === "true",
        authorize(),
      ));
      return true;
    }
    return false;
  }

  function inventory() {
    return {
      schema: PLUGIN_INVENTORY_SCHEMA,
      plugins: state.plugins
        .map(publicPlugin)
        .sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
    };
  }

  function pluginRecord(pluginId) {
    return state.plugins.find((plugin) => plugin.pluginId === pluginId) ?? null;
  }

  function publicPlugin(plugin) {
    return {
      schema: PLUGIN_SCHEMA,
      pluginId: plugin.pluginId,
      manifest: plugin.manifest,
      grantedPermissions: plugin.grantedPermissions,
      desiredState: plugin.desiredState,
      health: pluginHealth(plugin),
      rollbackAvailable: plugin.rollback !== null,
      dataPresent: pluginVolumeExists(plugin),
      tools: plugin.toolCatalog ?? [],
      installedAt: plugin.installedAt,
      updatedAt: plugin.updatedAt,
      lastErrorCode: plugin.lastErrorCode ?? null,
      lastErrorMessage: plugin.lastErrorMessage ?? null,
      events: plugin.events ?? [],
    };
  }

  async function install(body, device) {
    const request = validatePluginMutationRequest(body);
    if (request.manifest.packageMode === "source-node") {
      throw new HttpError(409, "plugin.workshop_publish_required", "Source plugins must be validated and published through the plugin workshop");
    }
    requirePluginRuntime(request.manifest.packageMode);
    if (pluginRecord(request.manifest.pluginId)) {
      throw new HttpError(409, "plugin.already_installed", "Plugin is already installed; use upgrade");
    }
    pullPluginImage(request.manifest.image);
    const now = Date.now();
    const plugin = {
      pluginId: request.manifest.pluginId,
      manifest: request.manifest,
      grantedPermissions: request.grantedPermissions,
      desiredState: "disabled",
      rollback: null,
      installedAt: now,
      updatedAt: now,
      lastErrorCode: null,
      lastErrorMessage: null,
      installedByDeviceId: device.deviceId,
      events: [],
    };
    appendPluginEvent(plugin, "installed", "succeeded", device, `Installed ${plugin.manifest.version} disabled`);
    if (plugin.manifest.permissions.persistentVolume) ensurePluginVolume(plugin);
    state.plugins.push(plugin);
    saveState();
    log(`plugin installed ${plugin.pluginId} version=${plugin.manifest.version} device=${device.deviceId}`);
    return publicPlugin(plugin);
  }

  function status(pluginId) {
    return publicPlugin(requiredPlugin(pluginId));
  }

  async function enable(pluginId, device) {
    const plugin = requiredPlugin(pluginId);
    requirePluginRuntime(plugin.manifest.packageMode);
    plugin.desiredState = "enabled";
    plugin.updatedAt = Date.now();
    plugin.lastErrorCode = null;
    plugin.lastErrorMessage = null;
    if (!await startPlugin(plugin)) {
      saveState();
      appendPluginEvent(plugin, "enabled", "failed", device, plugin.lastErrorMessage ?? "Plugin failed to start");
      saveState();
      throw new HttpError(503, "plugin.start_failed", "Plugin could not start; it remains installed and enabled for inspection");
    }
    appendPluginEvent(plugin, "enabled", "succeeded", device, `Enabled ${plugin.manifest.version}`);
    saveState();
    log(`plugin enabled ${plugin.pluginId} device=${device.deviceId}`);
    return publicPlugin(plugin);
  }

  function disable(pluginId, device) {
    const plugin = requiredPlugin(pluginId);
    stopPlugin(plugin);
    plugin.desiredState = "disabled";
    plugin.updatedAt = Date.now();
    plugin.lastErrorCode = null;
    plugin.lastErrorMessage = null;
    appendPluginEvent(plugin, "disabled", "succeeded", device, `Disabled ${plugin.manifest.version}`);
    saveState();
    log(`plugin disabled ${plugin.pluginId} device=${device.deviceId}`);
    return publicPlugin(plugin);
  }

  async function upgrade(pluginId, body, device) {
    const plugin = requiredPlugin(pluginId);
    const request = validatePluginMutationRequest(body);
    if (request.manifest.packageMode === "source-node") {
      throw new HttpError(409, "plugin.workshop_publish_required", "Source plugins must be updated through the plugin workshop");
    }
    requirePluginRuntime(request.manifest.packageMode);
    if (request.manifest.pluginId !== pluginId) {
      throw new HttpError(400, "plugin.identity_mismatch", "Upgrade manifest pluginId does not match the installed plugin");
    }
    if (request.manifest.packageMode !== plugin.manifest.packageMode) {
      throw new HttpError(409, "plugin.package_mode_mismatch", "Plugin package mode cannot change during upgrade");
    }
    if (request.manifest.image === plugin.manifest.image &&
        request.manifest.version === plugin.manifest.version) {
      throw new HttpError(409, "plugin.upgrade_unchanged", "Upgrade must change version or image digest");
    }
    pullPluginImage(request.manifest.image);
    const previous = {
      manifest: plugin.manifest,
      grantedPermissions: plugin.grantedPermissions,
    };
    const previousRollback = plugin.rollback;
    const wasEnabled = plugin.desiredState === "enabled";
    if (wasEnabled) stopPlugin(plugin);
    plugin.manifest = request.manifest;
    plugin.grantedPermissions = request.grantedPermissions;
    plugin.rollback = previous;
    plugin.updatedAt = Date.now();
    plugin.lastErrorCode = null;
    plugin.lastErrorMessage = null;
    if (plugin.manifest.permissions.persistentVolume) ensurePluginVolume(plugin);
    if (wasEnabled && !await startPlugin(plugin)) {
      plugin.manifest = previous.manifest;
      plugin.grantedPermissions = previous.grantedPermissions;
      plugin.rollback = previousRollback;
      plugin.updatedAt = Date.now();
      plugin.lastErrorCode = "plugin.upgrade_rolled_back";
      plugin.lastErrorMessage = "New plugin version failed to start; the previous version was restored";
      const failureMessage = plugin.lastErrorMessage;
      await startPlugin(plugin);
      plugin.lastErrorCode = "plugin.upgrade_rolled_back";
      plugin.lastErrorMessage = failureMessage;
      appendPluginEvent(plugin, "upgraded", "failed", device, failureMessage);
      saveState();
      throw new HttpError(503, "plugin.upgrade_rolled_back", "New plugin version failed to start; the previous version was restored");
    }
    appendPluginEvent(plugin, "upgraded", "succeeded", device, `Upgraded to ${plugin.manifest.version}`);
    saveState();
    log(`plugin upgraded ${plugin.pluginId} version=${plugin.manifest.version} device=${device.deviceId}`);
    return publicPlugin(plugin);
  }

  async function rollback(pluginId, device) {
    const plugin = requiredPlugin(pluginId);
    requirePluginRuntime(plugin.manifest.packageMode);
    if (!plugin.rollback) {
      throw new HttpError(409, "plugin.rollback_unavailable", "Plugin has no previous release to restore");
    }
    const current = {
      manifest: plugin.manifest,
      grantedPermissions: plugin.grantedPermissions,
      toolCatalog: plugin.toolCatalog ?? [],
    };
    const wasEnabled = plugin.desiredState === "enabled";
    if (wasEnabled) stopPlugin(plugin);
    plugin.manifest = plugin.rollback.manifest;
    plugin.grantedPermissions = plugin.rollback.grantedPermissions;
    plugin.toolCatalog = plugin.rollback.toolCatalog ?? [];
    plugin.rollback = current;
    plugin.updatedAt = Date.now();
    plugin.lastErrorCode = null;
    plugin.lastErrorMessage = null;
    if (wasEnabled && !await startPlugin(plugin)) {
      plugin.manifest = current.manifest;
      plugin.grantedPermissions = current.grantedPermissions;
      plugin.toolCatalog = current.toolCatalog;
      plugin.rollback = null;
      plugin.lastErrorCode = "plugin.rollback_failed";
      plugin.lastErrorMessage = "Previous plugin version failed to start; the current version was restored";
      const failureMessage = plugin.lastErrorMessage;
      await startPlugin(plugin);
      plugin.lastErrorCode = "plugin.rollback_failed";
      plugin.lastErrorMessage = failureMessage;
      appendPluginEvent(plugin, "rolled-back", "failed", device, failureMessage);
      saveState();
      throw new HttpError(503, "plugin.rollback_failed", "Previous plugin version failed to start; the current version was restored");
    }
    appendPluginEvent(plugin, "rolled-back", "succeeded", device, `Restored ${plugin.manifest.version}`);
    saveState();
    log(`plugin rolled back ${plugin.pluginId} version=${plugin.manifest.version} device=${device.deviceId}`);
    return publicPlugin(plugin);
  }

  function uninstall(pluginId, deleteData, device) {
    const plugin = requiredPlugin(pluginId);
    const sourceDigests = plugin.manifest.packageMode === "source-node"
      ? [plugin.manifest.image, plugin.rollback?.manifest?.image].filter(Boolean)
      : [];
    stopPlugin(plugin);
    if (deleteData) deletePluginVolume(plugin);
    state.plugins = state.plugins.filter((candidate) => candidate.pluginId !== pluginId);
    for (const digest of sourceDigests) removeSourcePackageIfUnreferenced(digest);
    saveState();
    log(`plugin uninstalled ${plugin.pluginId} data=${deleteData ? "deleted" : "retained"} device=${device.deviceId}`);
    return { pluginId, dataDeleted: deleteData };
  }

  function matchPluginRoute(path) {
    const prefix = "/aru/v1/plugins/";
    if (!path.startsWith(prefix)) return null;
    const parts = path.slice(prefix.length).split("/").map(decodeURIComponent);
    if (parts.length < 1 || parts.length > 2 || !validPluginId(parts[0])) return null;
    const action = parts[1] ?? null;
    if (action !== null && !["enable", "disable", "upgrade", "rollback"].includes(action)) {
      return null;
    }
    return { pluginId: parts[0], action };
  }

  function requiredPlugin(pluginId) {
    if (!validPluginId(pluginId)) {
      throw new HttpError(400, "plugin.id_invalid", "Plugin id is invalid");
    }
    const plugin = pluginRecord(pluginId);
    if (!plugin) throw new HttpError(404, "plugin.unknown", "Unknown plugin");
    return plugin;
  }

  function requirePluginRuntime(packageMode) {
    if (packageMode === "source-node" && !sourceRuntime?.available) {
      throw new HttpError(503, "plugin.source_runtime_unavailable", "Source plugins require Node.js 22+ permission mode or a container runtime");
    }
    if (packageMode === "oci" && !containerRuntime) {
      throw new HttpError(503, "plugin.runtime_unavailable", "Docker or Podman is required for OCI plugins");
    }
  }

  function validatePluginMutationRequest(body) {
    if (body?.schema !== PLUGIN_MUTATION_SCHEMA) {
      throw new HttpError(400, "plugin.mutation_schema_unsupported", "Unsupported plugin mutation schema");
    }
    const manifest = validatePluginManifest(body.manifest);
    if (!pluginPermissionsEqual(body.grantedPermissions, manifest.permissions)) {
      throw new HttpError(400, "plugin.permission_receipt_mismatch", "Granted permissions must exactly match the reviewed manifest permissions");
    }
    return { manifest, grantedPermissions: body.grantedPermissions };
  }

  function pluginPermissionsEqual(left, right) {
    return left?.network === right?.network &&
      left?.persistentVolume === right?.persistentVolume &&
      left?.deviceAccess === right?.deviceAccess &&
      JSON.stringify(left?.secretHandles ?? []) === JSON.stringify(right?.secretHandles ?? []) &&
      JSON.stringify(left?.hostPaths ?? []) === JSON.stringify(right?.hostPaths ?? []);
  }

  function validatePluginManifest(manifest) {
    if (manifest?.schema !== PLUGIN_MANIFEST_SCHEMA) {
      throw new HttpError(400, "plugin.manifest_schema_unsupported", "Unsupported plugin manifest schema");
    }
    if (!validPluginId(manifest.pluginId)) {
      throw new HttpError(400, "plugin.id_invalid", "pluginId must use lowercase letters, numbers, dots, underscores, or hyphens");
    }
    for (const field of ["displayName", "version", "publisher", "source", "image"]) {
      if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
        throw new HttpError(400, "plugin.manifest_invalid", `${field} is required`);
      }
    }
    if (!["oci", "source-node"].includes(manifest.packageMode)) {
      throw new HttpError(400, "plugin.package_mode_unsupported", "Unsupported plugin package mode");
    }
    if (manifest.packageMode === "oci" &&
        !/^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-fA-F]{64}$/.test(manifest.image)) {
      throw new HttpError(400, "plugin.image_not_pinned", "OCI image must be pinned to a sha256 digest");
    }
    if (manifest.packageMode === "source-node" && !/^sha256:[0-9a-f]{64}$/.test(manifest.image)) {
      throw new HttpError(400, "plugin.source_digest_invalid", "Source plugin identity must be a sha256 digest");
    }
    if (!Array.isArray(manifest.protocols) ||
        manifest.protocols.some((value) => typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(value)) ||
        new Set(manifest.protocols).size !== manifest.protocols.length) {
      throw new HttpError(400, "plugin.protocols_invalid", "Plugin protocols must be unique stable identifiers");
    }
    const permissions = manifest.permissions;
    if (!permissions || !["none", "outbound"].includes(permissions.network) ||
        typeof permissions.persistentVolume !== "boolean" ||
        !Array.isArray(permissions.secretHandles) || !Array.isArray(permissions.hostPaths) ||
        typeof permissions.deviceAccess !== "boolean") {
      throw new HttpError(400, "plugin.permissions_invalid", "Plugin permissions are invalid", {
        issues: [{ field: "permissions", problem: "invalid_shape", expected: "network, persistentVolume, secretHandles, hostPaths, deviceAccess" }],
        recovery: { action: "correct_arguments", fields: ["permissions"] },
      });
    }
    if (permissions.secretHandles.length > 0) {
      throw new HttpError(409, "plugin.scoped_secrets_unavailable", "Scoped plugin secret injection is not implemented yet");
    }
    if (permissions.hostPaths.length > 0) {
      throw new HttpError(409, "plugin.host_paths_forbidden", "Plugins cannot request arbitrary host paths");
    }
    if (permissions.deviceAccess) {
      throw new HttpError(409, "plugin.device_access_unavailable", "Plugin device access is not implemented yet");
    }
    const resources = manifest.resources;
    if (!resources || ![resources.memoryMiB, resources.cpuMillis, resources.pids]
        .every((value) => value === null || value === undefined || (Number.isSafeInteger(value) && value > 0))) {
      throw new HttpError(400, "plugin.resources_invalid", "Plugin resource budgets must be positive integers or null", {
        issues: [{ field: "resources", problem: "invalid_budget", expected: "positive integer, null, or omitted" }],
        recovery: { action: "correct_arguments", fields: ["resources"] },
      });
    }
    return manifest;
  }

  function validPluginId(value) {
    return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
  }

  function pullPluginImage(image) {
    const result = spawnSync(containerRuntime, ["pull", image], { stdio: "ignore" });
    if (result.status !== 0) {
      throw new HttpError(503, "plugin.image_pull_failed", "Digest-pinned plugin image could not be pulled");
    }
  }

  async function startPlugin(plugin) {
    if (plugin.manifest.packageMode === "source-node") {
      try {
        plugin.toolCatalog = await sourceRuntime.probe(plugin);
        plugin.lastErrorCode = null;
        plugin.lastErrorMessage = null;
        return true;
      } catch (error) {
        plugin.lastErrorCode = "plugin.start_failed";
        plugin.lastErrorMessage = error instanceof Error ? error.message : String(error);
        return false;
      }
    }
    stopPlugin(plugin);
    if (plugin.manifest.permissions.persistentVolume) ensurePluginVolume(plugin);
    const args = [
      "run", "-d", "--name", pluginContainerName(plugin.pluginId), "--init",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "65532:65532",
    ];
    if (plugin.manifest.permissions.network === "none") args.push("--network", "none");
    if (plugin.manifest.permissions.persistentVolume) {
      args.push("--mount", `type=volume,src=${pluginVolumeName(plugin.pluginId)},dst=/data,rw`);
    }
    if (plugin.manifest.resources.memoryMiB) {
      args.push("--memory", `${plugin.manifest.resources.memoryMiB}m`);
    }
    if (plugin.manifest.resources.cpuMillis) {
      args.push("--cpus", String(plugin.manifest.resources.cpuMillis / 1000));
    }
    if (plugin.manifest.resources.pids) {
      args.push("--pids-limit", String(plugin.manifest.resources.pids));
    }
    args.push(plugin.manifest.image);
    const result = spawnSync(containerRuntime, args, { stdio: "ignore" });
    if (result.status !== 0) {
      plugin.lastErrorCode = "plugin.start_failed";
      plugin.lastErrorMessage = "The container runtime could not start this plugin";
      return false;
    }
    plugin.lastErrorCode = null;
    plugin.lastErrorMessage = null;
    return true;
  }

  function stopPlugin(plugin) {
    if (plugin.manifest.packageMode === "source-node") return;
    if (!containerRuntime) return;
    spawnSync(containerRuntime,
      ["stop", "--time", String(stopGraceSeconds), pluginContainerName(plugin.pluginId)],
      { stdio: "ignore" });
    spawnSync(containerRuntime, ["rm", "-f", pluginContainerName(plugin.pluginId)], {
      stdio: "ignore",
    });
  }

  function pluginHealth(plugin) {
    if (plugin.desiredState === "disabled") return "disabled";
    if (plugin.manifest.packageMode === "source-node") {
      return sourceRuntime?.packagePresent(plugin.manifest.image) && plugin.lastErrorCode !== "plugin.start_failed"
        ? "running" : "unhealthy";
    }
    if (!containerRuntime) return "unhealthy";
    const result = spawnSync(containerRuntime,
      ["inspect", "--format", "{{.State.Status}}", pluginContainerName(plugin.pluginId)],
      { encoding: "utf8" });
    return result.status === 0 && result.stdout.trim() === "running" ? "running" : "unhealthy";
  }

  function pluginContainerName(pluginId) {
    return `aru-plugin-${sha256Hex(pluginId).slice(0, 16)}`;
  }

  function pluginVolumeName(pluginId) {
    return `aru-plugin-data-${sha256Hex(pluginId).slice(0, 16)}`;
  }

  function ensurePluginVolume(plugin) {
    if (plugin.manifest.packageMode === "source-node") return;
    const name = pluginVolumeName(plugin.pluginId);
    const inspected = spawnSync(containerRuntime, ["volume", "inspect", name], { stdio: "ignore" });
    if (inspected.status === 0) return;
    const created = spawnSync(containerRuntime, ["volume", "create", name], { stdio: "ignore" });
    if (created.status !== 0) {
      throw new HttpError(503, "plugin.volume_create_failed", "Plugin data volume could not be created");
    }
  }

  function pluginVolumeExists(plugin) {
    if (plugin.manifest.packageMode === "source-node") {
      return plugin.manifest.permissions.persistentVolume && sourceRuntime.dataPresent(plugin.pluginId);
    }
    if (!containerRuntime) return false;
    return spawnSync(containerRuntime,
      ["volume", "inspect", pluginVolumeName(plugin.pluginId)], { stdio: "ignore" }).status === 0;
  }

  function deletePluginVolume(plugin) {
    if (plugin.manifest.packageMode === "source-node") {
      sourceRuntime.removeData(plugin.pluginId);
      return;
    }
    if (!containerRuntime) return;
    spawnSync(containerRuntime,
      ["volume", "rm", "-f", pluginVolumeName(plugin.pluginId)], { stdio: "ignore" });
  }

  async function reconcileInstalledPlugins() {
    let changed = false;
    for (const plugin of state.plugins) {
      if (plugin.desiredState !== "enabled") continue;
      plugin.updatedAt = Date.now();
      await startPlugin(plugin);
      changed = true;
    }
    if (changed) {
      saveState();
      log(`reconciled ${state.plugins.filter((plugin) => plugin.desiredState === "enabled").length} enabled plugin(s)`);
    }
  }

  function workshopGuide() {
    return workshop.workshopGuide();
  }

  async function validateSourceDraft(args) {
    return workshop.validateSourceDraft(args);
  }

  async function saveSourceDraft(args, device) {
    return workshop.saveSourceDraftSummary(args, device);
  }

  async function applySource(args, device) {
    return workshop.applySource(args, device);
  }

  function dynamicMCPTools() {
    return state.plugins.flatMap((plugin) => {
      if (plugin.manifest.packageMode !== "source-node" || plugin.desiredState !== "enabled" ||
          pluginHealth(plugin) !== "running") return [];
      return (plugin.toolCatalog ?? []).map((tool) => ({
        ...tool,
        name: dynamicToolName(plugin.pluginId, tool.name),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      }));
    });
  }

  async function callDynamicMCPTool(name, args) {
    for (const plugin of state.plugins) {
      if (plugin.manifest.packageMode !== "source-node" || plugin.desiredState !== "enabled") continue;
      for (const tool of plugin.toolCatalog ?? []) {
        if (dynamicToolName(plugin.pluginId, tool.name) === name) {
          return { matched: true, value: await sourceRuntime.call(plugin, tool.name, args) };
        }
      }
    }
    return { matched: false, value: null };
  }

  function assertDynamicToolNamesAvailable(pluginId, tools) {
    const names = new Set(tools.map((tool) => dynamicToolName(pluginId, tool.name)));
    for (const plugin of state.plugins) {
      if (plugin.pluginId === pluginId || plugin.manifest.packageMode !== "source-node") continue;
      for (const tool of plugin.toolCatalog ?? []) {
        if (names.has(dynamicToolName(plugin.pluginId, tool.name))) {
          throw new HttpError(409, "plugin.tool_name_conflict", "Published plugin tools collide with another installed plugin");
        }
      }
    }
  }

  function removeSourcePackageIfUnreferenced(digest) {
    const referenced = state.plugins.some((candidate) =>
      candidate.manifest.image === digest || candidate.rollback?.manifest?.image === digest);
    if (!referenced) sourceRuntime.removePackage(digest);
  }

  function appendPluginEvent(plugin, action, result, device, message) {
    plugin.events ??= [];
    plugin.events.push({
      schema: "aru.selfhost.plugin-event.v1",
      eventId: `pe_${Date.now()}_${plugin.events.length}`,
      action,
      result,
      message,
      version: plugin.manifest.version,
      deviceId: device.deviceId,
      createdAt: Date.now(),
    });
  }

  workshop = createPluginWorkshop({
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
    enablePlugin: enable,
    rollbackPlugin: rollback,
    appendPluginEvent,
    assertDynamicToolNamesAvailable,
    removeSourcePackageIfUnreferenced,
  });

  return {
    route,
    inventory,
    status,
    install,
    enable,
    disable,
    upgrade,
    rollback,
    uninstall,
    reconcileInstalledPlugins,
    workshopGuide,
    validateSourceDraft,
    saveSourceDraft,
    applySource,
    draftInventory: workshop.draftInventory,
    dynamicMCPTools,
    callDynamicMCPTool,
  };
}

function dynamicToolName(pluginId, toolName) {
  return `plugin__${pluginId.replace(/[^a-z0-9_-]/g, "_")}__${toolName}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
