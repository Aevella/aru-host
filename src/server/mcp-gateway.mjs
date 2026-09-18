import { randomUUID } from "node:crypto";
export function createMCPGateway({ config, state, nodeControl, backupSettings, HttpError, readJSONBody, sendJSON, sendEmpty, officialMCPTools, workspaceJobInventory, workspaceJob, publicWorkspaceJob, cancelWorkspaceJob, retryWorkspaceJob, artifactInventory, deleteArtifact, MCP_PROTOCOL_VERSION, SERVER_VERSION, WORKSPACE_JOB_EVENTS_SCHEMA, getPluginSupervisor, getCollaboratorHost, getNodeWorkspaceHost }) {
const mcpSessions = new Map();
async function handleMCP(req, res, device) {
  const body = await readJSONBody(req, config.maxWorkspaceBytes);
  if (body?.jsonrpc !== "2.0" || typeof body?.method !== "string") {
    return sendMCPError(res, body?.id ?? null, -32600, "Invalid Request");
  }

  if (body.method === "initialize") {
    const sessionId = `mcp_${randomUUID()}`;
    mcpSessions.set(sessionId, device.deviceId);
    return sendJSON(res, 200, {
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "Aru Self-Hosted MCP Gateway", version: SERVER_VERSION },
      },
    }, mcpResponseHeaders(sessionId));
  }

  const sessionId = String(req.headers["mcp-session-id"] ?? "").trim();
  if (!sessionId || mcpSessions.get(sessionId) !== device.deviceId) {
    throw new HttpError(404, "mcp.session_unknown", "MCP session is missing or expired");
  }

  if (body.method === "notifications/initialized") {
    return sendEmpty(res, 202, mcpResponseHeaders(sessionId));
  }
  if (body.method === "ping") {
    return sendMCPResult(res, sessionId, body.id, {});
  }
  if (body.method === "tools/list") {
    return sendMCPResult(res, sessionId, body.id, {
      tools: [...officialMCPTools(), ...getPluginSupervisor().dynamicMCPTools()],
    });
  }
  if (body.method === "tools/call") {
    const name = String(body.params?.name ?? "").trim();
    const args = body.params?.arguments;
    if (!name) return sendMCPError(res, body.id, -32602, "Tool name is required", sessionId);
    if (args !== undefined && (args === null || Array.isArray(args) || typeof args !== "object")) {
      return sendMCPError(res, body.id, -32602, "Tool arguments must be an object", sessionId);
    }
    return await callMCPTool(res, sessionId, body.id, name, args ?? {}, device);
  }
  return sendMCPError(res, body.id ?? null, -32601, "Method not found", sessionId);
}

