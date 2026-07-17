import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SURFACE_INVENTORY_SCHEMA = "aru.selfhost.collaborator-surface-inventory.v1";
const SURFACE_SCHEMA = "aru.selfhost.collaborator-surface.v1";
const SURFACE_VERSION_SCHEMA = "aru.selfhost.collaborator-surface-version.v1";
const SURFACE_EVENT_INVENTORY_SCHEMA = "aru.selfhost.collaborator-surface-event-inventory.v1";

export function createCollaboratorSurfaceHost({
  dataDir,
  readJSONBody,
  sendJSON,
  HttpError,
  now = Date.now,
}) {
  const root = join(dataDir, "collaborator-surfaces");
  mkdirSync(root, { recursive: true });

  async function route(req, res, path, requireDevice, collaboratorForId) {
    const inventoryMatch = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/surfaces$/,
    );
    if (inventoryMatch) {
      const collaborator = collaboratorForId(inventoryMatch[1]);
      const device = requireDevice();
      if (req.method === "GET") {
        sendJSON(res, 200, inventory(collaborator.collaboratorId));
        return true;
      }
      if (req.method === "POST") {
        const body = await readJSONBody(req, 32 * 1024 * 1024);
        sendJSON(res, 201, createSurface(collaborator.collaboratorId, body, device));
        return true;
      }
      return false;
    }

    const versionMatch = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/surfaces\/([^/]+)\/versions\/([^/]+)$/,
    );
    if (versionMatch && req.method === "GET") {
      const collaborator = collaboratorForId(versionMatch[1]);
      requireDevice();
      sendJSON(res, 200, version(collaborator.collaboratorId, versionMatch[2], versionMatch[3]));
      return true;
    }

    const eventsMatch = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/surfaces\/([^/]+)\/events$/,
    );
    if (eventsMatch) {
      const collaborator = collaboratorForId(eventsMatch[1]);
      const device = requireDevice();
      if (req.method === "GET") {
        sendJSON(res, 200, eventInventory(collaborator.collaboratorId, eventsMatch[2]));
        return true;
      }
      if (req.method === "POST") {
        const body = await readJSONBody(req, 1024 * 1024);
        sendJSON(res, 201, appendEvent(collaborator.collaboratorId, eventsMatch[2], body, device));
        return true;
      }
      return false;
    }

    const actionMatch = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/surfaces\/([^/]+)\/(state|rollback|archive|restore)$/,
    );
    if (actionMatch) {
      if (req.method !== "PUT" && req.method !== "POST") return false;
      const collaborator = collaboratorForId(actionMatch[1]);
      const device = requireDevice();
      const body = await readJSONBody(req, 32 * 1024 * 1024);
      const result = actionMatch[3] === "state"
        ? updateState(collaborator.collaboratorId, actionMatch[2], body, device)
        : actionMatch[3] === "rollback"
          ? rollback(collaborator.collaboratorId, actionMatch[2], body, device)
          : setArchived(collaborator.collaboratorId, actionMatch[2], actionMatch[3] === "archive", body, device);
      sendJSON(res, 200, result);
      return true;
    }

    const detailMatch = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/surfaces\/([^/]+)$/,
    );
    if (!detailMatch) return false;
    const collaborator = collaboratorForId(detailMatch[1]);
    const device = requireDevice();
    if (req.method === "GET") {
      sendJSON(res, 200, surface(collaborator.collaboratorId, detailMatch[2]));
      return true;
    }
    if (req.method === "PUT") {
      const body = await readJSONBody(req, 32 * 1024 * 1024);
      sendJSON(res, 200, publish(collaborator.collaboratorId, detailMatch[2], body, device));
      return true;
    }
    return false;
  }

  function inventory(collaboratorId) {
    return {
      schema: SURFACE_INVENTORY_SCHEMA,
      collaboratorId,
      surfaces: loadAll(collaboratorId)
        .map(publicSummary)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.surfaceId.localeCompare(right.surfaceId)),
    };
  }

  function surface(collaboratorId, surfaceId) {
    return publicSurface(loadSurface(collaboratorId, surfaceId));
  }

  function version(collaboratorId, surfaceId, versionId) {
    const record = loadSurface(collaboratorId, surfaceId);
    const found = record.versions.find((candidate) => candidate.versionId === validatedVersionId(versionId));
    if (!found) throw new HttpError(404, "surface.version_unknown", "unknown surface version");
    return publicVersion(found, true);
  }

  function createSurface(collaboratorId, body, device) {
    const timestamp = now();
    const sourceHTML = validatedSourceHTML(body.sourceHTML);
    const initialVersion = makeVersion(1, sourceHTML, body.note, timestamp, device);
    const record = {
      schema: SURFACE_SCHEMA,
      surfaceId: `surface_${randomUUID()}`,
      collaboratorId,
      title: validatedTitle(body.title),
      revision: 1,
      activeVersionId: initialVersion.versionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      stateJSON: "{}",
      stateRevision: 1,
      stateUpdatedAt: timestamp,
      versions: [initialVersion],
      events: [],
      nextEventSequence: 1,
      createdByDeviceId: device.deviceId,
      updatedByDeviceId: device.deviceId,
    };
    saveSurface(record);
    return publicSurface(record);
  }

  function publish(collaboratorId, surfaceId, body, device) {
    const record = loadSurface(collaboratorId, surfaceId);
    requireRevision(record, body.expectedRevision);
    if (record.archivedAt !== null) {
      throw new HttpError(409, "surface.archived", "archived surface must be restored before publishing");
    }
    if (body.sourceHTML === undefined && body.title === undefined) {
      throw new HttpError(400, "surface.no_changes", "sourceHTML or title required");
    }
    const timestamp = now();
    if (body.title !== undefined) record.title = validatedTitle(body.title);
    if (body.sourceHTML !== undefined) {
      const sourceHTML = validatedSourceHTML(body.sourceHTML);
      const active = activeVersion(record);
      if (active.sourceHTML !== sourceHTML || String(body.note ?? "").trim()) {
        const next = makeVersion(record.versions.length + 1, sourceHTML, body.note, timestamp, device);
        record.versions.push(next);
        record.activeVersionId = next.versionId;
      }
    }
    record.revision += 1;
    record.updatedAt = timestamp;
    record.updatedByDeviceId = device.deviceId;
    saveSurface(record);
    return publicSurface(record);
  }

  function rollback(collaboratorId, surfaceId, body, device) {
    const record = loadSurface(collaboratorId, surfaceId);
    requireRevision(record, body.expectedRevision);
    if (record.archivedAt !== null) {
      throw new HttpError(409, "surface.archived", "archived surface must be restored before rollback");
    }
    const targetId = validatedVersionId(body.versionId);
    const target = record.versions.find((candidate) => candidate.versionId === targetId);
    if (!target) throw new HttpError(404, "surface.version_unknown", "unknown surface version");
    const timestamp = now();
    const next = makeVersion(
      record.versions.length + 1,
      target.sourceHTML,
      body.note ?? `Rollback to version ${target.ordinal}`,
      timestamp,
      device,
    );
    next.restoredFromVersionId = target.versionId;
    record.versions.push(next);
    record.activeVersionId = next.versionId;
    record.revision += 1;
    record.updatedAt = timestamp;
    record.updatedByDeviceId = device.deviceId;
    saveSurface(record);
    return publicSurface(record);
  }

  function updateState(collaboratorId, surfaceId, body, device) {
    const record = loadSurface(collaboratorId, surfaceId);
    if (!Number.isSafeInteger(body.expectedStateRevision)) {
      throw new HttpError(400, "surface.expected_state_revision_required", "expectedStateRevision required");
    }
    if (body.expectedStateRevision !== record.stateRevision) {
      throw new HttpError(409, "surface.state_revision_conflict", "surface state changed since it was read");
    }
    record.stateJSON = normalizedStateJSON(body.stateJSON);
    record.stateRevision += 1;
    record.stateUpdatedAt = now();
    record.updatedByDeviceId = device.deviceId;
    saveSurface(record);
    return publicSurface(record);
  }

  function appendEvent(collaboratorId, surfaceId, body, device) {
    const record = loadSurface(collaboratorId, surfaceId);
    const eventType = String(body.type ?? "").trim();
    if (!eventType || /[\u0000-\u001f\u007f]/.test(eventType)) {
      throw new HttpError(400, "surface.event_type_invalid", "event type must be a printable string");
    }
    const payload = body.payload ?? {};
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new HttpError(400, "surface.event_payload_invalid", "event payload must be an object");
    }
    const event = {
      sequence: record.nextEventSequence,
      type: eventType,
      payload,
      createdAt: now(),
      deviceId: device.deviceId,
    };
    record.nextEventSequence += 1;
    record.events.push(event);
    saveSurface(record);
    return { schema: "aru.selfhost.collaborator-surface-event.v1", ...event };
  }

  function eventInventory(collaboratorId, surfaceId) {
    const record = loadSurface(collaboratorId, surfaceId);
    return {
      schema: SURFACE_EVENT_INVENTORY_SCHEMA,
      collaboratorId,
      surfaceId: record.surfaceId,
      events: record.events.map(({ deviceId: _, ...event }) => event),
    };
  }

  function setArchived(collaboratorId, surfaceId, archived, body, device) {
    const record = loadSurface(collaboratorId, surfaceId);
    requireRevision(record, body.expectedRevision);
    const timestamp = now();
    record.archivedAt = archived ? timestamp : null;
    record.revision += 1;
    record.updatedAt = timestamp;
    record.updatedByDeviceId = device.deviceId;
    saveSurface(record);
    return publicSurface(record);
  }

  function tools() {
    return surfaceTools(false);
  }

  function selfTools() {
    return surfaceTools(true);
  }

  function surfaceTools(selfScoped) {
    const operation = (name, title, description, properties, required, readOnlyHint = false) => ({
      name,
      title,
      description,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      outputSchema: { type: "object" },
      annotations: {
        readOnlyHint,
        destructiveHint: !readOnlyHint,
        idempotentHint: readOnlyHint,
        openWorldHint: false,
      },
    });
    const id = (description) => ({ type: "string", minLength: 1, description });
    const ownerProperties = selfScoped ? {} : { collaboratorId: id("Hosted collaborator id.") };
    const ownerRequired = selfScoped ? [] : ["collaboratorId"];
    const scope = selfScoped ? "your own" : "one computer collaborator's";
    return [
      operation("aru_collaborator_surface_inventory", "List collaborator surfaces", `List ${scope} persistent web surfaces.`, ownerProperties, ownerRequired, true),
      operation("aru_collaborator_surface_read", "Read collaborator surface", `Read ${scope} surface HTML, persistent state, version history, and runtime metadata.`, { ...ownerProperties, surfaceId: id("Surface id.") }, [...ownerRequired, "surfaceId"], true),
      operation("aru_collaborator_surface_publish", "Publish collaborator surface", `Create ${scope} persistent HTML/CSS/JavaScript surface, or publish a new immutable version when surfaceId and expectedRevision are supplied.`, {
        ...ownerProperties,
        surfaceId: id("Existing surface id; omit to create."),
        expectedRevision: { type: "integer", minimum: 1, description: "Required when updating an existing surface." },
        title: id("User-visible surface title."),
        sourceHTML: id("Complete HTML document with inline CSS and JavaScript."),
        note: { type: "string", description: "Optional version note." },
      }, [...ownerRequired, "title", "sourceHTML"]),
      operation("aru_collaborator_surface_events", "Read collaborator surface events", `Read durable typed interaction events sent from ${scope} phone surface.`, { ...ownerProperties, surfaceId: id("Surface id.") }, [...ownerRequired, "surfaceId"], true),
      operation("aru_collaborator_surface_rollback", "Roll back collaborator surface", `Publish a new version of ${scope} surface by restoring an earlier immutable version.`, {
        ...ownerProperties, surfaceId: id("Surface id."), versionId: id("Earlier version id."), expectedRevision: { type: "integer", minimum: 1 }, note: { type: "string" },
      }, [...ownerRequired, "surfaceId", "versionId", "expectedRevision"]),
    ];
  }

  function callTool(name, args, device, collaboratorForId) {
    if (!name.startsWith("aru_collaborator_surface_")) return { matched: false, value: null };
    const collaborator = collaboratorForId(requiredString(args, "collaboratorId"));
    return callOwnedTool(name, args, device, collaborator.collaboratorId);
  }

  function callSelfTool(name, args, device, collaborator) {
    if (!name.startsWith("aru_collaborator_surface_")) return { matched: false, value: null };
    if (Object.prototype.hasOwnProperty.call(args, "collaboratorId")) {
      throw new HttpError(400, "surface.owner_scope_fixed", "自己的页面工具不能指定其他协作者");
    }
    return callOwnedTool(name, args, device, validatedCollaboratorId(collaborator?.collaboratorId));
  }

  function callOwnedTool(name, args, device, collaboratorId) {
    if (name === "aru_collaborator_surface_inventory") {
      return { matched: true, value: inventory(collaboratorId) };
    }
    if (name === "aru_collaborator_surface_read") {
      return { matched: true, value: surface(collaboratorId, requiredString(args, "surfaceId")) };
    }
    if (name === "aru_collaborator_surface_publish") {
      const surfaceId = String(args.surfaceId ?? "").trim();
      const value = surfaceId
        ? publish(collaboratorId, surfaceId, args, device)
        : createSurface(collaboratorId, args, device);
      return { matched: true, value };
    }
    if (name === "aru_collaborator_surface_events") {
      return { matched: true, value: eventInventory(collaboratorId, requiredString(args, "surfaceId")) };
    }
    if (name === "aru_collaborator_surface_rollback") {
      return { matched: true, value: rollback(collaboratorId, requiredString(args, "surfaceId"), args, device) };
    }
    return { matched: false, value: null };
  }

  function loadAll(collaboratorId) {
    const directory = collaboratorDirectory(validatedCollaboratorId(collaboratorId));
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => /^surface_[A-Fa-f0-9-]+\.json$/.test(name))
      .map((name) => normalizedRecord(JSON.parse(readFileSync(join(directory, name), "utf8"))));
  }

  function loadSurface(collaboratorId, surfaceId) {
    const safeCollaboratorId = validatedCollaboratorId(collaboratorId);
    const safeSurfaceId = validatedSurfaceId(surfaceId);
    const path = surfacePath(safeCollaboratorId, safeSurfaceId);
    if (!existsSync(path)) throw new HttpError(404, "surface.unknown", "unknown collaborator surface");
    const record = normalizedRecord(JSON.parse(readFileSync(path, "utf8")));
    if (record.collaboratorId !== safeCollaboratorId || record.surfaceId !== safeSurfaceId) {
      throw new HttpError(500, "surface.identity_invalid", "stored surface identity is invalid");
    }
    return record;
  }

  function saveSurface(record) {
    const directory = collaboratorDirectory(record.collaboratorId);
    mkdirSync(directory, { recursive: true });
    const path = surfacePath(record.collaboratorId, record.surfaceId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  }

  function normalizedRecord(record) {
    record.events ??= [];
    record.nextEventSequence ??= record.events.reduce((latest, event) => Math.max(latest, Number(event.sequence) || 0), 0) + 1;
    record.stateJSON ??= "{}";
    record.stateRevision ??= 1;
    record.stateUpdatedAt ??= record.updatedAt;
    return record;
  }

  function publicSummary(record) {
    const active = activeVersion(record);
    return {
      schema: SURFACE_SCHEMA,
      surfaceId: record.surfaceId,
      collaboratorId: record.collaboratorId,
      title: record.title,
      revision: record.revision,
      activeVersionId: record.activeVersionId,
      activeVersionOrdinal: active.ordinal,
      contentSHA256: active.contentSHA256,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archivedAt: record.archivedAt,
      stateRevision: record.stateRevision,
      stateUpdatedAt: record.stateUpdatedAt,
      eventCount: record.events.length,
    };
  }

  function publicSurface(record) {
    const active = activeVersion(record);
    return {
      ...publicSummary(record),
      sourceHTML: active.sourceHTML,
      stateJSON: record.stateJSON,
      versions: record.versions.map((entry) => publicVersion(entry, false)).reverse(),
    };
  }

  function publicVersion(entry, includesSource) {
    const { createdByDeviceId: _, sourceHTML, ...safe } = entry;
    return {
      schema: SURFACE_VERSION_SCHEMA,
      ...safe,
      ...(includesSource ? { sourceHTML } : {}),
    };
  }

  function makeVersion(ordinal, sourceHTML, note, timestamp, device) {
    return {
      versionId: `surfacever_${randomUUID()}`,
      ordinal,
      sourceHTML,
      contentSHA256: createHash("sha256").update(sourceHTML).digest("hex"),
      note: String(note ?? "").trim(),
      createdAt: timestamp,
      createdByDeviceId: device.deviceId,
      restoredFromVersionId: null,
    };
  }

  function activeVersion(record) {
    const active = record.versions.find((candidate) => candidate.versionId === record.activeVersionId);
    if (!active) throw new HttpError(500, "surface.active_version_missing", "active surface version is missing");
    return active;
  }

  function requireRevision(record, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new HttpError(400, "surface.expected_revision_required", "expectedRevision required");
    }
    if (expectedRevision !== record.revision) {
      throw new HttpError(409, "surface.revision_conflict", "surface changed since it was read");
    }
  }

  function normalizedStateJSON(value) {
    if (typeof value !== "string") throw new HttpError(400, "surface.state_invalid", "stateJSON must be a string");
    let decoded;
    try { decoded = JSON.parse(value); }
    catch { throw new HttpError(400, "surface.state_invalid", "stateJSON must contain valid JSON"); }
    if (!decoded || Array.isArray(decoded) || typeof decoded !== "object") {
      throw new HttpError(400, "surface.state_invalid", "surface state must be a JSON object");
    }
    return JSON.stringify(decoded);
  }

  function validatedCollaboratorId(value) {
    const id = String(value ?? "").trim();
    if (!/^hostcol_[A-Fa-f0-9-]+$/.test(id)) throw new HttpError(400, "collaborator.id_invalid", "invalid hosted collaborator id");
    return id;
  }

  function validatedSurfaceId(value) {
    const id = String(value ?? "").trim();
    if (!/^surface_[A-Fa-f0-9-]+$/.test(id)) throw new HttpError(400, "surface.id_invalid", "invalid surface id");
    return id;
  }

  function validatedVersionId(value) {
    const id = String(value ?? "").trim();
    if (!/^surfacever_[A-Fa-f0-9-]+$/.test(id)) throw new HttpError(400, "surface.version_id_invalid", "invalid surface version id");
    return id;
  }

  function validatedTitle(value) {
    const title = String(value ?? "").trim();
    if (!title) throw new HttpError(400, "surface.title_required", "surface title required");
    if ([...title].length > 120) throw new HttpError(400, "surface.title_too_long", "surface title must be 120 characters or fewer");
    return title;
  }

  function validatedSourceHTML(value) {
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "surface.source_required", "sourceHTML required");
    return value;
  }

  function requiredString(args, name) {
    const value = args[name];
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "mcp.argument_invalid", `${name} must be a non-empty string`);
    return value.trim();
  }

  function collaboratorDirectory(collaboratorId) { return join(root, collaboratorId); }
  function surfacePath(collaboratorId, surfaceId) { return join(collaboratorDirectory(collaboratorId), `${surfaceId}.json`); }

  return { route, tools, selfTools, callTool, callSelfTool, inventory, surface };
}
