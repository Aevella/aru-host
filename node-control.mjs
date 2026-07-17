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
      revision: state.nodeSettings.revision,
      updatedAt: state.nodeSettings.updatedAt,
    };
  }

  function manifestCapability() {
    return {
      enabled: true,
      endpoint: "/aru/v1/node-settings",
      update: "expected-revision",
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
    if (nextDisplayName === state.nodeSettings.displayName) return publicSettings();
    state.nodeSettings = {
      schema: NODE_SETTINGS_SCHEMA,
      displayName: nextDisplayName,
      revision: state.nodeSettings.revision + 1,
      updatedAt: now(),
      updatedByDeviceId: device.deviceId,
    };
    saveState();
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
    manifestCapability,
    deviceInventory,
    updateSettings,
  };
}
