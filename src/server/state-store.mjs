import { readFileSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
export function createHostStateStore({ statePath, WORKSPACE_JOB_POLICY_SCHEMA, OFFICIAL_DEFAULT_MAXIMUM_RUNTIME_SECONDS }) {
let lastPersistedState = null;
function loadState() {
  let contents;
  try {
    contents = readFileSync(statePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw stateReadFailure(error.code);
    // A dangling symlink is an existing state entry, not a new installation.
    try {
      lstatSync(statePath);
    } catch (entryError) {
      if (entryError.code === "ENOENT") return freshState();
      throw stateReadFailure(entryError.code);
    }
    throw stateReadFailure("missing_symlink_target");
  }
  let loaded;
  try { loaded = JSON.parse(contents); }
  catch { throw stateReadFailure("invalid_json"); }
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(loaded) || typeof loaded.serverId !== "string" || !loaded.serverId.trim()) {
    throw stateReadFailure("invalid_identity");
  }
  // Missing optional collections occur in older releases. A present but
  // malformed collection is not an empty collection and must never be saved.
  const collections = ["devices", "packages", "artifacts", "jobs", "plugins",
    "pluginDrafts", "agentDriverProbes", "hostedCollaborators", "nodeWorkspaces",
    "conversationTurns", "mobileCollaboratorIdentities", "providerProfiles",
    "remotePushRegistrations", "liveActivityRegistrations", "wakeBridgeEndpoints", "wakeBridgeEvents"];
  for (const key of collections) {
    if (loaded[key] !== undefined && (!Array.isArray(loaded[key]) || !loaded[key].every(object))) {
      throw stateReadFailure("invalid_collection");
    }
  }
  lastPersistedState = contents;
  loaded.devices ??= [];
  loaded.packages ??= [];
  loaded.artifacts ??= [];
  loaded.jobs ??= [];
  loaded.plugins ??= [];
  loaded.pluginDrafts ??= [];
  for (const plugin of loaded.plugins) {
    plugin.events ??= [];
    plugin.lastErrorMessage ??= null;
  }
  loaded.agentDriverProbes ??= [];
  loaded.hostedCollaborators ??= [];
  loaded.nodeWorkspaces ??= [];
  loaded.conversationTurns ??= [];
  loaded.jobPolicy ??= {
    schema: WORKSPACE_JOB_POLICY_SCHEMA,
    defaultMaximumRuntimeSeconds: OFFICIAL_DEFAULT_MAXIMUM_RUNTIME_SECONDS,
    updatedAt: Date.now(),
  };
  return loaded;
}

function freshState() {
  return {
    serverId: `stub-${randomBytes(6).toString("hex")}`,
    devices: [],
    packages: [],
    artifacts: [],
    jobs: [],
    plugins: [],
    pluginDrafts: [],
    agentDriverProbes: [],
    hostedCollaborators: [],
    nodeWorkspaces: [],
    conversationTurns: [],
    nodeSettings: null,
    jobPolicy: {
      schema: WORKSPACE_JOB_POLICY_SCHEMA,
      defaultMaximumRuntimeSeconds: OFFICIAL_DEFAULT_MAXIMUM_RUNTIME_SECONDS,
      updatedAt: Date.now(),
    },
  };
}

function stateReadFailure(reason) {
  return new Error(`host.state_unreadable: Local Host state could not be read (${reason}). Startup stopped; state.json has not been replaced. Preserve the original file and check permissions or restore a verified backup. Do not delete the data directory or reinstall with data removal.`);
}

function saveState(state) {
  const next = JSON.stringify(state, null, 2);
  // Only a successfully admitted/saved revision can become the recovery copy.
  // Never rotate the possibly damaged on-disk primary into the backup.
  if (lastPersistedState !== null) writeStateFile(`${statePath}.bak`, lastPersistedState);
  writeStateFile(statePath, next);
  lastPersistedState = next;
}

function writeStateFile(destination, contents) {
  const temporaryPath = `${destination}.${process.pid}.tmp`;
  const descriptor = openSync(temporaryPath, "w", 0o600);
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  renameSync(temporaryPath, destination);
}


return { load: loadState, save: saveState };
}
