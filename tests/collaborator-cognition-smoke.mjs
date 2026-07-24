import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollaboratorCognitionHost } from "../collaborator-cognition.mjs";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const root = mkdtempSync(join(tmpdir(), "aru-cognition-"));
const dataDir = join(root, "data");
const codexHome = join(root, "codex");
mkdirSync(dataDir, { recursive: true });
mkdirSync(codexHome, { recursive: true });
writeFileSync(join(codexHome, "AGENTS.md"), "The user's computer-level nickname is AA.\n");

let clock = 1_000;
const host = createCollaboratorCognitionHost({
  dataDir,
  readJSONBody: async () => ({}),
  sendJSON() {},
  HttpError,
  now: () => ++clock,
  codexHome,
});
const collaborator = { collaboratorId: "hostcol_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", displayName: "Example Collaborator" };
const device = { deviceId: "phone" };

try {
  const initial = host.initialize(collaborator.collaboratorId, "isolated");
  assert.equal(initial.instructionEnvironment, "isolated");
  assert.doesNotMatch(host.requestInstructions(collaborator), /nickname is AA/);

  let result = host.callSelfTool("aru_collaborator_cognition_update", {
    expectedRevision: initial.revision,
    instructionEnvironment: "inheritCodex",
    systemPrompt: "You speak with quiet precision.",
  }, device, collaborator).value;
  assert.equal(result.revision, 2);
  assert.match(host.requestInstructions(collaborator), /nickname is AA/);
  assert.match(host.requestInstructions(collaborator), /quiet precision/);

  result = host.callSelfTool("aru_collaborator_memory_save", {
    expectedRevision: result.revision,
    title: "AA",
    content: "AA prefers direct explanations.",
  }, device, collaborator).value;
  assert.equal(result.memories.length, 1);
  assert.match(host.requestInstructions(collaborator), /AA prefers direct explanations/);

  result = host.callSelfTool("aru_collaborator_reference_save", {
    expectedRevision: result.revision,
    title: "Aru meaning",
    content: "Aru is the low-interference system presence.",
  }, device, collaborator).value;
  assert.equal(result.references.length, 1);
  assert.match(host.requestInstructions(collaborator), /low-interference system presence/);

  result = host.callSelfTool("aru_collaborator_memory_archive", {
    expectedRevision: result.revision,
    memoryId: result.memories[0].memoryId,
    archived: true,
  }, device, collaborator).value;
  assert.ok(result.memories[0].archivedAt);
  assert.doesNotMatch(host.requestInstructions(collaborator), /AA prefers direct explanations/);

  assert.throws(
    () => host.callSelfTool("aru_collaborator_cognition_update", {
      expectedRevision: 1,
      systemPrompt: "stale",
    }, device, collaborator),
    (error) => error instanceof HttpError && error.status === 409,
  );

  console.log("collaborator cognition smoke: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
