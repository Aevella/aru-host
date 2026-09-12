import assert from "node:assert/strict";
import { mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "aru-legacy-payload-"));
try {
  // Fixed-file pre-0.31 installers omit both new modules. The running Host must
  // still load and enroll phone identities, with exactly the same owner factory.
  for (const name of await readdir(source)) {
    if (name.endsWith(".mjs") && !["mobile-collaborator-identities.mjs", "container-runtime-setup.mjs"].includes(name)) {
      await copyFile(join(source, name), join(directory, name));
    }
  }
  const { createCollaboratorHost } = await import(pathToFileURL(join(directory, "collaborator-host.mjs")));
  const state = { agentDriverProbes: ["codex", "claude-code"].map(id => ({ id, status: "unavailable", checkedAt: 1 })) };
  const host = createCollaboratorHost({
    dataDir: join(directory, "data"), managedWorkspaceRoot: join(directory, "workspace"), state,
    saveState() {}, readJSONBody: async req => req.body,
    sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    HttpError: class extends Error {}, providerSecretStore: { availability: () => ({ supported: false }), read: () => null },
  });
  const res = {};
  assert.equal(await host.route({ method: "PUT", body: { displayName: "Upgrade fixture" } }, res,
    "/aru/v1/mobile-collaborator-identities/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", () => ({ deviceId: "fixture" })), true);
  assert.ok(res.body.collaboratorId.startsWith("hostcol_"));
  assert.equal(state.hostedCollaborators.length, 0);
  console.log("LEGACY_FIXED_FILE_PAYLOAD_OK");
} finally { await rm(directory, { recursive: true, force: true }); }
