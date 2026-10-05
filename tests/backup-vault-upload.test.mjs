import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createBackupVault } from "../src/server/backup-vault.mjs";

test("v2 uploads retain injected Host identity and protect the newly verified package", async t => {
  const root = mkdtempSync(join(tmpdir(), "aru-backup-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "packages"));
  const header = Buffer.from(JSON.stringify({ format: "aru-native-encrypted-package", version: 2,
    algorithm: "AES-256-GCM-CHUNKED", kdf: "PBKDF2-HMAC-SHA256", kdfIterations: 120000,
    saltHex: "01".repeat(16), noncePrefixHex: "02".repeat(8), chunkByteCount: 1048576, chunkCount: 1,
    metadata: { archiveFormat: "polaris-native-archive", archiveVersion: 1, plaintextByteCount: 1 } }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const chunkLength = Buffer.alloc(4); chunkLength.writeUInt32BE(1);
  const bytes = Buffer.concat([Buffer.from("ARUEPKG2"), length, header, chunkLength, Buffer.alloc(1), Buffer.alloc(16)]);
  const req = Readable.from([bytes]);
  req.headers = { "x-aru-vault-package-sha256": createHash("sha256").update(bytes).digest("hex"), "x-aru-vault-package-id": "synthetic-package" };
  const state = { serverId: "synthetic-server", packages: [] };
  let response, retained;
  const vault = createBackupVault({ config: { dataDir: root, maxPackageBytes: 1048576 }, state,
    displayName: () => "Synthetic Host", saveState: () => {}, sendJSON: (_res, _status, body) => { response = body; },
    HttpError: Error, log: () => {}, applyRetention: (_actor, id) => { retained = id; },
    ENCRYPTED_PACKAGE_CONTENT_TYPE: "application/vnd.aru.encrypted-backup", ENCRYPTED_PACKAGE_MAGIC: Buffer.from("ARUEPKG2"),
    ENCRYPTED_PACKAGE_VERSION: 2, ENVELOPE_FORMAT: "aru-native-encrypted-package", MAX_ENCRYPTED_PACKAGE_CHUNK_BYTES: 16 * 1024 * 1024,
    MAX_ENCRYPTED_PACKAGE_HEADER_BYTES: 1024 * 1024, VAULT_METADATA_SCHEMA: "aru.selfhost.backup-package-metadata.v1" });
  await vault.handleUpload(req, {}, { deviceId: "synthetic-device" });
  assert.equal(state.packages[0].metadata.serverId, "synthetic-server");
  assert.equal(state.packages[0].metadata.displayName, "Synthetic Host");
  assert.equal(response.remotePackageId, retained);
});
