const BACKUP_SETTINGS_SCHEMA = "aru.selfhost.backup-settings.v1";

export function createBackupSettings({
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  deletePackage,
  log,
  now = Date.now,
}) {
  normalizeSettings();

  function normalizeSettings() {
    const current = state.backupSettings ?? {};
    const retentionMode = current.retentionMode === "keep-latest"
      ? "keep-latest"
      : "keep-all";
    state.backupSettings = {
      schema: BACKUP_SETTINGS_SCHEMA,
      retentionMode,
      keepLatestCount: retentionMode === "keep-latest"
        ? normalizedKeepLatestCount(current.keepLatestCount)
        : null,
      revision: Number.isSafeInteger(current.revision) && current.revision > 0
        ? current.revision
        : 1,
      updatedAt: Number.isSafeInteger(current.updatedAt) && current.updatedAt >= 0
        ? current.updatedAt
        : now(),
      updatedByDeviceId: typeof current.updatedByDeviceId === "string"
        ? current.updatedByDeviceId
        : null,
      lastAppliedAt: Number.isSafeInteger(current.lastAppliedAt) && current.lastAppliedAt >= 0
        ? current.lastAppliedAt
        : null,
      lastDeletedCount: Number.isSafeInteger(current.lastDeletedCount) && current.lastDeletedCount >= 0
        ? current.lastDeletedCount
        : 0,
    };
  }

  function normalizedKeepLatestCount(value) {
    return Number.isSafeInteger(value) && value >= 1 ? value : 30;
  }

  function publicSettings() {
    const settings = state.backupSettings;
    return {
      schema: BACKUP_SETTINGS_SCHEMA,
      retentionMode: settings.retentionMode,
      keepLatestCount: settings.keepLatestCount,
      revision: settings.revision,
      updatedAt: settings.updatedAt,
      lastAppliedAt: settings.lastAppliedAt,
      lastDeletedCount: settings.lastDeletedCount,
    };
  }

  function manifestCapability() {
    return {
      settingsEndpoint: "/aru/v1/backups/settings",
      retention: "host-enforced-after-upload",
      settingsUpdate: "expected-revision",
    };
  }

  async function route(req, res, path, requireDevice) {
    if (path === "/aru/v1/backups/settings" && req.method === "GET") {
      requireDevice();
      sendJSON(res, 200, publicSettings());
      return true;
    }
    if (path === "/aru/v1/backups/settings" && req.method === "PUT") {
      const device = requireDevice();
      const body = await readJSONBody(req, 64 * 1024);
      updateSettings(body, device);
      sendJSON(res, 200, publicSettings());
      return true;
    }
    return false;
  }

  function updateSettings(body, device) {
    if (body?.schema !== BACKUP_SETTINGS_SCHEMA) {
      throw new HttpError(400, "backup.settings_schema_unsupported", "unsupported backup settings schema");
    }
    if (!Number.isSafeInteger(body.expectedRevision)) {
      throw new HttpError(400, "backup.expected_revision_required", "expectedRevision required");
    }
    if (body.expectedRevision !== state.backupSettings.revision) {
      throw new HttpError(409, "backup.revision_conflict", "backup settings changed since they were read");
    }
    const retentionMode = body.retentionMode;
    if (!["keep-all", "keep-latest"].includes(retentionMode)) {
      throw new HttpError(400, "backup.retention_mode_invalid", "retentionMode must be keep-all or keep-latest");
    }
    const keepLatestCount = retentionMode === "keep-latest"
      ? requiredKeepLatestCount(body.keepLatestCount)
      : null;
    const changed = retentionMode !== state.backupSettings.retentionMode
      || keepLatestCount !== state.backupSettings.keepLatestCount;
    if (changed) {
      state.backupSettings = {
        ...state.backupSettings,
        schema: BACKUP_SETTINGS_SCHEMA,
        retentionMode,
        keepLatestCount,
        revision: state.backupSettings.revision + 1,
        updatedAt: now(),
        updatedByDeviceId: device.deviceId,
      };
    }
    applyRetention(`settings:${device.deviceId}`);
    if (changed) log(`backup settings updated by ${device.deviceId}`);
    return publicSettings();
  }

  function requiredKeepLatestCount(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new HttpError(400, "backup.keep_latest_count_invalid", "keepLatestCount must be an integer of at least 1");
    }
    return value;
  }

  function applyRetention(actor = "retention-policy") {
    const settings = state.backupSettings;
    let deletedCount = 0;
    if (settings.retentionMode === "keep-latest") {
      const overflow = [...state.packages]
        .sort((left, right) => right.uploadedAt - left.uploadedAt
          || left.remotePackageId.localeCompare(right.remotePackageId))
        .slice(settings.keepLatestCount);
      for (const entry of overflow) {
        deletePackage(entry.remotePackageId, actor);
        deletedCount += 1;
      }
    }
    settings.lastAppliedAt = now();
    settings.lastDeletedCount = deletedCount;
    saveState();
    if (deletedCount > 0) log(`backup retention deleted ${deletedCount} package(s) actor=${actor}`);
    return { settings: publicSettings(), deletedCount };
  }

  return {
    route,
    publicSettings,
    updateSettings,
    applyRetention,
    manifestCapability,
  };
}
