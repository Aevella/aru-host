import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";

const INVENTORY_SCHEMA = "aru.selfhost.collaborator-project-inventory.v1";
const PROJECT_SCHEMA = "aru.selfhost.collaborator-project.v1";
const PROJECT_ID = /^hostproject_[A-Fa-f0-9-]+$/;

export function createCollaboratorProjectHost({
  dataDir,
  workspaceRoot = join(dataDir, "collaborator-workspaces"),
  surfaces,
  createArtifact,
  readJSONBody,
  sendJSON,
  HttpError,
  now = Date.now,
}) {
  const root = join(dataDir, "collaborator-projects");
  const snapshotRoot = join(dataDir, "collaborator-project-snapshots");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });

  async function route(req, res, path, requireDevice, collaboratorForId) {
    const match = path.match(
      /^\/aru\/v1\/hosted-collaborators\/([^/]+)\/projects(?:\/([^/]+)(?:\/(checkpoint|publish|archive|restore))?)?$/,
    );
    if (!match) return false;
    const collaborator = collaboratorForId(match[1]);
    const projectId = match[2] ?? null;
    const action = match[3] ?? null;
    const device = requireDevice();
    if (!projectId && req.method === "GET") {
      sendJSON(res, 200, inventory(collaborator.collaboratorId));
      return true;
    }
    if (!projectId && req.method === "POST") {
      const body = await readJSONBody(req, 256 * 1024);
      sendJSON(res, 201, clientInput(() => createProject(collaborator.collaboratorId, body, device)));
      return true;
    }
    if (projectId && !action && req.method === "GET") {
      sendJSON(res, 200, clientInput(() => project(collaborator.collaboratorId, projectId)));
      return true;
    }
    if (projectId && !action && req.method === "PUT") {
      const body = await readJSONBody(req, 256 * 1024);
      sendJSON(res, 200, clientInput(() => updateProject(collaborator.collaboratorId, projectId, body, device)));
      return true;
    }
    if (projectId && action && req.method === "POST") {
      const body = await readJSONBody(req, 256 * 1024);
      const value = clientInput(() => action === "checkpoint"
        ? checkpoint(collaborator.collaboratorId, projectId, body, device)
        : action === "publish"
          ? publish(collaborator.collaboratorId, projectId, body, device)
          : setArchived(collaborator.collaboratorId, projectId, body, device, action === "archive"));
      sendJSON(res, action === "checkpoint" ? 201 : 200, value);
      return true;
    }
    return false;
  }

  function inventory(collaboratorId) {
    return {
      schema: INVENTORY_SCHEMA,
      collaboratorId,
      projects: loadAll(collaboratorId).map(publicProject).sort((left, right) =>
        right.updatedAt - left.updatedAt || left.projectId.localeCompare(right.projectId)),
    };
  }

  function clientInput(operation) {
    try {
      return operation();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "project.input_invalid", String(error?.message ?? "project input is invalid"));
    }
  }

  function project(collaboratorId, projectId) {
    return publicProject(loadProject(collaboratorId, projectId));
  }

  function createProject(collaboratorId, body, device) {
    const timestamp = now();
    const projectId = `hostproject_${randomUUID()}`;
    const title = validatedText(body?.title, "title", 160);
    const workspacePath = `projects/${slug(title)}-${projectId.slice(-8)}`;
    const workspace = collaboratorWorkspace(collaboratorId);
    const directory = resolve(workspace, workspacePath);
    requireContained(workspace, directory, "workspacePath");
    if (existsSync(directory)) {
      throw new HttpError(409, "project.path_exists", "project workspace path already exists");
    }
    mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
    let sourceURL = null;
    let repositoryURL = null;
    const requestedRepository = String(body?.repositoryURL ?? "").trim();
    if (requestedRepository) {
      ({ sourceURL, repositoryURL } = validatedGitHubRepository(requestedRepository));
      const result = spawnSync("git", ["clone", "--", repositoryURL, directory], {
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      if (result.status !== 0) {
        rmSync(directory, { recursive: true, force: true });
        throw new HttpError(422, "project.clone_failed", safeProcessFailure(result, "GitHub repository could not be cloned"));
      }
    } else {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, "index.html"), starterHTML(title), { mode: 0o600 });
    }
    const record = {
      schema: PROJECT_SCHEMA,
      projectId,
      collaboratorId,
      title,
      revision: 1,
      workspacePath,
      entryPath: validatedRelativePath(body?.entryPath ?? "index.html", "entryPath", false),
      sourceURL,
      repositoryURL,
      surfaceId: null,
      checkpointCount: 0,
      latestCheckpoint: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      updatedByDeviceId: device.deviceId,
    };
    saveProject(record);
    return publicProject(record);
  }

  function updateProject(collaboratorId, projectId, body, device) {
    const record = loadProject(collaboratorId, projectId);
    requireProjectRevision(record, body?.expectedRevision);
    if (body?.title !== undefined) record.title = validatedText(body.title, "title", 160);
    if (body?.entryPath !== undefined) {
      record.entryPath = validatedRelativePath(body.entryPath, "entryPath", false);
    }
    record.revision += 1;
    record.updatedAt = now();
    record.updatedByDeviceId = device.deviceId;
    saveProject(record);
    return publicProject(record);
  }

  function checkpoint(collaboratorId, projectId, body, device) {
    const record = loadProject(collaboratorId, projectId);
    requireProjectRevision(record, body?.expectedRevision);
    requireProjectLive(record);
    const checkpointId = `hostcheckpoint_${randomUUID()}`;
    const source = projectDirectory(record);
    const destination = join(snapshotRoot, collaboratorId, projectId, checkpointId);
    copyProject(source, destination);
    const archive = archiveSnapshot(destination);
    const note = optionalText(body?.note, 1_000);
    const artifact = createArtifact({
      filename: `${safeFilename(record.title)}-${record.checkpointCount + 1}.tar.gz`,
      mimeType: "application/gzip",
      data: archive,
      producer: {
        kind: "collaborator-project-checkpoint",
        projectId: record.projectId,
        runtime: "host-workspace",
      },
    }, device);
    record.checkpointCount += 1;
    record.latestCheckpoint = {
      checkpointId,
      ordinal: record.checkpointCount,
      note,
      artifactId: artifact.artifactId,
      createdAt: now(),
    };
    record.revision += 1;
    record.updatedAt = record.latestCheckpoint.createdAt;
    record.updatedByDeviceId = device.deviceId;
    saveProject(record);
    return { project: publicProject(record), artifact };
  }

  function publish(collaboratorId, projectId, body, device) {
    const record = loadProject(collaboratorId, projectId);
    requireProjectRevision(record, body?.expectedRevision);
    requireProjectLive(record);
    const entryDirectory = posix.dirname(record.entryPath);
    const publishBody = {
      title: record.title,
      projectPath: entryDirectory === "."
        ? record.workspacePath
        : `${record.workspacePath}/${entryDirectory}`,
      entryPath: posix.basename(record.entryPath),
      note: optionalText(body?.note, 1_000),
      networkAccess: body?.networkAccess ?? "none",
    };
    const surface = record.surfaceId
      ? surfaces.publishProject(collaboratorId, record.surfaceId, {
        ...publishBody,
        expectedRevision: validatedPositiveInteger(body?.expectedSurfaceRevision, "expectedSurfaceRevision"),
      }, device)
      : surfaces.createProjectSurface(collaboratorId, publishBody, device);
    record.surfaceId = surface.surfaceId;
    record.revision += 1;
    record.updatedAt = now();
    record.updatedByDeviceId = device.deviceId;
    saveProject(record);
    return { project: publicProject(record), surface };
  }

  function setArchived(collaboratorId, projectId, body, device, archived) {
    const record = loadProject(collaboratorId, projectId);
    requireProjectRevision(record, body?.expectedRevision);
    record.archivedAt = archived ? now() : null;
    record.revision += 1;
    record.updatedAt = now();
    record.updatedByDeviceId = device.deviceId;
    saveProject(record);
    return publicProject(record);
  }

  function publicProject(record) {
    const { updatedByDeviceId: _, ...value } = record;
    return { ...value, repository: repositoryStatus(record) };
  }

  function repositoryStatus(record) {
    const directory = projectDirectory(record);
    if (!existsSync(join(directory, ".git"))) {
      return record.repositoryURL ? { state: "unavailable", sourceURL: record.sourceURL, repositoryURL: record.repositoryURL } : null;
    }
    const branch = git(directory, ["branch", "--show-current"]);
    const commit = git(directory, ["rev-parse", "HEAD"]);
    const status = git(directory, ["status", "--porcelain"]);
    const upstream = git(directory, ["rev-parse", "--abbrev-ref", "@{upstream}"], true);
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = git(directory, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`], true)
        .split(/\s+/).map(Number);
      behind = Number.isFinite(counts[0]) ? counts[0] : 0;
      ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
    }
    return {
      state: "ready",
      sourceURL: record.sourceURL,
      repositoryURL: record.repositoryURL ?? (git(directory, ["remote", "get-url", "origin"], true) || null),
      branch: branch || null,
      commit: commit || null,
      dirty: Boolean(status),
      upstream: upstream || null,
      ahead,
      behind,
    };
  }

  function git(directory, args, permitsFailure = false) {
    const result = spawnSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      if (permitsFailure) return "";
      throw new HttpError(422, "project.git_failed", safeProcessFailure(result, "Git command failed"));
    }
    return String(result.stdout ?? "").trim();
  }

  function tools(selfScoped) {
    const id = (description) => ({ type: "string", minLength: 1, description });
    const owner = selfScoped ? {} : { collaboratorId: id("Hosted collaborator id.") };
    const ownerRequired = selfScoped ? [] : ["collaboratorId"];
    const operation = (name, title, description, properties, required, readOnlyHint = false) => ({
      name, title, description,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: readOnlyHint, openWorldHint: false },
    });
    return [
      operation("aru_collaborator_project_inventory", "List page projects", "List the page projects in your own managed Host workspace, including Git repository state and published surface binding.", owner, ownerRequired, true),
      operation("aru_collaborator_project_create", "Create page project", "Create a durable page project in your own managed Host workspace. A GitHub URL clones that repository; omitting it creates a ready starter page.", {
        ...owner, title: id("Project title."), repositoryURL: { type: "string", description: "Optional public or Host-authenticated github.com URL." }, entryPath: { type: "string", description: "Publishable HTML path, default index.html." },
      }, [...ownerRequired, "title"]),
      operation("aru_collaborator_project_checkpoint", "Save page project checkpoint", "Save an immutable project checkpoint and publish its tar.gz package into the Host artifact vault without changing the phone's active page.", {
        ...owner, projectId: id("Project id."), expectedRevision: { type: "integer", minimum: 1 }, note: { type: "string" },
      }, [...ownerRequired, "projectId", "expectedRevision"]),
      operation("aru_collaborator_project_publish", "Publish page project", "Publish the current project files as the phone's active immutable page release. This is separate from saving a checkpoint.", {
        ...owner, projectId: id("Project id."), expectedRevision: { type: "integer", minimum: 1 }, expectedSurfaceRevision: { type: "integer", minimum: 1 }, note: { type: "string" }, networkAccess: { type: "string", enum: ["none", "outbound"] },
      }, [...ownerRequired, "projectId", "expectedRevision"]),
    ];
  }

  function callSelfTool(name, args, device, collaborator) {
    if (!name.startsWith("aru_collaborator_project_")) return { matched: false, value: null };
    if (Object.prototype.hasOwnProperty.call(args, "collaboratorId")) {
      throw new HttpError(400, "project.owner_scope_fixed", "自己的项目工具不能指定其他协作者");
    }
    return callOwnedTool(name, args, device, collaborator.collaboratorId);
  }

  function callTool(name, args, device, collaboratorForId) {
    if (!name.startsWith("aru_collaborator_project_")) return { matched: false, value: null };
    return callOwnedTool(name, args, device, collaboratorForId(requiredString(args, "collaboratorId")).collaboratorId);
  }

  function callOwnedTool(name, args, device, collaboratorId) {
    if (name === "aru_collaborator_project_inventory") return { matched: true, value: inventory(collaboratorId) };
    if (name === "aru_collaborator_project_create") return { matched: true, value: clientInput(() => createProject(collaboratorId, args, device)) };
    if (name === "aru_collaborator_project_checkpoint") return { matched: true, value: clientInput(() => checkpoint(collaboratorId, requiredString(args, "projectId"), args, device)) };
    if (name === "aru_collaborator_project_publish") return { matched: true, value: clientInput(() => publish(collaboratorId, requiredString(args, "projectId"), args, device)) };
    return { matched: false, value: null };
  }

  function requireProjectRevision(record, value) {
    const revision = validatedPositiveInteger(value, "expectedRevision");
    if (revision !== record.revision) {
      throw new HttpError(409, "project.revision_conflict", "project revision changed since it was read");
    }
  }

  function requireProjectLive(record) {
    if (record.archivedAt !== null) {
      throw new HttpError(409, "project.archived", "archived project must be restored first");
    }
  }

  function projectDirectory(record) {
    const workspace = collaboratorWorkspace(record.collaboratorId);
    const directory = resolve(workspace, record.workspacePath);
    requireContained(workspace, directory, "workspacePath");
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
      throw new HttpError(410, "project.workspace_missing", "project workspace directory is missing");
    }
    return directory;
  }

  function collaboratorWorkspace(collaboratorId) {
    const workspace = resolve(workspaceRoot, collaboratorId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return workspace;
  }

  function copyProject(source, destination) {
    const staging = `${destination}.${randomUUID()}.tmp`;
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      for (const name of readdirSync(source)) {
        if (name === ".git") continue;
        rejectSymlinks(join(source, name));
        cpSync(join(source, name), join(staging, name), {
          recursive: true,
          errorOnExist: true,
          filter: (candidate) => basename(candidate) !== ".git",
        });
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      renameSync(staging, destination);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  function rejectSymlinks(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new HttpError(400, "project.symlink_rejected", "project checkpoints cannot contain symbolic links");
    }
    if (stat.isDirectory()) for (const name of readdirSync(path)) rejectSymlinks(join(path, name));
  }

  function archiveSnapshot(directory) {
    const result = spawnSync("tar", ["-czf", "-", "-C", directory, "."], {
      encoding: null,
      timeout: 120_000,
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      throw new HttpError(500, "project.archive_failed", safeProcessFailure(result, "Project checkpoint could not be packaged"));
    }
    return result.stdout;
  }

  function loadAll(collaboratorId) {
    const directory = join(root, collaboratorId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) =>
      parseProject(readFileSync(join(directory, name), "utf8"), collaboratorId));
  }

  function loadProject(collaboratorId, projectId) {
    const id = validatedProjectId(projectId);
    const path = join(root, collaboratorId, `${id}.json`);
    if (!existsSync(path)) throw new HttpError(404, "project.unknown", "unknown collaborator project");
    return parseProject(readFileSync(path, "utf8"), collaboratorId, id);
  }

  function parseProject(source, collaboratorId, projectId = null) {
    let record;
    try { record = JSON.parse(source); } catch { throw new HttpError(500, "project.corrupt", "stored collaborator project is corrupt"); }
    if (record?.schema !== PROJECT_SCHEMA || record.collaboratorId !== collaboratorId || (projectId && record.projectId !== projectId)) {
      throw new HttpError(500, "project.corrupt", "stored collaborator project identity is invalid");
    }
    return record;
  }

  function saveProject(record) {
    const directory = join(root, record.collaboratorId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${record.projectId}.json`);
    const staging = `${path}.${randomUUID()}.tmp`;
    writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, path);
  }

  return {
    route,
    inventory,
    project,
    tools: () => tools(false),
    selfTools: () => tools(true),
    callTool,
    callSelfTool,
  };
}

