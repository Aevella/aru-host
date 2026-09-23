import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// This source projection is deliberately outside collaborator cognition.
export function createResidenceReading({ root, HttpError }) {
  const pathFor = id => {
    if (!/^hostcol_[a-zA-Z0-9-]+$/.test(id)) throw new HttpError(400, "reading.identity", "Invalid collaborator identity");
    return join(root, `${id}.phone-reading.json`);
  };
  const load = id => existsSync(pathFor(id)) ? JSON.parse(readFileSync(pathFor(id), "utf8")) : null;
  function accept(id, body, device) {
    if (body?.schema !== "aru.residence-reading.v1" || typeof body.sourceCollaboratorId !== "string" || !body.sourceCollaboratorId
        || typeof body.displayName !== "string" || typeof body.enabled !== "boolean"
        || !Number.isSafeInteger(body.generation) || body.generation < 1
        || !Number.isSafeInteger(body.revision) || body.revision < 1
        || !Number.isSafeInteger(body.generatedAt) || !Array.isArray(body.records)
        || body.records.some(r => !r || typeof r.id !== "string" || typeof r.title !== "string" || typeof r.content !== "string" || !["memory", "reference"].includes(r.kind))) {
      throw new HttpError(400, "reading.invalid", "Invalid reading projection");
    }
    const old = load(id);
    if (old && (old.deviceId !== device.deviceId || body.generation < old.generation
        || (body.generation === old.generation && (body.sourceCollaboratorId !== old.sourceCollaboratorId || body.revision < old.revision)))) {
      throw new HttpError(409, "reading.stale", "Reading relationship or revision changed");
    }
    const value = { ...body, records: body.enabled ? body.records : [], deviceId: device.deviceId };
    if (old && body.generation === old.generation && body.revision === old.revision
        && (value.enabled !== old.enabled || JSON.stringify(value.records) !== JSON.stringify(old.records))) {
      throw new HttpError(409, "reading.revision_reused", "A reading revision cannot change its content or permission");
    }
    const path = pathFor(id), temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path);
    const { deviceId: _, ...receipt } = value;
    return receipt;
  }
  function read(id) {
    const value = load(id);
    if (!value || !value.enabled) throw new HttpError(403, "reading.unavailable", "Phone reading is not enabled or has not been provided");
    const { deviceId: _, ...result } = value;
    return { sourceCollaboratorId: result.sourceCollaboratorId, displayName: result.displayName,
      generatedAt: result.generatedAt, records: result.records, source: "phone", readOnly: true, freshness: "last_phone_provided_snapshot",
      instruction: "Read-only material from your phone side at generatedAt. This is not a live phone connection and not your computer memory. Reading does not authorize copying, editing, or deleting either side's memories." };
  }
  return { accept, read };
}
