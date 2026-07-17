import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";

const INVENTORY_SCHEMA = "aru.selfhost.node-workspace-inventory.v1";
const WORKSPACE_SCHEMA = "aru.selfhost.node-workspace.v1";
const HOST_MANAGED_OWNERSHIP = "host-managed";
const USER_GRANTED_OWNERSHIP = "user-granted";
const SUPPORTED_NODE_KINDS = new Set(["home-mac", "local-device"]);
const TOOL_NAMES = new Set([
  "aru_node_workspace_inventory",
  "aru_node_workspace_files",
  "aru_node_workspace_read_text",
  "aru_node_workspace_write_text",
  "aru_node_workspace_create_directory",
  "aru_node_workspace_move",
  "aru_node_workspace_delete",
]);
const OPERATIONS = ["list", "read-text", "write-text", "create-directory", "move", "delete"];

export function createNodeWorkspaceHost({
  config,
  state,
  saveState,
  log,
  readJSONBody,
  sendJSON,
  HttpError,
  mcpOperationTool,
  mcpIdentifierSchema,
}) {
  const supported = SUPPORTED_NODE_KINDS.has(config.nodeKind);

  function ensureManagedWorkspace() {
    if (!supported) return null;
    const requestedRoot = resolve(config.managedWorkspaceRoot);
    if (!existsSync(requestedRoot)) mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    const requestedStats = lstatSync(requestedRoot);
    if (requestedStats.isSymbolicLink() || !requestedStats.isDirectory()) {
      throw new Error("managed workspace root must be a real directory");
    }
    if (typeof process.getuid === "function" && requestedStats.uid !== process.getuid()) {
      throw new Error("managed workspace root must belong to the Host user");
    }
    const rootPath = realpathSync(requestedRoot);
    const now = Date.now();
    let changed = false;
    let managed = state.nodeWorkspaces.find((workspace) =>
      workspace.deletedAt === null && workspace.rootPath === rootPath);
    managed ??= state.nodeWorkspaces.find((workspace) =>
      workspace.deletedAt === null && workspace.ownership === HOST_MANAGED_OWNERSHIP);
    managed ??= state.nodeWorkspaces.find((workspace) =>
      workspace.ownership === HOST_MANAGED_OWNERSHIP);
    if (!managed) {
      managed = {
        workspaceId: `nw_${randomUUID()}`,
        displayName: "Aru Workspace",
        rootPath,
        ownership: HOST_MANAGED_OWNERSHIP,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      state.nodeWorkspaces.push(managed);
      changed = true;
    }
    for (const workspace of state.nodeWorkspaces) {
      if (workspace === managed) {
        if (workspace.displayName !== "Aru Workspace" || workspace.rootPath !== rootPath ||
            workspace.ownership !== HOST_MANAGED_OWNERSHIP || workspace.isDefault !== true ||
            workspace.deletedAt !== null) {
          workspace.displayName = "Aru Workspace";
          workspace.rootPath = rootPath;
          workspace.ownership = HOST_MANAGED_OWNERSHIP;
          workspace.isDefault = true;
          workspace.deletedAt = null;
          workspace.updatedAt = now;
          changed = true;
        }
        continue;
      }
      if (workspace.ownership === HOST_MANAGED_OWNERSHIP && workspace.deletedAt === null) {
        workspace.deletedAt = now;
        workspace.updatedAt = now;
        changed = true;
      }
      if (workspace.ownership !== HOST_MANAGED_OWNERSHIP &&
          workspace.ownership !== USER_GRANTED_OWNERSHIP) {
        workspace.ownership = USER_GRANTED_OWNERSHIP;
        changed = true;
      }
      if (workspace.isDefault !== false) {
        workspace.isDefault = false;
        changed = true;
      }
    }
    if (changed) {
      saveState();
      log(`ensured managed node workspace ${managed.workspaceId}`);
    }
    return publicWorkspace(managed);
  }

  function requireAvailable() {
    if (!supported) {
      throw new HttpError(
        404,
        "node_workspace.unavailable",
        "this node does not publish host workspace access",
      );
    }
  }

  function requireLoopback(req) {
    const address = String(req.socket?.remoteAddress ?? "");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
      throw new HttpError(
        403,
        "node_workspace.local_authority_required",
        "workspace grants can only be changed from this computer",
      );
    }
  }

  function manifestCapability() {
    return {
      enabled: supported,
      endpoint: "/aru/v1/node-workspaces",
      authority: "host-managed-default+host-local-explicit-grants",
      defaultWorkspace: HOST_MANAGED_OWNERSHIP,
      operations: OPERATIONS,
      commandExecution: false,
    };
  }

  function inventory() {
    requireAvailable();
    return {
      schema: INVENTORY_SCHEMA,
      workspaces: state.nodeWorkspaces
        .filter((workspace) => workspace.deletedAt === null)
        .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) ||
          right.updatedAt - left.updatedAt ||
          left.displayName.localeCompare(right.displayName))
        .map(publicWorkspace),
    };
  }

  function publicWorkspace(workspace) {
    return {
      schema: WORKSPACE_SCHEMA,
      workspaceId: workspace.workspaceId,
      displayName: workspace.displayName,
      rootDisplayPath: displayPath(workspace.rootPath),
      ownership: workspace.ownership,
      isDefault: workspace.isDefault === true,
      permissions: OPERATIONS,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  function displayPath(rootPath) {
    const home = resolve(homedir());
    if (rootPath === home) return "~";
    if (rootPath.startsWith(home + sep)) return `~${rootPath.slice(home.length)}`;
    return rootPath;
  }

  async function route(req, res, url, path, requireDevice) {
    if (path === "/aru/v1/node-workspaces" && req.method === "GET") {
      requireDevice(req);
      sendJSON(res, 200, inventory());
      return true;
    }
    if (path === "/aru/v1/node-workspaces" && req.method === "POST") {
      requireDevice(req);
      requireLoopback(req);
      await authorize(req, res);
      return true;
    }
    const matched = matchRoute(path);
    if (!matched) return false;
    const device = requireDevice(req);
    await handleRoute(req, res, url, matched, device);
    return true;
  }

  async function authorize(req, res) {
    requireAvailable();
    const body = await readJSONBody(req, 64 * 1024);
    const requestedPath = String(body.rootPath ?? "").trim();
    if (!requestedPath || !isAbsolute(requestedPath)) {
      throw new HttpError(400, "node_workspace.root_invalid", "rootPath must be an absolute directory");
    }
    let rootPath;
    try {
      rootPath = realpathSync(requestedPath);
    } catch {
      throw new HttpError(400, "node_workspace.root_unavailable", "selected directory is unavailable");
    }
    if (!statSync(rootPath).isDirectory()) {
      throw new HttpError(400, "node_workspace.root_invalid", "selected root is not a directory");
    }
    const requestedName = String(body.displayName ?? "").trim();
    const displayName = requestedName || rootPath.split(sep).filter(Boolean).pop() || rootPath;
    const existing = state.nodeWorkspaces.find((workspace) =>
      workspace.deletedAt === null && workspace.rootPath === rootPath);
    const now = Date.now();
    if (existing) {
      if (existing.ownership !== HOST_MANAGED_OWNERSHIP) {
        existing.displayName = displayName;
        existing.updatedAt = now;
        saveState();
      }
      sendJSON(res, 200, publicWorkspace(existing));
      return;
    }
    const workspace = {
      workspaceId: `nw_${randomUUID()}`,
      displayName,
      rootPath,
      ownership: USER_GRANTED_OWNERSHIP,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    state.nodeWorkspaces.push(workspace);
    saveState();
    log(`authorized node workspace ${workspace.workspaceId}`);
    sendJSON(res, 201, publicWorkspace(workspace));
  }

  function matchRoute(path) {
    const match = /^\/aru\/v1\/node-workspaces\/([^/]+)(?:\/(files|file|directory|move|path))?$/.exec(path);
    if (!match) return null;
    let workspaceId;
    try {
      workspaceId = decodeURIComponent(match[1]);
    } catch {
      throw new HttpError(400, "node_workspace.id_invalid", "workspace id is invalid");
    }
    return { workspaceId, action: match[2] ?? null };
  }

  async function handleRoute(req, res, url, route, device) {
    requireAvailable();
    const workspace = workspaceById(route.workspaceId);
    if (route.action === null && req.method === "DELETE") {
      requireLoopback(req);
      if (workspace.ownership === HOST_MANAGED_OWNERSHIP || workspace.isDefault === true) {
        throw new HttpError(
          409,
          "node_workspace.managed_required",
          "the Host-managed default workspace cannot be revoked",
        );
      }
      workspace.deletedAt = Date.now();
      workspace.updatedAt = workspace.deletedAt;
      saveState();
      log(`revoked node workspace ${workspace.workspaceId}`);
      sendJSON(res, 200, {
        workspaceId: workspace.workspaceId,
        deleted: true,
        deletedAt: workspace.deletedAt,
      });
      return;
    }
    if (route.action === "files" && req.method === "GET") {
      sendJSON(res, 200, listFiles(workspace, String(url.searchParams.get("path") ?? "")));
      return;
    }
    if (route.action === "file" && req.method === "GET") {
      sendJSON(res, 200, readText(workspace, String(url.searchParams.get("path") ?? "")));
      return;
    }
    if (route.action === "file" && req.method === "PUT") {
      const body = await readJSONBody(req, config.maxWorkspaceBytes + 64 * 1024);
      sendJSON(res, 200, writeText(workspace, requiredBodyString(body, "path"), body.content, device));
      return;
    }
    if (route.action === "directory" && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, createDirectory(workspace, requiredBodyString(body, "path"), device));
      return;
    }
    if (route.action === "move" && req.method === "POST") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, movePath(
        workspace,
        requiredBodyString(body, "fromPath"),
        requiredBodyString(body, "toPath"),
        device,
      ));
      return;
    }
    if (route.action === "path" && req.method === "DELETE") {
      sendJSON(res, 200, deletePath(workspace, String(url.searchParams.get("path") ?? ""), device));
      return;
    }
    throw new HttpError(404, "route.unknown", "unknown node workspace route");
  }

  function workspaceById(workspaceId) {
    const normalized = String(workspaceId ?? "").trim();
    if (!/^nw_[0-9a-f-]{36}$/i.test(normalized)) {
      throw new HttpError(400, "node_workspace.id_invalid", "workspace id is invalid");
    }
    const workspace = state.nodeWorkspaces.find((candidate) =>
      candidate.workspaceId === normalized && candidate.deletedAt === null);
    if (!workspace) {
      throw new HttpError(404, "node_workspace.unknown", "computer workspace is unavailable");
    }
    return workspace;
  }

  function listFiles(workspace, relativePath) {
    const directory = resolvePath(workspace, relativePath, false);
    if (!statSync(directory).isDirectory()) {
      throw new HttpError(400, "node_workspace.not_directory", "requested path is not a directory");
    }
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const childRelativePath = childPath(relativePath, entry.name);
        const child = resolvePath(workspace, childRelativePath, false);
        const stats = statSync(child);
        return {
          path: childRelativePath,
          kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
          byteCount: entry.isFile() ? stats.size : null,
          modifiedAt: Math.round(stats.mtimeMs),
        };
      });
    return { workspaceId: workspace.workspaceId, path: normalizeRelativePath(relativePath), entries };
  }

  function readText(workspace, relativePath) {
    const normalizedPath = requireNonRootPath(relativePath);
    const file = resolvePath(workspace, normalizedPath, false);
    const stats = statSync(file);
    if (!stats.isFile()) {
      throw new HttpError(400, "node_workspace.not_file", "requested path is not a file");
    }
    if (stats.size > config.maxWorkspaceBytes) {
      throw new HttpError(413, "node_workspace.file_too_large", "file exceeds the configured workspace budget");
    }
    const data = readFileSync(file);
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new HttpError(415, "node_workspace.not_utf8", "only UTF-8 text files can be read through this capability");
    }
    return { workspaceId: workspace.workspaceId, path: normalizedPath, content, byteCount: data.length };
  }

  function writeText(workspace, relativePath, content, device) {
    const normalizedPath = requireNonRootPath(relativePath);
    if (typeof content !== "string") {
      throw new HttpError(400, "node_workspace.content_invalid", "content must be a string");
    }
    const encoded = Buffer.from(content, "utf8");
    if (encoded.length > config.maxWorkspaceBytes) {
      throw new HttpError(413, "node_workspace.file_too_large", "content exceeds the configured workspace budget");
    }
    const file = resolvePath(workspace, normalizedPath, true);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, encoded);
    log(`wrote node workspace path ${workspace.workspaceId}:${normalizedPath} for ${device.deviceId}`);
    return { workspaceId: workspace.workspaceId, path: normalizedPath, byteCount: encoded.length, updatedAt: Date.now() };
  }

  function createDirectory(workspace, relativePath, device) {
    const normalizedPath = requireNonRootPath(relativePath);
    const directory = resolvePath(workspace, normalizedPath, true);
    mkdirSync(directory, { recursive: true });
    log(`created node workspace directory ${workspace.workspaceId}:${normalizedPath} for ${device.deviceId}`);
    return { workspaceId: workspace.workspaceId, path: normalizedPath, created: true, updatedAt: Date.now() };
  }

  function movePath(workspace, fromPath, toPath, device) {
    const normalizedFrom = requireNonRootPath(fromPath);
    const normalizedTo = requireNonRootPath(toPath);
    const source = resolvePath(workspace, normalizedFrom, false);
    const destination = resolvePath(workspace, normalizedTo, true);
    if (existsSync(destination)) {
      throw new HttpError(409, "node_workspace.destination_exists", "destination already exists");
    }
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
    log(`moved node workspace path ${workspace.workspaceId}:${normalizedFrom} for ${device.deviceId}`);
    return {
      workspaceId: workspace.workspaceId,
      fromPath: normalizedFrom,
      toPath: normalizedTo,
      moved: true,
      updatedAt: Date.now(),
    };
  }

  function deletePath(workspace, relativePath, device) {
    const normalizedPath = requireNonRootPath(relativePath);
    const target = resolvePath(workspace, normalizedPath, false);
    rmSync(target, { recursive: true, force: false });
    log(`deleted node workspace path ${workspace.workspaceId}:${normalizedPath} for ${device.deviceId}`);
    return { workspaceId: workspace.workspaceId, path: normalizedPath, deleted: true, deletedAt: Date.now() };
  }

  function requiredBodyString(body, name) {
    const value = body?.[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new HttpError(400, "node_workspace.argument_invalid", `${name} must be a non-empty string`);
    }
    return value;
  }

  function requireNonRootPath(value) {
    const normalized = normalizeRelativePath(value);
    if (!normalized) {
      throw new HttpError(400, "node_workspace.root_mutation_denied", "the workspace root cannot be mutated");
    }
    return normalized;
  }

  function normalizeRelativePath(value) {
    const raw = String(value ?? "").trim();
    if (!raw || raw === ".") return "";
    if (isAbsolute(raw) || raw.startsWith("~")) {
      throw new HttpError(400, "node_workspace.path_outside_root", "path must be relative to the workspace root");
    }
    const parts = raw.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      throw new HttpError(400, "node_workspace.path_outside_root", "path contains an invalid component");
    }
    return parts.join("/");
  }

  function childPath(parent, child) {
    const normalizedParent = normalizeRelativePath(parent);
    return normalizedParent ? `${normalizedParent}/${child}` : child;
  }

  function resolvePath(workspace, relativePath, allowMissing) {
    const normalized = normalizeRelativePath(relativePath);
    let root;
    try {
      root = realpathSync(workspace.rootPath);
    } catch {
      throw new HttpError(410, "node_workspace.root_unavailable", "workspace root is unavailable");
    }
    const candidate = resolve(root, normalized);
    ensureInsideRoot(candidate, root);
    if (existsSync(candidate)) {
      let resolvedCandidate;
      try {
        resolvedCandidate = realpathSync(candidate);
      } catch {
        throw new HttpError(404, "node_workspace.path_unavailable", "workspace path is unavailable");
      }
      ensureInsideRoot(resolvedCandidate, root);
      return resolvedCandidate;
    }
    if (!allowMissing) {
      throw new HttpError(404, "node_workspace.path_unavailable", "workspace path is unavailable");
    }
    let ancestor = dirname(candidate);
    while (!existsSync(ancestor) && ancestor !== root) ancestor = dirname(ancestor);
    ensureInsideRoot(realpathSync(ancestor), root);
    return candidate;
  }

  function ensureInsideRoot(path, root) {
    if (path !== root && !path.startsWith(root + sep)) {
      throw new HttpError(403, "node_workspace.path_outside_root", "workspace path escaped its root");
    }
  }

  function tools() {
    if (!supported) return [];
    return [
      mcpOperationTool({
        name: "aru_node_workspace_inventory",
        title: "Aru node workspace inventory",
        description: "List computer workspaces. The Host-managed default workspace is first and is the safe destination when the user did not name another folder; external paths still require explicit local grants.",
        readOnlyHint: true,
        idempotentHint: true,
      }),
      mcpOperationTool({
        name: "aru_node_workspace_files",
        title: "List files in a computer workspace",
        description: "List direct children under one known computer workspace path.",
        properties: {
          workspaceId: mcpIdentifierSchema("Workspace id from aru_node_workspace_inventory."),
          path: { type: "string", description: "Relative directory path; use an empty string for the workspace root." },
        },
        required: ["workspaceId", "path"],
        readOnlyHint: true,
        idempotentHint: true,
      }),
      mcpOperationTool({
        name: "aru_node_workspace_read_text",
        title: "Read a text file from a computer workspace",
        description: "Read one UTF-8 text file below a known computer workspace root.",
        properties: {
          workspaceId: mcpIdentifierSchema("Workspace id from aru_node_workspace_inventory."),
          path: { type: "string", description: "Relative file path." },
        },
        required: ["workspaceId", "path"],
        readOnlyHint: true,
        idempotentHint: true,
      }),
      mcpOperationTool({
        name: "aru_node_workspace_write_text",
        title: "Write a text file in a computer workspace",
        description: "Create or replace one UTF-8 text file below a known computer workspace root.",
        properties: {
          workspaceId: mcpIdentifierSchema("Workspace id from aru_node_workspace_inventory."),
          path: { type: "string", description: "Relative file path." },
          content: { type: "string", description: "Complete UTF-8 text content." },
        },
        required: ["workspaceId", "path", "content"],
        destructiveHint: true,
        idempotentHint: true,
      }),
      mcpOperationTool({
        name: "aru_node_workspace_create_directory",
        title: "Create a directory in a computer workspace",
        description: "Create a directory below a known computer workspace root.",
        properties: {
          workspaceId: mcpIdentifierSchema("Workspace id from aru_node_workspace_inventory."),
          path: { type: "string", description: "Relative directory path." },
        },
        required: ["workspaceId", "path"],
        destructiveHint: true,
        idempotentHint: true,
      }),
      mcpOperationTool({
        name: "aru_node_workspace_move",
        title: "Move a path in a computer workspace",
        description: "Move a file or directory within the same known workspace root.",
        properties: {
          workspaceId: mcpIdentifierSchema("Workspace id from aru_node_workspace_inventory."),
          fromPath: { type: "string", description: "Existing relative source path." },
          toPath: { type: "string", description: "New relative destination path." },
        },
        required: ["workspaceId", "fromPath", "toPath"],
        destructiveHint: true,
      }),
      mcpOperationTool({
        name: "aru_node_workspace_delete",
        title: "Delete a path from a computer workspace",
        description: "Delete a file or directory below a known workspace root. The root itself cannot be deleted.",
        properties: {
          workspaceId: mcpIdentifierSchema("Workspace id from aru_node_workspace_inventory."),
          path: { type: "string", description: "Relative file or directory path." },
        },
        required: ["workspaceId", "path"],
        destructiveHint: true,
      }),
    ];
  }

  function callTool(name, args, device) {
    if (!supported || !TOOL_NAMES.has(name)) return { matched: false, value: null };
    if (name === "aru_node_workspace_inventory") return { matched: true, value: inventory() };
    const workspace = workspaceById(requiredMCPString(args, "workspaceId"));
    if (name === "aru_node_workspace_files") {
      return { matched: true, value: listFiles(workspace, requiredMCPString(args, "path", true)) };
    }
    if (name === "aru_node_workspace_read_text") {
      return { matched: true, value: readText(workspace, requiredMCPString(args, "path")) };
    }
    if (name === "aru_node_workspace_write_text") {
      return { matched: true, value: writeText(
        workspace,
        requiredMCPString(args, "path"),
        requiredMCPString(args, "content", true),
        device,
      ) };
    }
    if (name === "aru_node_workspace_create_directory") {
      return { matched: true, value: createDirectory(workspace, requiredMCPString(args, "path"), device) };
    }
    if (name === "aru_node_workspace_move") {
      return { matched: true, value: movePath(
        workspace,
        requiredMCPString(args, "fromPath"),
        requiredMCPString(args, "toPath"),
        device,
      ) };
    }
    return { matched: true, value: deletePath(workspace, requiredMCPString(args, "path"), device) };
  }

  function requiredMCPString(args, name, allowsEmpty = false) {
    const value = args[name];
    if (typeof value !== "string" || (!allowsEmpty && value.trim() === "")) {
      throw new HttpError(400, "mcp.argument_invalid", `${name} must be ${allowsEmpty ? "a" : "a non-empty"} string`);
    }
    return allowsEmpty ? value : value.trim();
  }

  return {
    ensureManagedWorkspace,
    manifestCapability,
    route,
    tools,
    callTool,
    count: () => state.nodeWorkspaces.filter((entry) => entry.deletedAt === null).length,
    diagnosticsCapability: () => ({ id: "node-workspaces", enabled: supported }),
  };
}
