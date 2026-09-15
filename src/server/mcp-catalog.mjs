export function createMCPCatalog({  }) {
const MCP_TOOLS = [
  {
    name: "aru_node_status",
    title: "Aru node status",
    description: "Read this self-hosted Aru node's public runtime and capability status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        displayName: { type: "string" },
        serverVersion: { type: "string" },
        packageCount: { type: "integer" },
        activeDeviceCount: { type: "integer" },
        workspaceRuntimeAvailable: { type: "boolean", description: "Whether a container runtime is configured for isolated Node/Python/Shell jobs and OCI plugins. Does not gate project files, page publication, pairing, or model drivers; not a live engine health probe." },
        workspaceRuntimeDescription: { type: "string" },
      },
      required: [
        "serverId", "displayName", "serverVersion", "packageCount",
        "activeDeviceCount", "workspaceRuntimeAvailable",
      ],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "aru_node_settings",
    title: "Aru node settings",
    description: "Read this node's editable identity settings and current revision.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        schema: { type: "string" },
        displayName: { type: "string" },
        revision: { type: "integer" },
        updatedAt: { type: "integer" },
      },
      required: ["schema", "displayName", "revision", "updatedAt"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  mcpOperationTool({
    name: "aru_node_rename",
    title: "Rename Aru node",
    description: "Rename this node using the revision returned by aru_node_settings so concurrent changes cannot be overwritten.",
    properties: {
      displayName: { type: "string", minLength: 1, maxLength: 80, description: "New user-visible node name." },
      expectedRevision: { type: "integer", minimum: 1, description: "Revision returned by aru_node_settings." },
    },
    required: ["displayName", "expectedRevision"],
    idempotentHint: true,
  }),
  {
    name: "aru_backup_inventory",
    title: "Aru backup inventory",
    description: "List encrypted backup points stored on this node without returning package bytes or credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        packages: { type: "array", items: { type: "object" } },
      },
      required: ["packages"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  mcpOperationTool({
    name: "aru_backup_settings",
    title: "Aru backup settings",
    description: "Read the Host-owned backup retention policy shared by every paired Aru client.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_backup_settings_update",
    title: "Update Aru backup settings",
    description: "Update the Host-owned backup retention policy using its current revision, then apply it immediately.",
    properties: {
      retentionMode: { type: "string", enum: ["keep-all", "keep-latest"], description: "Whether the Host keeps every backup or only the newest count." },
      keepLatestCount: { type: ["integer", "null"], minimum: 1, description: "Required for keep-latest; null for keep-all." },
      expectedRevision: { type: "integer", minimum: 1, description: "Revision returned by aru_backup_settings." },
    },
    required: ["retentionMode", "keepLatestCount", "expectedRevision"],
    idempotentHint: true,
    destructiveHint: true,
  }),
  mcpOperationTool({
    name: "aru_backup_delete",
    title: "Delete Aru remote backup",
    description: "Delete one encrypted remote backup point. This never deletes local Aru data or downloaded restore staging.",
    properties: { remotePackageId: mcpIdentifierSchema("Remote backup package id from aru_backup_inventory.") },
    required: ["remotePackageId"],
    destructiveHint: true,
    idempotentHint: false,
  }),
  {
    name: "aru_paired_devices",
    title: "Aru paired devices",
    description: "List paired device identities and revocation state without returning credential material.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        devices: { type: "array", items: { type: "object" } },
      },
      required: ["devices"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  mcpOperationTool({
    name: "aru_job_inventory",
    title: "Aru workspace job inventory",
    description: "List durable workspace jobs on this node without returning submitted workspace snapshots.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_job_status",
    title: "Aru workspace job status",
    description: "Read one durable workspace job, including its result after completion but never its submitted input snapshot.",
    properties: { jobId: mcpIdentifierSchema("Durable workspace job id.") },
    required: ["jobId"],
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_job_events",
    title: "Aru workspace job events",
    description: "Read the ordered state-event history for one durable workspace job.",
    properties: { jobId: mcpIdentifierSchema("Durable workspace job id.") },
    required: ["jobId"],
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_job_cancel",
    title: "Cancel Aru workspace job",
    description: "Explicitly cancel a queued or running durable workspace job.",
    properties: { jobId: mcpIdentifierSchema("Durable workspace job id.") },
    required: ["jobId"],
    destructiveHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_job_retry",
    title: "Retry Aru workspace job",
    description: "Create a new linked retry for a failed, cancelled, or timed-out workspace job.",
    properties: { jobId: mcpIdentifierSchema("Predecessor workspace job id.") },
    required: ["jobId"],
  }),
  mcpOperationTool({
    name: "aru_artifact_inventory",
    title: "Aru artifact inventory",
    description: "List immutable binary workspace artifacts stored on this node, including hashes and producer metadata.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_artifact_delete",
    title: "Delete Aru remote artifact",
    description: "Delete one remote artifact handle; already imported local Aru assets are not deleted.",
    properties: { artifactId: mcpIdentifierSchema("Remote artifact id.") },
    required: ["artifactId"],
    destructiveHint: true,
    idempotentHint: false,
  }),
  mcpOperationTool({
    name: "aru_plugin_inventory",
    title: "Aru plugin inventory",
    description: "List installed self-hosted plugins, reviewed permissions, desired state, health, and rollback availability.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_workshop_guide",
    title: "Read Aru plugin workshop guide",
    description: "Read the source-plugin contract, isolation rules, lifecycle, and a complete example before authoring a tool.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_source_validate",
    title: "Validate Aru source plugin",
    description: "Validate pluginId, displayName, version, sourceCode, and optional named capabilities. Omit capabilities for zero authority; supported values are persistent-storage and network-outbound.",
    properties: sourcePluginWorkshopProperties(),
    required: ["pluginId", "displayName", "version", "sourceCode"],
    destructiveHint: true,
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_source_save_draft",
    title: "Save Aru source plugin draft",
    description: "Validate and save a visible editable plugin draft without changing the installed release. Drafts are optional checkpoints, not an activation requirement.",
    properties: sourcePluginWorkshopProperties(),
    required: ["pluginId", "displayName", "version", "sourceCode"],
    destructiveHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_source_apply",
    title: "Apply Aru source plugin",
    description: "Validate, publish, and enable a source plugin in one confirmed operation. A failed update restores the previous working release; a failed first install remains visible for repair.",
    properties: sourcePluginWorkshopProperties(),
    required: ["pluginId", "displayName", "version", "sourceCode"],
    destructiveHint: true,
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_draft_inventory",
    title: "Aru plugin draft inventory",
    description: "List visible source-plugin editing checkpoints without returning their source bodies.",
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_status",
    title: "Aru plugin status",
    description: "Read the complete lifecycle receipt for one installed self-hosted plugin.",
    properties: { pluginId: mcpIdentifierSchema("Installed plugin id.") },
    required: ["pluginId"],
    readOnlyHint: true,
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_install",
    title: "Install Aru plugin",
    description: "Install a reviewed digest-pinned OCI plugin disabled by default. grantedPermissions must exactly match manifest.permissions.",
    properties: {
      manifest: { type: "object", description: "aru.selfhost.plugin-manifest.v1 manifest." },
      grantedPermissions: { type: "object", description: "Exact user-reviewed permission receipt." },
    },
    required: ["manifest", "grantedPermissions"],
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_enable",
    title: "Enable Aru plugin",
    description: "Explicitly start an installed self-hosted plugin under its reviewed isolation grant.",
    properties: { pluginId: mcpIdentifierSchema("Installed plugin id.") },
    required: ["pluginId"],
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_disable",
    title: "Disable Aru plugin",
    description: "Stop an installed self-hosted plugin without removing its package receipt or isolated data.",
    properties: { pluginId: mcpIdentifierSchema("Installed plugin id.") },
    required: ["pluginId"],
    idempotentHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_upgrade",
    title: "Upgrade Aru plugin",
    description: "Upgrade an installed plugin to a reviewed digest-pinned manifest, restoring the prior release if startup fails.",
    properties: {
      pluginId: mcpIdentifierSchema("Installed plugin id."),
      manifest: { type: "object", description: "Replacement aru.selfhost.plugin-manifest.v1 manifest." },
      grantedPermissions: { type: "object", description: "Exact user-reviewed permission receipt for the replacement manifest." },
    },
    required: ["pluginId", "manifest", "grantedPermissions"],
    destructiveHint: true,
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_rollback",
    title: "Roll back Aru plugin",
    description: "Swap an installed plugin with its retained previous release.",
    properties: { pluginId: mcpIdentifierSchema("Installed plugin id.") },
    required: ["pluginId"],
    destructiveHint: true,
    openWorldHint: true,
  }),
  mcpOperationTool({
    name: "aru_plugin_uninstall",
    title: "Uninstall Aru plugin",
    description: "Uninstall one plugin and explicitly choose whether its isolated persistent data is deleted.",
    properties: {
      pluginId: mcpIdentifierSchema("Installed plugin id."),
      deleteData: { type: "boolean", description: "True deletes the isolated plugin volume; false retains it." },
    },
    required: ["pluginId", "deleteData"],
    destructiveHint: true,
  }),
];

function mcpIdentifierSchema(description) {
  return { type: "string", minLength: 1, description };
}

function sourcePluginWorkshopProperties() {
  return {
    pluginId: mcpIdentifierSchema("Stable lowercase plugin id."),
    displayName: { type: "string", minLength: 1, description: "User-visible plugin name." },
    version: { type: "string", minLength: 1, description: "Plugin release version." },
    sourceCode: { type: "string", minLength: 1, description: "JavaScript ESM source following aru_plugin_workshop_guide." },
    capabilities: {
      type: "array",
      description: "Optional explicit grants. Omit for zero authority.",
      items: { type: "string", enum: ["persistent-storage", "network-outbound"] },
      uniqueItems: true,
    },
  };
}

function mcpOperationTool({
  name,
  title,
  description,
  properties = {},
  required = [],
  readOnlyHint = false,
  destructiveHint = false,
  idempotentHint = false,
  openWorldHint = false,
}) {
  return {
    name,
    title,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint },
  };
}


return { MCP_TOOLS, mcpOperationTool, mcpIdentifierSchema };
}
