import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
export function createArtifactVault({ config, state, saveState, sendJSON, HttpError, log, sha256Hex, ARTIFACT_EXTENSIONS, ARTIFACT_METADATA_SCHEMA }) {
function persistWorkspaceArtifacts(binaryFiles, run, device, jobId = null) {
  if (binaryFiles.length === 0) return [];
  const metadata = binaryFiles.map(({ path, data }) => persistDirectArtifact({
    filename: path,
    mimeType: mimeTypeForArtifactPath(path),
    data,
    producer: {
        kind: "workspace-run",
        runId: run.runId,
        projectId: run.projectId,
        runtime: run.runtime,
        jobId,
    },
  }, device, false));
  saveState();
  return metadata;
}

function persistDirectArtifact({ filename, mimeType, data, producer }, device, persist = true) {
  if (!Buffer.isBuffer(data)) {
    throw new HttpError(500, "artifact.bytes_invalid", "artifact publication requires binary data");
  }
  const sha256 = sha256Hex(data);
  const artifactId = `artifact_${randomUUID()}`;
  const blobPath = join(config.dataDir, "artifacts", sha256);
  if (!existsSync(blobPath)) writeFileSync(blobPath, data, { mode: 0o600 });
  const entry = {
    schema: ARTIFACT_METADATA_SCHEMA,
    artifactId,
    filename,
    mimeType,
    byteCount: data.length,
    sha256,
    createdAt: Date.now(),
    producer,
    downloadPath: `/aru/v1/artifacts/${encodeURIComponent(artifactId)}`,
    deletedAt: null,
    createdByDeviceId: device.deviceId,
  };
  state.artifacts.push(entry);
  if (persist) saveState();
  return publicArtifactMetadata(entry);
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


return { persistWorkspaceArtifacts, persistDirectArtifact, artifactInventory, handleArtifactDownload, handleArtifactDelete, deleteArtifact, artifactExtension, languageForWorkspacePath };
}
