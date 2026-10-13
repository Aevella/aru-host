import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";

// Each acknowledged piece is an atomically published file. Metadata never claims
// bytes that have not landed. The complete-file owner retains MIME/hash admission.
export function createAttachmentChunkTransfer({ HttpError, recordDirectory, loadAttachment,
  saveAttachment, now, complete, project }) {
  const chunkSize = 256 * 1024;
  const active = new Set();
  const path = (record, index) => join(recordDirectory(record), `part-${index}`);
  const count = (record) => Math.ceil(record.byteCount / chunkSize);
  const length = (record, index) => Math.min(chunkSize, record.byteCount - index * chunkSize);
  function projection(record) {
    const received = [];
    if (record.state === "uploading") {
      for (let i = 0; i < count(record); i++) {
        if (existsSync(path(record, i)) && statSync(path(record, i)).size === length(record, i)) received.push(i);
      }
    }
    return { ...project(record), upload: { version: 1, chunkSize, received } };
  }
  async function route(req, res, { suffix, collaboratorId, conversationId, device, sendJSON }) {
    const match = suffix.match(/^\/attachments\/([A-Za-z0-9_-]+)\/(upload|complete|chunks\/(\d+))$/);
    if (!match) return false;
    const record = loadAttachment(collaboratorId, conversationId, match[1]);
    if (record.createdByDeviceId !== device.deviceId) throw new HttpError(403, "attachment.owner", "upload belongs to another device");
    if (match[2] === "upload" && req.method === "GET") {
      sendJSON(res, 200, projection(record)); return true;
    }
    if (!((match[3] !== undefined && req.method === "PUT") || (match[2] === "complete" && req.method === "POST"))) return false;
    if (active.has(record.attachmentId)) throw new HttpError(409, "attachment.busy", "upload is already receiving bytes");
    active.add(record.attachmentId);
    try {
      if (record.state === "ready") { req.resume?.(); sendJSON(res, 200, projection(record)); return true; }
      if (record.state !== "uploading") throw new HttpError(409, "attachment.state_invalid", "attachment is not accepting content");
      if (match[3] !== undefined) {
        const index = Number(match[3]);
        if (!Number.isSafeInteger(index) || index < 0 || index >= count(record)) throw new HttpError(400, "attachment.chunk_index", "invalid chunk index");
        const buffers = []; let size = 0;
        for await (const value of req) {
          const bytes = Buffer.from(value); size += bytes.length;
          if (size > length(record, index)) throw new HttpError(413, "attachment.chunk_size", "chunk exceeds admitted size");
          buffers.push(bytes);
        }
        if (size !== length(record, index)) throw new HttpError(400, "attachment.chunk_size", "incomplete chunk");
        const bytes = Buffer.concat(buffers);
        // Deletion while receiving must never recreate the upload directory.
        loadAttachment(collaboratorId, conversationId, record.attachmentId);
        const destination = path(record, index);
        if (existsSync(destination)) {
          if (!readFileSync(destination).equals(bytes)) throw new HttpError(409, "attachment.chunk_conflict", "chunk retry contains different bytes");
        } else {
          const temporary = `${destination}.${randomUUID()}.tmp`;
          try {
            writeFileSync(temporary, bytes, { mode: 0o600 });
            const descriptor = openSync(temporary, "r");
            try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
            renameSync(temporary, destination);
          }
          finally { rmSync(temporary, { force: true }); }
        }
        record.updatedAt = now(); saveAttachment(record);
        sendJSON(res, 200, projection(record)); return true;
      }
      if (projection(record).upload.received.length !== count(record)) throw new HttpError(409, "attachment.incomplete", "upload has missing chunks");
      const stream = (async function* () { for (let i = 0; i < count(record); i++) yield readFileSync(path(record, i)); })();
      let result;
      try { result = await complete(stream, record); }
      catch (error) {
        // The final-content owner rejects corrupt bytes. Allow a retry to repair
        // those pieces instead of repeatedly finalizing the same corrupt upload.
        if (error.code === "attachment.sha256_mismatch") {
          for (let i = 0; i < count(record); i++) rmSync(path(record, i), { force: true });
        }
        throw error;
      }
      for (let i = 0; i < count(record); i++) rmSync(path(record, i), { force: true });
      sendJSON(res, 200, result); return true;
    } finally { active.delete(record.attachmentId); }
  }
  async function exclusive(record, operation) {
    if (active.has(record.attachmentId)) throw new HttpError(409, "attachment.busy", "upload is already receiving bytes");
    active.add(record.attachmentId);
    try { return await operation(); } finally { active.delete(record.attachmentId); }
  }
  return { route, projection, exclusive };
}
