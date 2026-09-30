const NODE_SETTINGS_SCHEMA = "aru.selfhost.node-settings.v1";
const PAIRED_DEVICE_INVENTORY_SCHEMA = "aru.selfhost.paired-device-inventory.v1";
const DEVICE_REVOCATION_SCHEMA = "aru.selfhost.device-revocation.v1";

export function createNodeControl({
  config,
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  log,
  now = Date.now,
}) {
  state.nodeSettings ??= {
    schema: NODE_SETTINGS_SCHEMA,
    displayName: validatedDisplayName(config.displayName),
    revision: 1,
    updatedAt: now(),
    updatedByDeviceId: null,
  };
  normalizeSettings();
  config.addressMode = config.transportKind === "lan" ? state.nodeSettings.addressMode ?? config.addressMode : "fixed";

  function normalizeSettings() {
    state.nodeSettings.schema = NODE_SETTINGS_SCHEMA;
    state.nodeSettings.displayName = validatedDisplayName(
      state.nodeSettings.displayName ?? config.displayName,
    );
    if (!Number.isSafeInteger(state.nodeSettings.revision) || state.nodeSettings.revision < 1) {
      state.nodeSettings.revision = 1;
    }
    if (!Number.isSafeInteger(state.nodeSettings.updatedAt) || state.nodeSettings.updatedAt < 0) {
      state.nodeSettings.updatedAt = now();
    }
  }

  function displayName() {
    return state.nodeSettings.displayName;
  }

  function publicSettings() {
    return {
      schema: NODE_SETTINGS_SCHEMA,
      displayName: displayName(),
      networkAddress: config.networkAddress?.(),
      additionalTransports: state.nodeSettings.additionalTransports ?? [],
      transportProfiles: transportProfiles(),
      revision: state.nodeSettings.revision,
      updatedAt: state.nodeSettings.updatedAt,
    };
  }

  function transportProfiles() {
    return [{ id: "primary", kind: config.transportKind, baseUrl: config.baseUrl, priority: 10 },
      ...(state.nodeSettings.additionalTransports ?? [])];
  }

  function validateTransports(value) {
    if (!Array.isArray(value)) throw new HttpError(400, "node.transports_invalid", "Connection addresses must be an array");
    const ids = new Set(["primary"]), origins = new Set();
    return value.map(entry => {
      if (!entry || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.id) || ids.has(entry.id))
        throw new HttpError(400, "node.transport_id_invalid", "Connection address identifiers must be unique");
      ids.add(entry.id);
      let url;
      try { url = new URL(entry.baseUrl); } catch { throw new HttpError(400, "node.transport_url_invalid", "Enter a complete connection address"); }
      if (!["tailscale", "public-https"].includes(entry.kind) || !["http:", "https:"].includes(url.protocol) ||
          url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
          (entry.kind === "public-https" && url.protocol !== "https:"))
        throw new HttpError(400, "node.transport_url_invalid", "Use a Tailscale origin or a public HTTPS origin without a path or credentials");
      const parts = url.hostname.split('.').map(Number);
      const tailnet = (parts.length === 4 && parts.every(x => Number.isInteger(x) && x >= 0 && x <= 255) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || url.hostname.endsWith('.ts.net');
      if (url.protocol === "http:" && !tailnet)
        throw new HttpError(400, "node.transport_insecure", "HTTP is only allowed for Tailscale addresses; public addresses need HTTPS");
      if (origins.has(url.origin)) throw new HttpError(400, "node.transport_duplicate", "This connection address has already been added");
      origins.add(url.origin);
      return { id: entry.id, kind: entry.kind, baseUrl: url.origin, priority: 20 };
    });
  }

  // Durable configuration is admitted at startup, not silently dropped on corruption.
  if (state.nodeSettings.additionalTransports !== undefined)
    state.nodeSettings.additionalTransports = validateTransports(state.nodeSettings.additionalTransports);

  function manifestCapability() {
    return {
      enabled: true,
      endpoint: "/aru/v1/node-settings",
      update: "expected-revision",
      additionalTransports: true,
      access: "paired-device-administration",
    };
  }

  function deviceInventory(currentDeviceId) {
    return {
      schema: PAIRED_DEVICE_INVENTORY_SCHEMA,
      currentDeviceId,
      devices: state.devices.map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
        issuedAt: device.issuedAt,
        revokedAt: device.revokedAt,
        isCurrent: device.deviceId === currentDeviceId,
      })),
    };
  }

  async function route(req, res, path, requireDevice) {
    if (path === "/aru/v1/node-settings" && req.method === "GET") {
      requireDevice();
      sendJSON(res, 200, publicSettings());
      return true;
    }
    if (path === "/aru/v1/node-settings" && req.method === "PUT") {
      const device = requireDevice();
      const body = await readJSONBody(req, 64 * 1024);
      updateSettings(body, device);
      sendJSON(res, 200, publicSettings());
      return true;
    }
    if (path === "/aru/v1/devices" && req.method === "GET") {
      const device = requireDevice();
      sendJSON(res, 200, deviceInventory(device.deviceId));
      return true;
    }
    if (path === "/aru/v1/devices/revoke" && req.method === "POST") {
      const device = requireDevice();
      const body = await readJSONBody(req, 64 * 1024);
      const target = state.devices.find((entry) => entry.deviceId === body.deviceId);
      if (!target) throw new HttpError(404, "device.unknown", "unknown device");
      target.revokedAt ??= now();
      saveState();
      log(`device revoked ${target.deviceId} by ${device.deviceId}`);
      sendJSON(res, 200, {
        schema: DEVICE_REVOCATION_SCHEMA,
        deviceId: target.deviceId,
        revokedAt: target.revokedAt,
      });
      return true;
    }
    return false;
  }

  function updateSettings(body, device) {
    if (body?.schema !== NODE_SETTINGS_SCHEMA) {
      throw new HttpError(400, "node.settings_schema_unsupported", "unsupported node settings schema");
    }
    if (!Number.isSafeInteger(body.expectedRevision)) {
      throw new HttpError(400, "node.expected_revision_required", "expectedRevision required");
    }
    if (body.expectedRevision !== state.nodeSettings.revision) {
      throw new HttpError(409, "node.revision_conflict", "node settings changed since they were read");
    }
    const nextDisplayName = validatedDisplayName(body.displayName);
    const addressMode = body.addressMode ?? config.addressMode ?? "fixed";
    if (!["fixed", "automatic-lan"].includes(addressMode) ||
        (addressMode === "automatic-lan" && config.transportKind !== "lan")) {
      throw new HttpError(400, "node.address_mode_invalid", "Automatic LAN is only available for LAN transport");
    }
    const additionalTransports = validateTransports(body.additionalTransports ?? state.nodeSettings.additionalTransports ?? []);
    if (JSON.stringify(additionalTransports) === JSON.stringify(state.nodeSettings.additionalTransports ?? []) && nextDisplayName === state.nodeSettings.displayName && addressMode === (state.nodeSettings.addressMode ?? config.addressMode ?? "fixed")) return publicSettings();
    const previous = state.nodeSettings;
    state.nodeSettings = {
      schema: NODE_SETTINGS_SCHEMA,
      displayName: nextDisplayName,
      addressMode,
      additionalTransports,
      revision: state.nodeSettings.revision + 1,
      updatedAt: now(),
      updatedByDeviceId: device.deviceId,
    };
    try { saveState(); } catch (error) { state.nodeSettings = previous; throw error; }
    config.addressMode = addressMode;
    log(`node display name updated by ${device.deviceId}`);
    return publicSettings();
  }

  function validatedDisplayName(value) {
    const name = String(value ?? "").trim();
    if (!name) throw new HttpError(400, "node.display_name_required", "displayName required");
    if ([...name].length > 80) {
      throw new HttpError(400, "node.display_name_too_long", "displayName must be 80 characters or fewer");
    }
    return name;
  }

  return {
    route,
    displayName,
    publicSettings,
    transportProfiles,
    manifestCapability,
    deviceInventory,
    updateSettings,
  };
}
