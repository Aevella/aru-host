import { createHash } from "node:crypto";
import { createBackupSnapshotStore } from "./backup-snapshot-store.mjs";
import { join } from "node:path";

export function createBackupSnapshotRoutes({ config, serverId, sendJSON, HttpError, applyRetention }) {
  let snapshotStore;
  const store = () => snapshotStore ??= createBackupSnapshotStore({ directory: join(config.dataDir, "backup-snapshots") });
  const base = "/aru/v1/backups/snapshots";
  const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  async function body(req, maximum) {
    const parts = [];
    let length = 0;
    for await (const part of req) {
      length += part.length;
      if (length > maximum) throw new HttpError(413, "snapshot.body_too_large", "snapshot request exceeds format budget");
      parts.push(part);
    }
    return Buffer.concat(parts, length);
  }
  function publicRecord(record) {
    return { remotePackageId: record.id, uploadedAt: record.publishedAt, metadata: record.metadata };
  }
  function remove(id) {
    try { store().remove(id); }
    catch (error) {
      if (error.message === "backup.snapshot.unknown") throw new HttpError(404, "package.unknown", "unknown package");
      throw error;
    }
    return { remotePackageId: id, deleted: true, deletedAt: Date.now() };
  }
  function inventory() { return { packages: store().inventory().map(publicRecord) }; }
  function sendBytes(res, bytes) {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
    res.end(bytes);
  }
  async function route(req, res, path, requireDevice) {
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const device = requireDevice(req);
    const parts = path.slice(base.length).split("/").filter(Boolean);
    if (parts.some((item) => !idPattern.test(item))) throw new HttpError(400, "snapshot.path_invalid", "invalid snapshot path");
    try {
      if (!parts.length && req.method === "GET") sendJSON(res, 200, inventory());
      else if (parts.length === 1 && parts[0] === "repository" && req.method === "GET") {
        sendJSON(res, 200, { ...store().repository(), serverId, batchRetain: true, snapshotVersion: 2 });
      } else if (parts.length === 1 && parts[0] === "drafts" && req.method === "POST") {
        sendJSON(res, 200, { id: store().begin(device.deviceId).id });
      } else if (parts.length === 2 && parts[1] === "retain" && req.method === "POST") {
        const ids = JSON.parse((await body(req, 1024 * 1024)).toString("utf8")).chunks;
        sendJSON(res, 200, { retained: store().retainChunks(parts[0], device.deviceId, ids).map(item => item.id) });
      } else if (parts.length === 3 && parts[1] === "chunks" && req.method === "POST") {
        const value = store().retainChunk(parts[0], device.deviceId, parts[2]);
        sendJSON(res, value ? 200 : 404, value ?? { missing: true });
      } else if (parts.length === 3 && parts[1] === "chunks" && req.method === "PUT") {
        const bytes = await body(req, 4 * 1024 * 1024 + 28);
        const value = store().putChunk(parts[0], device.deviceId, parts[2], bytes,
          String(req.headers["x-aru-vault-package-sha256"] ?? ""));
        sendJSON(res, 200, value);
      } else if (parts.length === 3 && parts[1] === "chunks" && req.method === "GET") {
        sendBytes(res, store().getChunk(parts[0], parts[2]));
      } else if (parts.length === 1 && req.method === "POST") {
        const bytes = await body(req, 256 * 1024 * 1024);
        if (hash(bytes) !== req.headers["x-aru-vault-package-sha256"]) throw new Error("backup.snapshot.body_hash");
        const metadata = JSON.parse(Buffer.from(String(req.headers["x-aru-snapshot-metadata"] ?? ""), "base64").toString("utf8"));
        if (metadata.schema !== "aru.selfhost.backup-package-metadata.v1" || metadata.packageId !== parts[0]
            || metadata.serverId !== serverId || metadata.envelopeFormat !== "aru-native-backup-snapshot"
            || ![1, 2].includes(metadata.envelopeVersion) || metadata.packageSHA256Hex !== hash(bytes)
            || metadata.packageByteCount !== bytes.length || metadata.restorePolicy !== "manual-staging-only"
            || metadata.encryptionMode !== "full-package-client-password") throw new Error("backup.snapshot.metadata_invalid");
        const record = await store().commit(parts[0], device.deviceId, bytes, metadata,
          (published) => applyRetention(`snapshot:${device.deviceId}`, published.id));
        store().collect();
        sendJSON(res, 200, { remotePackageId: record.id, uploadedAt: record.publishedAt });
      } else if (parts.length === 1 && req.method === "GET") sendBytes(res, store().manifest(parts[0]));
      else if (parts.length === 1 && req.method === "DELETE") {
        sendJSON(res, 200, remove(parts[0]));
      } else if (parts.length === 2 && parts[0] === "drafts" && req.method === "DELETE") {
        store().cancel(parts[1], device.deviceId);
        sendJSON(res, 200, { cancelled: true });
      } else throw new HttpError(404, "snapshot.route_unknown", "unknown snapshot route");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error.message === "backup.snapshot.deleted") throw new HttpError(410, "snapshot.deleted", "snapshot was explicitly deleted");
      if (error.code === "ENOENT") throw new HttpError(404, "snapshot.missing", "snapshot or chunk is unavailable");
      throw new HttpError(409, "snapshot.unavailable", "snapshot could not be validated or committed");
    }
    return true;
  }
  return { route, inventory, remove };
}
