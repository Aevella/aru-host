import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { once } from "node:events";

const ATTACHMENT_SCHEMA = "aru.selfhost.collaborator-conversation-attachment.v1";
const ID = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIME = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const KINDS = new Set(["image", "file", "audio", "video"]);
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 8;

export function createCollaboratorConversationAttachmentHost({
  dataDir,
  readJSONBody,
  sendJSON,
  HttpError,
  now = Date.now,
  maximumAttachmentBytes = MAX_ATTACHMENT_BYTES,
}) {
  const root = join(dataDir, "collaborator-conversation-attachments");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  cleanupUnbound();

  async function route(req, res, { suffix, collaboratorId, conversationId, device, conversation }) {
    if (suffix === "/attachments" && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 201, createUpload(collaboratorId, conversationId, body, device));
      return true;
    }
    const match = suffix.match(/^\/attachments\/([^/]+)(\/content)?$/);
    if (!match) return false;
    const attachmentId = validatedId(match[1], "attachment");
    const record = loadAttachment(collaboratorId, conversationId, attachmentId);
    if (match[2] === "/content" && req.method === "PUT") {
      sendJSON(res, 200, await receiveContent(req, record));
      return true;
    }
    if (match[2] === "/content" && req.method === "GET") {
      sendContent(res, record);
      return true;
    }
    if (!match[2] && req.method === "DELETE") {
      if (record.messageId || conversation.messages.some((message) =>
        (message.attachments ?? []).some((attachment) => attachment.attachmentId === attachmentId))) {
        throw new HttpError(409, "attachment.bound", "bound attachment cannot be deleted independently");
      }
      rmSync(recordDirectory(record), { recursive: true, force: true });
      sendJSON(res, 200, { schema: ATTACHMENT_SCHEMA, attachmentId, deleted: true });
      return true;
    }
    return false;
  }

  function createUpload(collaboratorId, conversationId, body, device) {
    const input = validatedUpload(body, maximumAttachmentBytes);
    const existing = attachmentsForConversation(collaboratorId, conversationId)
      .find((record) => record.clientUploadId === input.clientUploadId);
    if (existing) {
      if (!sameUpload(existing, input)) {
        throw new HttpError(409, "attachment.upload_identity_conflict", "clientUploadId already owns different bytes");
      }
      return publicAttachment(existing);
    }
    const timestamp = now();
    const record = {
      schema: ATTACHMENT_SCHEMA,
      attachmentId: `hostatt_${randomUUID()}`,
      clientUploadId: input.clientUploadId,
      collaboratorId,
      conversationId,
      messageId: null,
      kind: input.kind,
      filename: input.filename,
      mimeType: input.mimeType,
      byteCount: input.byteCount,
      sha256: input.sha256,
      state: "uploading",
      createdAt: timestamp,
      updatedAt: timestamp,
      createdByDeviceId: device.deviceId,
      boundAt: null,
    };
    saveAttachment(record);
    return publicAttachment(record);
  }

  async function receiveContent(req, record) {
    if (record.state === "ready" || record.state === "bound") return publicAttachment(record);
    if (record.state !== "uploading") {
      throw new HttpError(409, "attachment.state_invalid", "attachment is not accepting content");
    }
    const contentLength = Number(req.headers?.["content-length"] ?? record.byteCount);
    if (!Number.isSafeInteger(contentLength) || contentLength !== record.byteCount) {
      throw new HttpError(400, "attachment.byte_count_mismatch", "uploaded byte count does not match admission metadata");
    }
    const directory = recordDirectory(record);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `content.${randomUUID()}.tmp`);
    const destination = contentPath(record);
    const hash = createHash("sha256");
    const writer = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    let byteCount = 0;
    try {
      for await (const value of req) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        byteCount += chunk.length;
        if (byteCount > record.byteCount || byteCount > maximumAttachmentBytes) {
          throw new HttpError(413, "attachment.too_large", "attachment exceeds its admitted size");
        }
        hash.update(chunk);
        if (!writer.write(chunk)) await once(writer, "drain");
      }
      writer.end();
      await once(writer, "finish");
      if (byteCount !== record.byteCount) {
        throw new HttpError(400, "attachment.byte_count_mismatch", "uploaded byte count does not match admission metadata");
      }
      if (hash.digest("hex") !== record.sha256) {
        throw new HttpError(422, "attachment.sha256_mismatch", "uploaded bytes failed integrity validation");
      }
      validateDeclaredMIME(temporary, record.mimeType, record.kind, HttpError);
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
      record.state = "ready";
      record.updatedAt = now();
      saveAttachment(record);
      return publicAttachment(record);
    } catch (error) {
      writer.destroy();
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  function prepareMessageAttachments(conversation, attachmentIds, driver) {
    const ids = validatedAttachmentIds(attachmentIds);
    const records = ids.map((attachmentId) =>
      loadAttachment(conversation.collaboratorId, conversation.conversationId, attachmentId));
    for (const record of records) {
      if (!existsSync(contentPath(record)) || !["ready", "bound"].includes(record.state)) {
        throw new HttpError(409, "attachment.not_ready", `${record.filename} has not finished uploading`);
      }
      if (record.messageId) {
        throw new HttpError(409, "attachment.already_bound", `${record.filename} already belongs to another message`);
      }
    }
    driver.validateAttachments?.(records.map(publicAttachment));
    return records.map((record) => ({ ...publicAttachment(record), state: "bound" }));
  }

  function commitMessageBindings(conversation, message) {
    for (const attachment of message.attachments ?? []) {
      const record = loadAttachment(
        conversation.collaboratorId,
        conversation.conversationId,
        attachment.attachmentId,
      );
      if (record.messageId && record.messageId !== message.messageId) continue;
      record.messageId = message.messageId;
      record.state = "bound";
      record.boundAt ??= now();
      record.updatedAt = now();
      saveAttachment(record);
    }
  }

  function reconcileConversation(conversation) {
    for (const message of conversation.messages ?? []) {
      try { commitMessageBindings(conversation, message); }
      catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
  }

  function cleanupUnbound(maximumAgeMilliseconds = 7 * 24 * 60 * 60 * 1000) {
    if (!existsSync(root)) return;
    for (const collaboratorId of readdirSync(root)) {
      if (!ID.test(collaboratorId)) continue;
      const collaboratorDirectory = join(root, collaboratorId);
      for (const conversationId of readdirSync(collaboratorDirectory)) {
        if (!ID.test(conversationId)) continue;
        for (const record of attachmentsForConversation(collaboratorId, conversationId)) {
          if (!record.messageId && now() - record.updatedAt > maximumAgeMilliseconds) {
            rmSync(recordDirectory(record), { recursive: true, force: true });
          }
        }
      }
    }
  }

  function projectForWorkspace(attachments, workspace) {
    return (attachments ?? []).map((attachment) => {
      const record = loadAttachment(
        attachment.collaboratorId,
        attachment.conversationId,
        attachment.attachmentId,
      );
      const inbox = join(workspace, ".aru", "inbox", record.attachmentId);
      mkdirSync(inbox, { recursive: true, mode: 0o700 });
      const destination = join(inbox, safeFilename(record.filename));
      if (!existsSync(destination)) {
        copyFileSync(contentPath(record), destination);
        chmodSync(destination, 0o600);
      }
      return { ...publicAttachment(record), path: destination };
    });
  }

  function admitAssistantFile({ conversation, messageId, workspace, path, filename, mimeType }) {
    const source = validatedWorkspaceFile(workspace, path);
    const stat = statSync(source);
    if (stat.size > maximumAttachmentBytes) {
      throw new Error(`附件超过 ${Math.floor(maximumAttachmentBytes / (1024 * 1024))} MB`);
    }
    const bytes = readFileSync(source);
    const timestamp = now();
    const inferredFilename = safeFilename(filename || basename(source));
    const inferredMIME = validatedMimeType(mimeType || mimeTypeForPath(inferredFilename));
    const record = {
      schema: ATTACHMENT_SCHEMA,
      attachmentId: `hostatt_${randomUUID()}`,
      clientUploadId: null,
      collaboratorId: conversation.collaboratorId,
      conversationId: conversation.conversationId,
      messageId,
      kind: kindForMIME(inferredMIME),
      filename: inferredFilename,
      mimeType: inferredMIME,
      byteCount: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      state: "bound",
      createdAt: timestamp,
      updatedAt: timestamp,
      createdByDeviceId: `hosted-collaborator:${conversation.collaboratorId}`,
      boundAt: timestamp,
    };
    mkdirSync(recordDirectory(record), { recursive: true, mode: 0o700 });
    writeFileSync(contentPath(record), bytes, { mode: 0o600 });
    saveAttachment(record);
    return publicAttachment(record);
  }

  function status() {
    let attachmentCount = 0;
    let unboundAttachmentCount = 0;
    if (existsSync(root)) {
      for (const collaboratorId of readdirSync(root)) {
        if (!ID.test(collaboratorId)) continue;
        for (const conversationId of readdirSync(join(root, collaboratorId))) {
          if (!ID.test(conversationId)) continue;
          for (const record of attachmentsForConversation(collaboratorId, conversationId)) {
            attachmentCount += 1;
            if (!record.messageId) unboundAttachmentCount += 1;
          }
        }
      }
    }
    return { attachmentCount, unboundAttachmentCount };
  }

  return {
    route,
    prepareMessageAttachments,
    commitMessageBindings,
    reconcileConversation,
    projectForWorkspace,
    admitAssistantFile,
    cleanupUnbound,
    status,
  };

  function sendContent(res, record) {
    if (!existsSync(contentPath(record))) {
      throw new HttpError(410, "attachment.bytes_missing", "attachment metadata exists but bytes are missing");
    }
    res.writeHead(200, {
      "content-type": record.mimeType,
      "content-length": String(record.byteCount),
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    });
    createReadStream(contentPath(record)).pipe(res);
  }

  function attachmentsForConversation(collaboratorId, conversationId) {
    const directory = conversationDirectory(collaboratorId, conversationId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => ID.test(name))
      .map((attachmentId) => {
        try { return loadAttachment(collaboratorId, conversationId, attachmentId); }
        catch { return null; }
      })
      .filter(Boolean);
  }

  function loadAttachment(collaboratorId, conversationId, attachmentId) {
    const path = metadataPath({ collaboratorId, conversationId, attachmentId });
    if (!existsSync(path)) throw new HttpError(404, "attachment.unknown", "unknown conversation attachment");
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new HttpError(500, "attachment.unreadable", "attachment metadata is unreadable"); }
  }

  function saveAttachment(record) {
    const directory = recordDirectory(record);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = metadataPath(record);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }

  function conversationDirectory(collaboratorId, conversationId) {
    return join(root, validatedId(collaboratorId, "collaborator"), validatedId(conversationId, "conversation"));
  }

  function recordDirectory(record) {
    return join(conversationDirectory(record.collaboratorId, record.conversationId), validatedId(record.attachmentId, "attachment"));
  }

  function metadataPath(record) { return join(recordDirectory(record), "metadata.json"); }
  function contentPath(record) { return join(recordDirectory(record), "content.bin"); }
}

