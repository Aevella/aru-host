import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const BUNDLE_SCHEMA = "aru.selfhost.collaborator-surface-bundle.v1";

export function createCollaboratorSurfaceBundleStore({
  dataDir,
  workspaceRoot,
  HttpError,
}) {
  const releaseRoot = join(dataDir, "collaborator-surface-releases");
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });

  function publishableBundle(collaboratorId, surfaceId, versionId, args) {
    const projectPath = validatedRelativePath(args.projectPath ?? ".", "projectPath", true);
    const entryPath = validatedRelativePath(args.entryPath ?? "index.html", "entryPath", false);
    const collaboratorWorkspace = resolve(workspaceRoot, collaboratorId);
    const projectDirectory = resolve(collaboratorWorkspace, projectPath);
    requireContained(collaboratorWorkspace, projectDirectory, "projectPath");
    if (!existsSync(projectDirectory) || !lstatSync(projectDirectory).isDirectory()) {
      throw new HttpError(400, "surface.project_missing", "projectPath must name an existing directory in the collaborator workspace");
    }
    const descriptors = collectProjectFiles(projectDirectory);
    if (!descriptors.some((file) => file.path === entryPath)) {
      throw new HttpError(400, "surface.entry_missing", "entryPath must name an HTML file inside projectPath");
    }
    if (!htmlExtension(entryPath)) {
      throw new HttpError(400, "surface.entry_invalid", "entryPath must be an HTML file");
    }

    const releaseId = versionId;
    const finalDirectory = releaseDirectory(collaboratorId, surfaceId, releaseId);
    const stagingDirectory = `${finalDirectory}.${randomUUID()}.tmp`;
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    try {
      for (const descriptor of descriptors) {
        const destination = join(stagingDirectory, descriptor.path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        const data = readFileSync(join(projectDirectory, descriptor.path));
        if (data.length !== descriptor.byteCount || sha256(data) !== descriptor.sha256) {
          throw new HttpError(409, "surface.project_changed", "project files changed while the release was being collected; publish again");
        }
        writeFileSync(destination, data, { mode: 0o600 });
      }
      mkdirSync(dirname(finalDirectory), { recursive: true, mode: 0o700 });
      renameSync(stagingDirectory, finalDirectory);
    } catch (error) {
      rmSync(stagingDirectory, { recursive: true, force: true });
      throw error;
    }

    const byteCount = descriptors.reduce((total, file) => total + file.byteCount, 0);
    const contentSHA256 = createHash("sha256")
      .update(JSON.stringify(descriptors.map(({ path, sha256, byteCount, mimeType }) => ({ path, sha256, byteCount, mimeType }))))
      .digest("hex");
    return {
      delivery: "bundle",
      releaseId,
      projectPath,
      entryPath,
      files: descriptors,
      byteCount,
      contentSHA256,
    };
  }

  function bundle(collaboratorId, surfaceId, version) {
    if (version.delivery !== "bundle" || !version.releaseId) {
      throw new HttpError(409, "surface.version_not_bundle", "this surface version is not a project bundle");
    }
    const directory = releaseDirectory(collaboratorId, surfaceId, version.releaseId);
    if (!existsSync(directory)) {
      throw new HttpError(410, "surface.bundle_missing", "the immutable surface bundle is missing from Host storage");
    }
    return {
      schema: BUNDLE_SCHEMA,
      collaboratorId,
      surfaceId,
      versionId: version.versionId,
      contentSHA256: version.contentSHA256,
      entryPath: version.entryPath,
      byteCount: version.byteCount,
      files: version.files.map((descriptor) => {
        const data = readFileSync(join(directory, descriptor.path));
        if (data.length !== descriptor.byteCount || sha256(data) !== descriptor.sha256) {
          throw new HttpError(500, "surface.bundle_corrupt", "stored surface bundle does not match its immutable manifest");
        }
        return { ...descriptor, contentBase64: data.toString("base64") };
      }),
    };
  }

  function releaseDirectory(collaboratorId, surfaceId, releaseId) {
    return join(releaseRoot, collaboratorId, surfaceId, releaseId);
  }

  function collectProjectFiles(projectDirectory) {
    const files = [];
    walk(projectDirectory, "", files);
    if (files.length === 0) {
      throw new HttpError(400, "surface.project_empty", "projectPath does not contain publishable files");
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  function walk(root, relativeDirectory, files) {
    const directory = join(root, relativeDirectory);
    for (const name of readdirSync(directory).sort()) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new HttpError(400, "surface.project_symlink", "surface projects cannot publish symbolic links");
      }
      if (stat.isDirectory()) {
        walk(root, relativePath, files);
      } else if (stat.isFile()) {
        const data = readFileSync(path);
        files.push({
          path: relativePath,
          sha256: sha256(data),
          byteCount: data.length,
          mimeType: mimeType(relativePath),
        });
      }
    }
  }

  function validatedRelativePath(value, field, permitsDot) {
    const path = String(value ?? "").trim().replaceAll("\\", "/");
    if (permitsDot && (path === "" || path === ".")) return ".";
    if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/.test(path)) {
      throw new HttpError(400, `surface.${field}_invalid`, `${field} must be a safe relative path`);
    }
    return path;
  }

  function requireContained(root, candidate, field) {
    const difference = relative(resolve(root), resolve(candidate));
    if (difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !difference.startsWith(sep))) return;
    throw new HttpError(400, `surface.${field}_invalid`, `${field} escapes the collaborator workspace`);
  }

  return { publishableBundle, bundle };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function htmlExtension(path) {
  return [".html", ".htm"].includes(extname(path).toLowerCase());
}

function mimeType(path) {
  const extension = extname(path).toLowerCase();
  return {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".wasm": "application/wasm",
    ".txt": "text/plain",
    ".xml": "application/xml",
  }[extension] ?? "application/octet-stream";
}