async function callMCPTool(res, sessionId, id, name, args, device) {
  try {
    const structuredContent = await executeMCPTool(name, args, device);
    return sendMCPResult(res, sessionId, id, {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const structuredContent = { code: error.code, message: error.message };
    if (error.issues?.length) structuredContent.issues = error.issues;
    if (error.recovery) structuredContent.recovery = error.recovery;
    return sendMCPResult(res, sessionId, id, {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: true,
    });
  }
}

async function executeMCPTool(name, args, device) {
    const tool = [...officialMCPTools(), ...getPluginSupervisor().dynamicMCPTools()]
      .find((candidate) => candidate.name === name);
    if (!tool) throw new HttpError(400, "mcp.tool_unknown", `Unknown tool: ${name}`);
    validateMCPToolArguments(tool, args);
    let structuredContent;
    const nodeWorkspaceCall = getNodeWorkspaceHost().callTool(name, args, device);
    if (nodeWorkspaceCall.matched) {
      structuredContent = nodeWorkspaceCall.value;
    } else if (name.startsWith("aru_collaborator_surface_")) {
      const surfaceCall = getCollaboratorHost().callSurfaceTool(name, args, device);
      if (!surfaceCall.matched) {
        throw new HttpError(400, "mcp.tool_unknown", `Unknown tool: ${name}`);
      }
      structuredContent = surfaceCall.value;
    } else if (name.startsWith("aru_collaborator_project_")) {
      const projectCall = getCollaboratorHost().callProjectTool(name, args, device);
      if (!projectCall.matched) {
        throw new HttpError(400, "mcp.tool_unknown", `Unknown tool: ${name}`);
      }
      structuredContent = await projectCall.value;
    } else if (name === "aru_node_status") {
      structuredContent = {
        serverId: state.serverId,
        displayName: nodeControl.displayName(),
        serverVersion: SERVER_VERSION,
        packageCount: state.packages.length,
        activeDeviceCount: state.devices.filter((entry) => !entry.revokedAt).length,
        workspaceRuntimeAvailable: config.containerRuntime !== null,
        workspaceRuntimeDescription: config.containerRuntime !== null
          ? "Container runtime configured for isolated Node/Python/Shell jobs and OCI plugins. Job execution verifies actual readiness. Project files and page publication are independent."
          : "Optional containers are not configured. Isolated Node/Python/Shell jobs and OCI plugins need Podman or Docker. Project files, page publication, pairing, and model drivers are independent. Use Host Console > Runtime for installation and verification.",
      };
    } else if (name === "aru_node_settings") {
      structuredContent = nodeControl.publicSettings();
    } else if (name === "aru_node_rename") {
      structuredContent = nodeControl.updateSettings({
        schema: "aru.selfhost.node-settings.v1",
        displayName: mcpRequiredString(args, "displayName"),
        expectedRevision: args.expectedRevision,
      }, device);
    } else if (name === "aru_backup_inventory") {
      structuredContent = {
        packages: [...state.packages]
          .sort((left, right) => right.uploadedAt - left.uploadedAt ||
            left.remotePackageId.localeCompare(right.remotePackageId))
          .map((entry) => ({
          remotePackageId: entry.remotePackageId,
          uploadedAt: entry.uploadedAt,
          sourceName: entry.metadata?.sourceName ?? "",
          createdAt: entry.metadata?.createdAt ?? 0,
          objectCounts: entry.metadata?.objectCounts ?? {},
          packageByteCount: entry.metadata?.packageByteCount ?? 0,
        })),
      };
    } else if (name === "aru_backup_settings") {
      structuredContent = backupSettings.publicSettings();
    } else if (name === "aru_backup_settings_update") {
      structuredContent = backupSettings.updateSettings({
        schema: "aru.selfhost.backup-settings.v1",
        retentionMode: args.retentionMode,
        keepLatestCount: args.keepLatestCount,
        expectedRevision: args.expectedRevision,
      }, device);
    } else if (name === "aru_backup_delete") {
      structuredContent = deleteBackupPackage(
        mcpRequiredString(args, "remotePackageId"), device.deviceId);
    } else if (name === "aru_paired_devices") {
      structuredContent = nodeControl.deviceInventory(device.deviceId);
    } else if (name === "aru_job_inventory") {
      structuredContent = workspaceJobInventory();
    } else if (name === "aru_job_status") {
      const job = workspaceJob(mcpRequiredString(args, "jobId"));
      if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
      structuredContent = publicWorkspaceJob(job, true);
    } else if (name === "aru_job_events") {
      const job = workspaceJob(mcpRequiredString(args, "jobId"));
      if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
      structuredContent = { schema: WORKSPACE_JOB_EVENTS_SCHEMA, jobId: job.jobId, events: job.events };
    } else if (name === "aru_job_cancel") {
      structuredContent = cancelWorkspaceJob(mcpRequiredString(args, "jobId"), device);
    } else if (name === "aru_job_retry") {
      structuredContent = retryWorkspaceJob(mcpRequiredString(args, "jobId"), device);
    } else if (name === "aru_artifact_inventory") {
      structuredContent = artifactInventory();
    } else if (name === "aru_artifact_delete") {
      structuredContent = deleteArtifact(mcpRequiredString(args, "artifactId"), device);
    } else if (name === "aru_plugin_inventory") {
      structuredContent = getPluginSupervisor().inventory();
    } else if (name === "aru_plugin_workshop_guide") {
      structuredContent = getPluginSupervisor().workshopGuide();
    } else if (name === "aru_plugin_source_validate") {
      structuredContent = await getPluginSupervisor().validateSourceDraft(args);
    } else if (name === "aru_plugin_source_save_draft") {
      structuredContent = await getPluginSupervisor().saveSourceDraft(args, device);
    } else if (name === "aru_plugin_source_apply") {
      structuredContent = await getPluginSupervisor().applySource(args, device);
    } else if (name === "aru_plugin_draft_inventory") {
      structuredContent = getPluginSupervisor().draftInventory();
    } else if (name === "aru_plugin_status") {
      structuredContent = getPluginSupervisor().status(mcpRequiredString(args, "pluginId"));
    } else if (name === "aru_plugin_install") {
      structuredContent = await getPluginSupervisor().install(mcpPluginMutation(args), device);
    } else if (name === "aru_plugin_enable") {
      structuredContent = await getPluginSupervisor().enable(mcpRequiredString(args, "pluginId"), device);
    } else if (name === "aru_plugin_disable") {
      structuredContent = getPluginSupervisor().disable(mcpRequiredString(args, "pluginId"), device);
    } else if (name === "aru_plugin_upgrade") {
      structuredContent = await getPluginSupervisor().upgrade(
        mcpRequiredString(args, "pluginId"), mcpPluginMutation(args), device);
    } else if (name === "aru_plugin_rollback") {
      structuredContent = await getPluginSupervisor().rollback(mcpRequiredString(args, "pluginId"), device);
    } else if (name === "aru_plugin_uninstall") {
      structuredContent = getPluginSupervisor().uninstall(
        mcpRequiredString(args, "pluginId"), mcpRequiredBoolean(args, "deleteData"), device);
    } else {
      const dynamic = await getPluginSupervisor().callDynamicMCPTool(name, args);
      if (!dynamic.matched) {
        throw new HttpError(400, "mcp.tool_unknown", `Unknown tool: ${name}`);
      }
      structuredContent = dynamic.value;
    }
    return structuredContent;
}

function mcpRequiredString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "mcp.argument_invalid", `${name} must be a non-empty string`);
  }
  return value.trim();
}

