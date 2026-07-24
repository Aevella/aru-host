#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollaboratorProjectHost } from "../collaborator-projects.mjs";
import { createCollaboratorSurfaceBundleStore } from "../collaborator-surface-bundles.mjs";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "aru-project-"));
const collaboratorId = "hostcol_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const collaborator = { collaboratorId, displayName: "Example Collaborator" };
const device = { deviceId: "phone" };
const artifacts = [];
const published = [];
let clock = 1_000;
const surfaces = {
  createProjectSurface(owner, body) {
    assert.equal(owner, collaboratorId);
    published.push(body);
    return { surfaceId: "surface_1", revision: 1, ...body };
  },
  publishProject() { throw new Error("unexpected update"); },
};
const host = createCollaboratorProjectHost({
  dataDir,
  surfaces,
  createArtifact(value) {
    const artifact = { artifactId: `artifact_${artifacts.length + 1}`, filename: value.filename };
    artifacts.push({ ...value, artifact });
    return artifact;
  },
  readJSONBody: async (req) => req.body,
  sendJSON(res, status, body) { res.status = status; res.body = body; },
  HttpError,
  now: () => clock,
});

try {
  let response = await call("POST", rootPath(), {
    title: "Phone page",
    entryPath: "index.html",
  });
  assert.equal(response.status, 201);
  let project = response.body;
  assert.match(project.projectId, /^hostproject_/);
  assert.equal(project.repository, null);
  const projectDirectory = join(dataDir, "collaborator-workspaces", collaboratorId, project.workspacePath);
  assert.equal(existsSync(join(projectDirectory, "index.html")), true);
  assert.match(readFileSync(join(projectDirectory, "index.html"), "utf8"), /Phone page/);
  mkdirSync(join(projectDirectory, "assets", ".git"), { recursive: true });
  writeFileSync(join(projectDirectory, "assets", ".git", "config"), "secret metadata");

  clock += 10;
  response = await call("POST", `${rootPath()}/${project.projectId}/checkpoint`, {
    expectedRevision: project.revision,
    note: "first save",
  });
  project = response.body.project;
  assert.equal(project.checkpointCount, 1);
  assert.equal(project.latestCheckpoint.artifactId, "artifact_1");
  assert.equal(artifacts[0].producer.kind, "collaborator-project-checkpoint");
  assert.ok(artifacts[0].data.length > 0);
  assert.equal(artifacts[0].mimeType, "application/gzip");
  const archivedPaths = spawnSync("tar", ["-tzf", "-"], { input: artifacts[0].data, encoding: "utf8" });
  assert.equal(archivedPaths.status, 0);
  assert.doesNotMatch(archivedPaths.stdout, /\.git/);

  await assert.rejects(
    call("POST", `${rootPath()}/${project.projectId}/checkpoint`, {
      expectedRevision: 1,
      note: "stale",
    }),
    (error) => error instanceof HttpError && error.status === 409 && error.code === "project.revision_conflict",
  );

  clock += 10;
  response = await call("POST", `${rootPath()}/${project.projectId}/publish`, {
    expectedRevision: project.revision,
    note: "phone release",
    networkAccess: "none",
  });
  project = response.body.project;
  assert.equal(project.surfaceId, "surface_1");
  assert.equal(published[0].projectPath, project.workspacePath);
  assert.equal(published[0].entryPath, "index.html");
  const bundle = createCollaboratorSurfaceBundleStore({
    dataDir,
    workspaceRoot: join(dataDir, "collaborator-workspaces"),
    HttpError,
  }).publishableBundle(collaboratorId, "surface_1", "surfacever_1", published[0]);
  assert.deepEqual(bundle.files.map((file) => file.path), ["index.html"]);

  const inventory = host.inventory(collaboratorId);
  assert.equal(inventory.projects.length, 1);
  assert.equal(inventory.projects[0].checkpointCount, 1);
  assert.deepEqual(host.selfTools().map((tool) => tool.name), [
    "aru_collaborator_project_inventory",
    "aru_collaborator_project_create",
    "aru_collaborator_project_checkpoint",
    "aru_collaborator_project_publish",
  ]);
  assert.equal(host.selfTools().every((tool) => !("collaboratorId" in tool.inputSchema.properties)), true);
  console.log("ARU_COLLABORATOR_PROJECT_SMOKE_OK");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

async function call(method, path, body = null) {
  const req = { method, body };
  const res = {};
  const matched = await host.route(
    req,
    res,
    path,
    () => device,
    (id) => {
      assert.equal(id, collaboratorId);
      return collaborator;
    },
  );
  assert.equal(matched, true);
  return res;
}

function rootPath() {
  return `/aru/v1/hosted-collaborators/${collaboratorId}/projects`;
}
