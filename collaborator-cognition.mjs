import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COGNITION_SCHEMA = "aru.selfhost.collaborator-cognition.v1";
const INSTRUCTION_ENVIRONMENTS = new Set(["isolated", "inheritCodex"]);
const RECORD_KINDS = new Map([
  ["memories", { singular: "memory", idKey: "memoryId", prefix: "hostmem" }],
  ["references", { singular: "reference", idKey: "referenceId", prefix: "hostref" }],
]);

export function createCollaboratorCognitionHost({
  dataDir,
  readJSONBody,
  sendJSON,
  HttpError,
  now = Date.now,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
}) {
  const root = join(dataDir, "collaborator-cognition");
  mkdirSync(root, { recursive: true, mode: 0o700 });

  async function route(req, res, path, requireDevice, collaboratorForId) {
    const match = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/cognition(?:\/(memories|references)(?:\/([^/]+)(?:\/(archive|restore))?)?)?$/,
    );
    if (!match) return false;
    const collaborator = collaboratorForId(match[1]);
    const kind = match[2] ?? null;
    const recordId = match[3] ?? null;
    const action = match[4] ?? null;
    const device = requireDevice();

    if (!kind && req.method === "GET") {
      sendJSON(res, 200, read(collaborator.collaboratorId));
      return true;
    }
    if (!kind && req.method === "PUT") {
      const body = await readJSONBody(req, 512 * 1024);
      sendJSON(res, 200, clientInput(() => updateSettings(collaborator.collaboratorId, body, device)));
      return true;
    }
    if (kind && !recordId && req.method === "POST") {
      const body = await readJSONBody(req, 512 * 1024);
      sendJSON(res, 201, clientInput(() => createRecord(collaborator.collaboratorId, kind, body, device)));
      return true;
    }
    if (kind && recordId && !action && req.method === "PUT") {
      const body = await readJSONBody(req, 512 * 1024);
      sendJSON(res, 200, clientInput(() => updateRecord(collaborator.collaboratorId, kind, recordId, body, device)));
      return true;
    }
    if (kind && recordId && action && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, clientInput(() => setRecordArchived(
        collaborator.collaboratorId,
        kind,
        recordId,
        body,
        device,
        action === "archive",
      )));
      return true;
    }
    return false;
  }

  function clientInput(operation) {
    try {
      return operation();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "cognition.input_invalid", error.message ?? "invalid cognition input");
    }
  }

  function initialize(collaboratorId, instructionEnvironment = "isolated") {
    if (existsSync(pathFor(collaboratorId))) return read(collaboratorId);
    const timestamp = now();
    const cognition = {
      schema: COGNITION_SCHEMA,
      collaboratorId,
      revision: 1,
      instructionEnvironment: validatedInstructionEnvironment(instructionEnvironment),
      systemPrompt: "",
      memories: [],
      references: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      updatedByDeviceId: null,
    };
    save(cognition);
    return publicCognition(cognition);
  }

  function read(collaboratorId) {
    return publicCognition(load(collaboratorId));
  }

  function summary(collaboratorId) {
    const cognition = load(collaboratorId);
    return {
      schema: "aru.selfhost.collaborator-cognition-summary.v1",
      revision: cognition.revision,
      instructionEnvironment: cognition.instructionEnvironment,
      hasSystemPrompt: Boolean(cognition.systemPrompt.trim()),
      memoryCount: cognition.memories.filter((item) => !item.archivedAt).length,
      referenceCount: cognition.references.filter((item) => !item.archivedAt).length,
      updatedAt: cognition.updatedAt,
    };
  }

  function requestInstructions(collaborator) {
    const cognition = load(collaborator.collaboratorId);
    const sections = [
      [
        `You are ${collaborator.displayName}, a computer-hosted collaborator inside Aru.`,
        "This computer is the durable authority for your conversations. The phone is a synchronized client and editing surface.",
        "Work inside the provided managed workspace. Use Aru tools for product data and user-visible actions.",
        "Your collaborator tools are already bound to your own profile, memories, references, and pages. Never ask for, guess, or send a collaborator id when using them.",
        "Never ask the user to configure sockets, copy credentials, or edit MCP JSON for this connection.",
      ].join("\n"),
    ];
    if (cognition.instructionEnvironment === "inheritCodex") {
      const inherited = readCodexGlobalInstructions(codexHome);
      sections.push(
        "The user explicitly enabled inheritance from this computer's Codex environment. Treat the following as inherited computer-level guidance, not as memories you created yourself:",
        inherited || "No computer-level Codex instructions are currently present.",
      );
    }
    if (cognition.systemPrompt.trim()) {
      sections.push("Your collaborator-specific system prompt:", cognition.systemPrompt.trim());
    }
    const memories = cognition.memories.filter((item) => !item.archivedAt);
    if (memories.length > 0) {
      sections.push(
        "Confirmed collaborator memories:",
        memories.map((item) => `## ${item.title}\n${item.content}`).join("\n\n"),
      );
    }
    const references = cognition.references.filter((item) => !item.archivedAt);
    if (references.length > 0) {
      sections.push(
        "Long-term collaborator references:",
        references.map((item) => `## ${item.title}\n${item.content}`).join("\n\n"),
      );
    }
    return sections.join("\n\n");
  }

  function updateSettings(collaboratorId, body, device) {
    const cognition = load(collaboratorId);
    checkRevision(cognition, body?.expectedRevision);
    if (body?.instructionEnvironment === undefined && body?.systemPrompt === undefined) {
      throw new HttpError(400, "cognition.no_changes", "instructionEnvironment or systemPrompt required");
    }
    if (body.instructionEnvironment !== undefined) {
      cognition.instructionEnvironment = validatedInstructionEnvironment(body.instructionEnvironment);
    }
    if (body.systemPrompt !== undefined) cognition.systemPrompt = validatedText(body.systemPrompt, true, "systemPrompt");
    touch(cognition, device);
    save(cognition);
    return publicCognition(cognition);
  }

  function createRecord(collaboratorId, kind, body, device) {
    const definition = recordDefinition(kind);
    const cognition = load(collaboratorId);
    checkRevision(cognition, body?.expectedRevision);
    const timestamp = now();
    const record = {
      [definition.idKey]: `${definition.prefix}_${randomUUID()}`,
      title: validatedText(body?.title, false, "title"),
      content: validatedText(body?.content, false, "content"),
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      updatedByDeviceId: device.deviceId,
    };
    cognition[kind].push(record);
    touch(cognition, device);
    save(cognition);
    return publicCognition(cognition);
  }

  function updateRecord(collaboratorId, kind, recordId, body, device) {
    const cognition = load(collaboratorId);
    checkRevision(cognition, body?.expectedRevision);
    const record = findRecord(cognition, kind, recordId);
    if (body?.title === undefined && body?.content === undefined) {
      throw new HttpError(400, "cognition.no_changes", "title or content required");
    }
    if (body.title !== undefined) record.title = validatedText(body.title, false, "title");
    if (body.content !== undefined) record.content = validatedText(body.content, false, "content");
    record.updatedAt = now();
    record.updatedByDeviceId = device.deviceId;
    touch(cognition, device);
    save(cognition);
    return publicCognition(cognition);
  }

  function setRecordArchived(collaboratorId, kind, recordId, body, device, archived) {
    const cognition = load(collaboratorId);
    checkRevision(cognition, body?.expectedRevision);
    const record = findRecord(cognition, kind, recordId);
    record.archivedAt = archived ? now() : null;
    record.updatedAt = now();
    record.updatedByDeviceId = device.deviceId;
    touch(cognition, device);
    save(cognition);
    return publicCognition(cognition);
  }

  function selfTools() {
    const string = (description) => ({ type: "string", description });
    const revision = { type: "integer", minimum: 1, description: "Revision returned by the latest cognition read." };
    const tool = (name, title, description, properties, required, readOnlyHint = false) => ({
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
    return [
      tool(
        "aru_collaborator_cognition_read",
        "Read my Aru prompt and memories",
        "Read your own Host-authoritative prompt, Codex inheritance mode, confirmed memories, and long-term references.",
        {},
        [],
        true,
      ),
      tool(
        "aru_collaborator_cognition_update",
        "Update my Aru prompt settings",
        "Update your own collaborator-specific system prompt or choose whether to inherit this computer's Codex instructions.",
        {
          expectedRevision: revision,
          systemPrompt: string("Complete collaborator-specific system prompt. Empty clears it."),
          instructionEnvironment: { type: "string", enum: ["isolated", "inheritCodex"] },
        },
        ["expectedRevision"],
      ),
      ...["memory", "reference"].flatMap((singular) => {
        const kind = singular === "memory" ? "memories" : "references";
        const definition = recordDefinition(kind);
        const label = singular === "memory" ? "memory" : "long-term reference";
        return [
          tool(
            `aru_collaborator_${singular}_save`,
            `Save my Aru ${label}`,
            `Create or update one of your own Host-authoritative ${label} records. Omit ${definition.idKey} to create it.`,
            {
              expectedRevision: revision,
              [definition.idKey]: string(`Existing ${label} id when updating.`),
              title: string(`${label} title.`),
              content: string(`${label} body.`),
            },
            ["expectedRevision", "title", "content"],
          ),
          tool(
            `aru_collaborator_${singular}_archive`,
            `Archive or restore my Aru ${label}`,
            `Archive or restore one of your own ${label} records without deleting its history.`,
            {
              expectedRevision: revision,
              [definition.idKey]: string(`${label} id.`),
              archived: { type: "boolean", description: "True archives; false restores." },
            },
            ["expectedRevision", definition.idKey, "archived"],
          ),
        ];
      }),
    ];
  }

  function callSelfTool(name, args, device, collaborator) {
    if (name === "aru_collaborator_cognition_read") {
      return { matched: true, value: read(collaborator.collaboratorId) };
    }
    if (name === "aru_collaborator_cognition_update") {
      return { matched: true, value: updateSettings(collaborator.collaboratorId, args, device) };
    }
    const match = name.match(/^aru_collaborator_(memory|reference)_(save|archive)$/);
    if (!match) return { matched: false };
    const kind = match[1] === "memory" ? "memories" : "references";
    const definition = recordDefinition(kind);
    if (match[2] === "save") {
      const id = args?.[definition.idKey];
      return {
        matched: true,
        value: id
          ? updateRecord(collaborator.collaboratorId, kind, id, args, device)
          : createRecord(collaborator.collaboratorId, kind, args, device),
      };
    }
    return {
      matched: true,
      value: setRecordArchived(
        collaborator.collaboratorId,
        kind,
        args?.[definition.idKey],
        args,
        device,
        args?.archived === true,
      ),
    };
  }

  function load(collaboratorId) {
    const path = pathFor(collaboratorId);
    if (!existsSync(path)) return initialize(collaboratorId, "inheritCodex");
    try {
      return normalizedCognition(JSON.parse(readFileSync(path, "utf8")), collaboratorId);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, "cognition.unreadable", "collaborator cognition is unreadable");
    }
  }

  function save(cognition) {
    const path = pathFor(cognition.collaboratorId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(cognition, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }

  function pathFor(collaboratorId) {
    const id = String(collaboratorId ?? "");
    if (!/^hostcol_[A-Fa-f0-9-]+$/.test(id)) {
      throw new HttpError(400, "collaborator.id_invalid", "invalid hosted collaborator id");
    }
    return join(root, `${id}.json`);
  }

  function normalizedCognition(value, collaboratorId) {
    if (!value || value.collaboratorId !== collaboratorId || value.schema !== COGNITION_SCHEMA) {
      throw new Error("invalid cognition record");
    }
    value.instructionEnvironment = validatedInstructionEnvironment(value.instructionEnvironment);
    value.systemPrompt = typeof value.systemPrompt === "string" ? value.systemPrompt : "";
    value.memories = Array.isArray(value.memories) ? value.memories : [];
    value.references = Array.isArray(value.references) ? value.references : [];
    return value;
  }

  function publicCognition(cognition) {
    const { updatedByDeviceId: _, ...value } = cognition;
    return {
      ...value,
      memories: cognition.memories.map(publicRecord),
      references: cognition.references.map(publicRecord),
    };
  }

  function publicRecord({ updatedByDeviceId: _, ...record }) {
    return record;
  }

  function findRecord(cognition, kind, recordId) {
    const definition = recordDefinition(kind);
    const id = String(recordId ?? "");
    const record = cognition[kind].find((candidate) => candidate[definition.idKey] === id);
    if (!record) throw new HttpError(404, `cognition.${definition.singular}_unknown`, `unknown ${definition.singular}`);
    return record;
  }

  function checkRevision(cognition, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision)) {
      throw new HttpError(400, "cognition.expected_revision_required", "expectedRevision required");
    }
    if (expectedRevision !== cognition.revision) {
      throw new HttpError(409, "cognition.revision_conflict", "collaborator cognition changed since it was read");
    }
  }

  function touch(cognition, device) {
    cognition.revision += 1;
    cognition.updatedAt = now();
    cognition.updatedByDeviceId = device.deviceId;
  }

  function recordDefinition(kind) {
    const definition = RECORD_KINDS.get(kind);
    if (!definition) throw new HttpError(400, "cognition.kind_invalid", "unknown cognition record kind");
    return definition;
  }

  return {
    route,
    initialize,
    read,
    summary,
    requestInstructions,
    selfTools,
    callSelfTool,
  };
}

function validatedInstructionEnvironment(value) {
  const environment = String(value ?? "");
  if (!INSTRUCTION_ENVIRONMENTS.has(environment)) {
    throw new Error("instructionEnvironment must be isolated or inheritCodex");
  }
  return environment;
}

function validatedText(value, allowEmpty, name) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const text = value.trim();
  if (!allowEmpty && !text) throw new Error(`${name} must not be empty`);
  return text;
}

function readCodexGlobalInstructions(codexHome) {
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const path = join(codexHome, name);
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  }
  return "";
}