function validateMCPToolArguments(tool, args) {
  const schema = tool.inputSchema;
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (!(name in args)) {
      throw new HttpError(400, "mcp.argument_missing", `${name} is required`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property) {
      throw new HttpError(400, "mcp.argument_unknown", `${name} is not accepted by ${tool.name}`);
    }
    if (property.type === "string" && typeof value !== "string") {
      throw new HttpError(400, "mcp.argument_invalid", `${name} must be a string`);
    }
    if (property.type === "boolean" && typeof value !== "boolean") {
      throw new HttpError(400, "mcp.argument_invalid", `${name} must be a boolean`);
    }
    if (property.type === "object" &&
        (value === null || Array.isArray(value) || typeof value !== "object")) {
      throw new HttpError(400, "mcp.argument_invalid", `${name} must be an object`);
    }
  }
}

function mcpRequiredBoolean(args, name) {
  if (typeof args[name] !== "boolean") {
    throw new HttpError(400, "mcp.argument_invalid", `${name} must be a boolean`);
  }
  return args[name];
}

function mcpPluginMutation(args) {
  if (!args.manifest || Array.isArray(args.manifest) || typeof args.manifest !== "object" ||
      !args.grantedPermissions || Array.isArray(args.grantedPermissions) ||
      typeof args.grantedPermissions !== "object") {
    throw new HttpError(400, "mcp.argument_invalid", "manifest and grantedPermissions must be objects");
  }
  return {
    schema: "aru.selfhost.plugin-mutation.v1",
    manifest: args.manifest,
    grantedPermissions: args.grantedPermissions,
  };
}

function sendMCPResult(res, sessionId, id, result) {
  return sendJSON(res, 200, { jsonrpc: "2.0", id: id ?? null, result },
    mcpResponseHeaders(sessionId));
}

function sendMCPError(res, id, code, message, sessionId = null) {
  return sendJSON(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    mcpResponseHeaders(sessionId));
}

function mcpResponseHeaders(sessionId = null) {
  return {
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    // MCP session identity lives in the header, not the TCP connection. A
    // fresh connection prevents the next iOS call from reusing a LAN socket
    // that became stale while a VPN or local route changed underneath it.
    connection: "close",
  };
}

// ---------------------------------------------------------------------------
// Backup vault


return { handleMCP, executeMCPTool };
}
