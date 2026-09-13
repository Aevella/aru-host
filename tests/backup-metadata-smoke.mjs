import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [baseURL, credential, fixturePath] = process.argv.slice(2);
const fixture = readFileSync(fixturePath);
const headerLength = fixture.readUInt32BE(8);
const original = JSON.parse(fixture.subarray(12, 12 + headerLength));
const chunks = fixture.subarray(12 + headerLength);
let sequence = 0;
async function check(metadata, expectedStatus, expectedCode) {
  const header = Buffer.from(JSON.stringify({ ...original, metadata }));
  const prefix = Buffer.from(fixture.subarray(0, 12));
  prefix.writeUInt32BE(header.length, 8);
  const bytes = Buffer.concat([prefix, header, chunks]);
  const response = await fetch(`${baseURL}/aru/v1/backups`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/vnd.aru.encrypted-backup",
      "x-aru-node-id": "smoke-node",
      "x-aru-server-id": "smoke-server",
      "x-aru-vault-package-id": `metadata-smoke-${++sequence}`,
      "x-aru-vault-package-sha256": createHash("sha256").update(bytes).digest("hex"),
    },
    body: bytes,
  });
  const body = await response.json();
  if (expectedStatus === 200) {
    assert.ok(response.ok, `valid archive version ${metadata.archiveVersion}: ${response.status}`);
    const download = await fetch(`${baseURL}/aru/v1/backups/${body.remotePackageId}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    const removed = await fetch(`${baseURL}/aru/v1/backups/${body.remotePackageId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${credential}` },
    });
    assert.ok(removed.ok);
  } else {
    assert.equal(response.status, expectedStatus);
    assert.equal(body.error, expectedCode);
  }
}
// The vault does not decrypt the synthetic ciphertext. It must preserve both
// legacy and newer archive metadata without claiming it can import that archive.
for (const archiveVersion of [1, 14, 15]) {
  await check({ ...original.metadata, archiveVersion }, 200);
}
for (const archiveVersion of [0, -1, 1.5, "14", null, Number.MAX_SAFE_INTEGER + 1]) {
  await check({ ...original.metadata, archiveVersion }, 400, "package.invalid_metadata");
}
for (const metadata of [null, [], "metadata", { ...original.metadata, archiveVersion: undefined },
  { ...original.metadata, archiveFormat: "other" },
  ...[0, -1, 1.5, "18"].map(plaintextByteCount => ({ ...original.metadata, plaintextByteCount }))]) {
  await check(metadata, 400, "package.invalid_metadata");
}
await check({ ...original.metadata, plaintextByteCount: original.chunkByteCount + 1 }, 400, "package.invalid_length");
console.log("backup metadata HTTP regression passed");
