import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createCollaboratorConversationAttachmentHost } from "../src/conversations/attachments.mjs";
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "attachment-chunks-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const options = { dataDir, HttpError, readJSONBody: async req => req.body,
    sendJSON: (res, status, body) => Object.assign(res, { status, body }) };
  let host = createCollaboratorConversationAttachmentHost(options);
  const bytes = Buffer.alloc(600000, 42);
  async function call(method, suffix, body, deviceId = "phone") {
    const req = body instanceof Buffer ? Readable.from([body]) : body?.[Symbol.asyncIterator] ? body : { body };
    req.method = method; req.headers = {};
    const res = {};
    assert.equal(await host.route(req, res, { suffix, collaboratorId: "col", conversationId: "conv",
      device: { deviceId }, conversation: { messages: [] } }), true);
    return res.body;
  }
  const admit = () => call("POST", "/attachments", { clientUploadId: "draft", filename: "data.bin",
    mimeType: "application/octet-stream", kind: "file", byteCount: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") });
  return { bytes, call, admit, dataDir, restart: () => { host = createCollaboratorConversationAttachmentHost(options); } };
}
test("lost receipts and restart retain pieces and completion identity", async t => {
  const f = fixture(t); const a = await f.admit(); const root = `/attachments/${a.attachmentId}`;
  await f.call("PUT", `${root}/chunks/0`, f.bytes.subarray(0, 262144));
  f.restart();
  const retry = await f.admit(); assert.equal(retry.attachmentId, a.attachmentId);
  assert.deepEqual(retry.upload.received, [0]);
  await f.call("PUT", `${root}/chunks/0`, f.bytes.subarray(0, 262144));
  await assert.rejects(f.call("POST", `${root}/complete`), e => e.code === "attachment.incomplete");
  await f.call("PUT", `${root}/chunks/1`, f.bytes.subarray(262144, 524288));
  await f.call("PUT", `${root}/chunks/2`, f.bytes.subarray(524288));
  const done = await f.call("POST", `${root}/complete`); assert.equal(done.state, "ready");
  f.restart(); assert.equal((await f.call("POST", `${root}/complete`)).state, "ready");
  assert.deepEqual(readFileSync(join(f.dataDir, "collaborator-conversation-attachments", "col", "conv", a.attachmentId, "content.bin")), f.bytes);
});
test("bad chunks, wrong device, and deletion do not become ready", async t => {
  const f = fixture(t); const a = await f.admit(); const root = `/attachments/${a.attachmentId}`;
  await assert.rejects(f.call("PUT", `${root}/chunks/0`, Buffer.alloc(2)), e => e.code === "attachment.chunk_size");
  await assert.rejects(f.call("GET", `${root}/upload`, undefined, "other"), e => e.status === 403);
  assert.deepEqual((await f.admit()).upload.received, []);
  await f.call("PUT", `${root}/chunks/0`, f.bytes.subarray(0, 262144));
  await assert.rejects(f.call("PUT", `${root}/chunks/0`, Buffer.alloc(262144, 1)), e => e.code === "attachment.chunk_conflict");
  await f.call("DELETE", root);
  await assert.rejects(f.call("PUT", `${root}/chunks/1`, f.bytes.subarray(262144, 524288)), e => e.status === 404);
  assert.notEqual((await f.admit()).attachmentId, a.attachmentId);
});
test("whole-file integrity failure clears pieces for repair", async t => {
  const f = fixture(t); const a = await f.admit(); const root = `/attachments/${a.attachmentId}`;
  for (let i = 0; i < 3; i++) await f.call("PUT", `${root}/chunks/${i}`, Buffer.alloc(Math.min(262144, f.bytes.length - i * 262144), 1));
  await assert.rejects(f.call("POST", `${root}/complete`), e => e.code === "attachment.sha256_mismatch");
  assert.deepEqual((await f.admit()).upload.received, []);
});

test("deleting an in-flight chunk cannot resurrect the upload", async t => {
  const f = fixture(t); const a = await f.admit(); const root = `/attachments/${a.attachmentId}`;
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entering = new Promise(resolve => { started = resolve; });
  const stream = (async function* () { started(); await gate; yield f.bytes.subarray(0, 262144); })();
  const pending = f.call("PUT", `${root}/chunks/0`, stream);
  await entering;
  await assert.rejects(f.call("PUT", `${root}/chunks/1`, f.bytes.subarray(262144, 524288)), e => e.code === "attachment.busy");
  await f.call("DELETE", root); release();
  await assert.rejects(pending, e => e.status === 404);
  f.restart();
  await assert.rejects(f.call("GET", `${root}/upload`), e => e.status === 404);
});
