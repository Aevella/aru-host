import { randomUUID, createHash } from "node:crypto";
import { createWriteStream, createReadStream, existsSync, renameSync, unlinkSync, statSync, openSync, closeSync, readSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { once } from "node:events";
export function createBackupVault({ config, state, saveState, sendJSON, HttpError, log, applyRetention, ENCRYPTED_PACKAGE_CONTENT_TYPE, ENCRYPTED_PACKAGE_MAGIC, ENCRYPTED_PACKAGE_VERSION, ENVELOPE_FORMAT, MAX_ENCRYPTED_PACKAGE_CHUNK_BYTES, MAX_ENCRYPTED_PACKAGE_HEADER_BYTES, VAULT_METADATA_SCHEMA }) {
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
    applyRetention(`upload:${device.deviceId}`);
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
  // The Host stores opaque ciphertext; archive reader compatibility belongs to
  // the restoring client, not this encrypted-container validator.
  if (!inner || typeof inner !== "object" || Array.isArray(inner) ||
      inner.archiveFormat !== "polaris-native-archive" ||
      !Number.isSafeInteger(inner.archiveVersion) || inner.archiveVersion < 1 ||
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


return { handleUpload, inventory, handleDownload, handleDelete, deleteBackupPackage };
}