function validatedGitHubRepository(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) {
    throw new Error("invalid");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(parts[1])) {
    throw new Error("invalid");
  }
  const repository = parts[1].replace(/\.git$/, "");
  return {
    sourceURL: value,
    repositoryURL: `https://github.com/${parts[0]}/${repository}.git`,
  };
}

function validatedRelativePath(value, field, permitsDot) {
  const path = String(value ?? "").trim().replaceAll("\\", "/");
  if (permitsDot && (path === "" || path === ".")) return ".";
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`${field} must be a safe relative path`);
  }
  return path;
}

function requireContained(root, candidate, field) {
  const difference = relative(resolve(root), resolve(candidate));
  if (difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !difference.startsWith(sep))) return;
  throw new Error(`${field} escapes the collaborator workspace`);
}

function validatedProjectId(value) {
  const id = String(value ?? "").trim();
  if (!PROJECT_ID.test(id)) throw new Error("projectId is invalid");
  return id;
}

function validatedText(value, field, maximum) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function optionalText(value, maximum) {
  const text = String(value ?? "").trim();
  if (text.length > maximum) throw new Error("note is too long");
  return text;
}

function validatedPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} is required`);
  return value;
}

function requiredString(args, field) {
  const value = String(args?.[field] ?? "").trim();
  if (!value) throw new Error(`${field} required`);
  return value;
}

function slug(value) {
  const normalized = value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return normalized.slice(0, 42) || "page";
}

function safeFilename(value) {
  return basename(value.replace(/[\u0000-\u001f\u007f/\\:]/g, "-")).slice(0, 80) || "page-project";
}

function safeProcessFailure(result, fallback) {
  return String(result?.stderr ?? result?.error?.message ?? fallback).trim().split("\n")[0].slice(0, 500) || fallback;
}

function starterHTML(title) {
  const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html>\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${escaped}</title>\n<style>body{font:17px system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f2fb;color:#211d2d}main{padding:32px;text-align:center}</style>\n<main><h1>${escaped}</h1><p>在电脑协作者的工作区继续编辑，然后保存检查点或发布到手机。</p></main>\n`;
}