function validatedUpload(body, maximumAttachmentBytes) {
  const clientUploadId = validatedId(body?.clientUploadId, "clientUpload");
  const filename = safeFilename(body?.filename);
  const mimeType = validatedMimeType(body?.mimeType);
  const kind = String(body?.kind ?? "file");
  if (!KINDS.has(kind)) throw new Error("attachment kind is invalid");
  const byteCount = Number(body?.byteCount);
  if (!Number.isSafeInteger(byteCount) || byteCount < 1 || byteCount > maximumAttachmentBytes) {
    throw new Error("attachment byteCount is invalid");
  }
  const sha256 = String(body?.sha256 ?? "").toLowerCase();
  if (!SHA256.test(sha256)) throw new Error("attachment sha256 is invalid");
  if (kind !== "file" && !mimeType.startsWith(`${kind}/`)) {
    throw new Error("attachment kind does not match mimeType");
  }
  return { clientUploadId, filename, mimeType, kind, byteCount, sha256 };
}

function validateDeclaredMIME(path, mimeType, kind, HttpError) {
  const bytes = readFileSync(path).subarray(0, 16);
  const ascii = bytes.toString("ascii");
  const hex = bytes.toString("hex");
  const matches = {
    "application/pdf": ascii.startsWith("%PDF-"),
    "image/png": hex.startsWith("89504e470d0a1a0a"),
    "image/jpeg": hex.startsWith("ffd8ff"),
    "image/gif": ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a"),
    "image/webp": ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP",
  }[mimeType];
  if (matches === false || (kind === "image" && !mimeType.startsWith("image/"))) {
    throw new HttpError(422, "attachment.mime_mismatch", "uploaded bytes do not match the declared media type");
  }
}

function validatedAttachmentIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`a message accepts at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
  }
  const ids = value.map((item) => validatedId(item, "attachment"));
  if (new Set(ids).size !== ids.length) throw new Error("attachmentIds must be unique");
  return ids;
}

function sameUpload(record, input) {
  return record.filename === input.filename
    && record.mimeType === input.mimeType
    && record.kind === input.kind
    && record.byteCount === input.byteCount
    && record.sha256 === input.sha256;
}

function publicAttachment(record) {
  return {
    schema: ATTACHMENT_SCHEMA,
    attachmentId: record.attachmentId,
    collaboratorId: record.collaboratorId,
    conversationId: record.conversationId,
    messageId: record.messageId,
    kind: record.kind,
    filename: record.filename,
    mimeType: record.mimeType,
    byteCount: record.byteCount,
    sha256: record.sha256,
    state: record.state,
    createdAt: record.createdAt,
    downloadPath: `/aru/v1/hosted-collaborators/${encodeURIComponent(record.collaboratorId)}/conversations/${encodeURIComponent(record.conversationId)}/attachments/${encodeURIComponent(record.attachmentId)}/content`,
  };
}

function validatedWorkspaceFile(workspace, value) {
  const root = resolve(workspace);
  const candidate = resolve(root, String(value ?? ""));
  const difference = relative(root, candidate);
  if (!difference || difference === ".." || difference.startsWith("../") || isAbsolute(difference)) {
    throw new Error("只能附加当前协作者工作区里的文件");
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("只能附加普通文件，不能附加目录或符号链接");
  return candidate;
}

function safeFilename(value) {
  const name = basename(String(value ?? "").trim()).normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/:\\]+/g, "_")
    .slice(0, 180);
  if (!name || name === "." || name === "..") throw new Error("attachment filename is invalid");
  return name;
}

function validatedMimeType(value) {
  const mimeType = String(value ?? "application/octet-stream").trim().toLowerCase();
  if (!MIME.test(mimeType)) throw new Error("attachment mimeType is invalid");
  return mimeType;
}

function validatedId(value, kind) {
  const id = String(value ?? "");
  if (!ID.test(id)) throw new Error(`invalid ${kind} id`);
  return id;
}

function kindForMIME(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

function mimeTypeForPath(path) {
  return {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
    ".json": "application/json", ".csv": "text/csv", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
    ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime", ".zip": "application/zip",
  }[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export { ATTACHMENT_SCHEMA, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE };
