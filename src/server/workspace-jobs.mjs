import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
export function createWorkspaceJobs({ config, state, saveState, sendJSON, readJSONBody, HttpError, log, sha256Hex, persistWorkspaceArtifacts, artifactExtension, CONTAINER_STOP_GRACE_SECONDS, WORKSPACE_JOB_EVENTS_SCHEMA, WORKSPACE_JOB_INVENTORY_SCHEMA, WORKSPACE_JOB_POLICY_SCHEMA, WORKSPACE_JOB_SCHEMA, WORKSPACE_RESULT_SCHEMA, WORKSPACE_RUNTIMES, WORKSPACE_RUN_SCHEMA }) {
const activeJobProcesses = new Map();
function publicWorkspaceJobPolicy() {
  return {
    schema: WORKSPACE_JOB_POLICY_SCHEMA,
    defaultMaximumRuntimeSeconds: state.jobPolicy.defaultMaximumRuntimeSeconds,
    updatedAt: state.jobPolicy.updatedAt,
  };
}

async function handleWorkspaceJobPolicyUpdate(req, res, device) {
  const body = await readJSONBody(req, 64 * 1024);
  if (body?.schema !== WORKSPACE_JOB_POLICY_SCHEMA) {
    throw new HttpError(400, "job.policy_schema_unsupported", "unsupported workspace job policy schema");
  }
  const value = body.defaultMaximumRuntimeSeconds;
  const maximumRepresentableSeconds = Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 1000);
  if (value !== null &&
      (!Number.isSafeInteger(value) || value <= 0 || value > maximumRepresentableSeconds)) {
    throw new HttpError(400, "job.policy_runtime_invalid", "maximum runtime must be a positive integer or null");
  }
  state.jobPolicy = {
    schema: WORKSPACE_JOB_POLICY_SCHEMA,
    defaultMaximumRuntimeSeconds: value,
    updatedAt: Date.now(),
  };
  saveState();
  log(`workspace job policy updated by ${device.deviceId} maximum=${value ?? "unlimited"}`);
  sendJSON(res, 200, publicWorkspaceJobPolicy());
}

async function handleWorkspaceJobSubmit(req, res, device) {
  if (!config.containerRuntime) {
    throw new HttpError(503, "workspace.runtime_unavailable", "Docker or Podman is required");
  }
  const body = await readJSONBody(req, config.maxWorkspaceBytes);
  const run = validateWorkspaceRun(body);
  const inputHash = sha256Hex(Buffer.from(JSON.stringify(run)));
  const existing = state.jobs.find((job) => job.runId === run.runId);
  if (existing) {
    if (existing.inputHash !== inputHash) {
      throw new HttpError(409, "job.run_id_conflict", "runId already belongs to a different input snapshot");
    }
    return sendJSON(res, 200, publicWorkspaceJob(existing, true));
  }
  const job = createWorkspaceJob(run, device, null, inputHash);
  state.jobs.push(job);
  appendWorkspaceJobEvent(job, "queued", "Workspace job accepted");
  saveState();
  log(`workspace job queued ${job.jobId} run=${job.runId} device=${device.deviceId}`);
  sendJSON(res, 202, publicWorkspaceJob(job, true));
  setImmediate(() => executeWorkspaceJob(job.jobId));
}

function createWorkspaceJob(run, device, predecessorJobId, inputHash = null) {
  const now = Date.now();
  const maximumRuntimeSeconds = state.jobPolicy.defaultMaximumRuntimeSeconds;
  return {
    schema: WORKSPACE_JOB_SCHEMA,
    jobId: `job_${randomUUID()}`,
    runId: run.runId,
    projectId: run.projectId,
    runtime: run.runtime,
    state: "queued",
    predecessorJobId,
    queuedAt: now,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    failureCode: null,
    failureMessage: null,
    result: null,
    maximumRuntimeSeconds,
    budgetSource: maximumRuntimeSeconds === null ? "node_unlimited" : "node_default",
    deadlineAt: null,
    input: run,
    inputHash: inputHash ?? sha256Hex(Buffer.from(JSON.stringify(run))),
    createdByDeviceId: device.deviceId,
    cancelledByDeviceId: null,
    events: [],
  };
}

async function executeWorkspaceJob(jobId) {
  const job = workspaceJob(jobId);
  if (!job || job.state !== "queued") return;
  if (!config.containerRuntime) {
    failWorkspaceJob(job, "workspace.runtime_unavailable", "Docker or Podman is required");
    return;
  }
  transitionWorkspaceJob(job, "preparing", "Preparing isolated workspace");
  const workspaceDirectory = mkdtempSync(join(tmpdir(), "aru-workspace-"));
  chmodSync(workspaceDirectory, 0o777);
  const run = job.input;
  const temporaryEntry = run.code === null ? null : temporaryEntryName(run.runtime, run.runId);
  try {
    for (const file of run.files) {
      writeWorkspaceFile(workspaceDirectory, file.path, file.content);
    }
    if (temporaryEntry) {
      writeWorkspaceFile(workspaceDirectory, temporaryEntry, run.code, validateRuntimeEntryPath);
    }
    makeWorkspaceTreeWritable(workspaceDirectory);
    const entryPath = temporaryEntry ?? run.entryPath;
    const entryValidator = temporaryEntry ? validateRuntimeEntryPath : validateWorkspacePath;
    if (!entryPath || !existsSync(resolveWorkspacePath(workspaceDirectory, entryPath, entryValidator))) {
      throw new HttpError(400, "workspace.entry_missing", "entryPath does not name a workspace file");
    }

    if (job.state === "cancelled") return;
    job.startedAt ??= Date.now();
    if (job.maximumRuntimeSeconds !== null && job.maximumRuntimeSeconds !== undefined) {
      job.deadlineAt ??= job.startedAt + job.maximumRuntimeSeconds * 1000;
      if (job.deadlineAt <= Date.now()) {
        timeOutWorkspaceJob(job);
        return;
      }
    }
    transitionWorkspaceJob(job, "running", "Workspace container started");
    const execution = await runWorkspaceContainer({
      jobId: job.jobId,
      runtime: run.runtime,
      workspaceDirectory,
      entryPath,
      inputJSON: run.inputJSON,
      maximumRuntimeSeconds: remainingRuntimeSeconds(job),
    });
    if (job.state === "cancelled") return;
    let output;
    try {
      output = readWorkspaceOutputs(workspaceDirectory, temporaryEntry);
    } catch (error) {
      if (!execution.timedOut) throw error;
      output = { files: [], binaryFiles: [] };
    }
    const device = { deviceId: job.createdByDeviceId };
    const artifacts = persistWorkspaceArtifacts(output.binaryFiles, run, device, job.jobId);
    const completedAt = Date.now();
    job.exitCode = execution.exitCode;
    job.result = {
      schema: WORKSPACE_RESULT_SCHEMA,
      runId: run.runId,
      runtime: run.runtime,
      exitCode: execution.exitCode,
      standardOutput: execution.standardOutput,
      standardError: execution.standardError,
      files: output.files,
      artifacts,
      startedAt: job.startedAt,
      completedAt,
    };
    job.completedAt = completedAt;
    if (execution.timedOut) {
      job.failureCode = "workspace.execution_timed_out";
      job.failureMessage = job.maximumRuntimeSeconds === null
        ? "Workspace job reached its execution budget"
        : `Workspace job reached its ${job.maximumRuntimeSeconds} second execution budget`;
      transitionWorkspaceJob(job, "timed_out", job.failureMessage);
    } else if (execution.exitCode === 0) {
      transitionWorkspaceJob(job, "succeeded", "Workspace job completed");
    } else {
      job.failureCode = "workspace.process_failed";
      job.failureMessage = `Workspace process exited with code ${execution.exitCode}`;
      transitionWorkspaceJob(job, "failed", job.failureMessage);
    }
    log(`workspace job ${job.jobId} run=${run.runId} runtime=${run.runtime} exit=${execution.exitCode}`);
  } catch (error) {
    if (job.state !== "cancelled") {
      const code = error instanceof HttpError ? error.code : "workspace.execution_failed";
      const message = error instanceof HttpError ? error.message : "Workspace execution failed";
      failWorkspaceJob(job, code, message);
      log(`workspace job failed ${job.jobId} code=${code}`);
    }
  } finally {
    activeJobProcesses.delete(job.jobId);
    rmSync(workspaceDirectory, { recursive: true, force: true });
  }
}

function workspaceJob(jobId) {
  return state.jobs.find((job) => job.jobId === jobId) ?? null;
}

function publicWorkspaceJob(job, includeResult = false) {
  return {
    schema: WORKSPACE_JOB_SCHEMA,
    jobId: job.jobId,
    runId: job.runId,
    projectId: job.projectId,
    runtime: job.runtime,
    state: job.state,
    predecessorJobId: job.predecessorJobId,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    exitCode: job.exitCode,
    failureCode: job.failureCode,
    failureMessage: job.failureMessage,
    maximumRuntimeSeconds: job.maximumRuntimeSeconds ?? null,
    budgetSource: job.budgetSource ?? null,
    deadlineAt: job.deadlineAt ?? null,
    result: includeResult ? job.result : null,
  };
}

function workspaceJobInventory() {
  return {
    schema: WORKSPACE_JOB_INVENTORY_SCHEMA,
    jobs: state.jobs
      .slice()
      .sort((a, b) => b.queuedAt - a.queuedAt || a.jobId.localeCompare(b.jobId))
      .map((job) => publicWorkspaceJob(job, false)),
  };
}

function matchWorkspaceJobRoute(path) {
  const match = /^\/aru\/v1\/jobs\/([^/]+)(?:\/(events|cancel|retry))?$/.exec(path);
  if (!match) return null;
  return { jobId: decodeURIComponent(match[1]), action: match[2] ?? null };
}

function handleWorkspaceJobStatus(res, jobId) {
  const job = workspaceJob(jobId);
  if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
  sendJSON(res, 200, publicWorkspaceJob(job, true));
}

function handleWorkspaceJobEvents(res, jobId) {
  const job = workspaceJob(jobId);
  if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
  sendJSON(res, 200, {
    schema: WORKSPACE_JOB_EVENTS_SCHEMA,
    jobId: job.jobId,
    events: job.events,
  });
}

function handleWorkspaceJobCancel(res, jobId, device) {
  sendJSON(res, 200, cancelWorkspaceJob(jobId, device));
}

function cancelWorkspaceJob(jobId, device) {
  const job = workspaceJob(jobId);
  if (!job) throw new HttpError(404, "job.unknown", "unknown workspace job");
  if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.state)) {
    return publicWorkspaceJob(job, true);
  }
  job.cancelledByDeviceId = device.deviceId;
  job.completedAt = Date.now();
  transitionWorkspaceJob(job, "cancelled", "Workspace job cancelled explicitly");
  stopActiveJobProcess(job.jobId);
  log(`workspace job cancelled ${job.jobId} device=${device.deviceId}`);
  return publicWorkspaceJob(job, true);
}

function handleWorkspaceJobRetry(res, jobId, device) {
  const next = retryWorkspaceJob(jobId, device);
  sendJSON(res, 202, next);
}

function retryWorkspaceJob(jobId, device) {
  const previous = workspaceJob(jobId);
  if (!previous) throw new HttpError(404, "job.unknown", "unknown workspace job");
  if (!["failed", "cancelled", "timed_out"].includes(previous.state)) {
    throw new HttpError(409, "job.retry_not_allowed", "only failed, cancelled, or timed-out jobs can be retried");
  }
  const run = {
    ...previous.input,
    runId: `retry_${randomUUID()}`,
  };
  const next = createWorkspaceJob(run, device, previous.jobId);
  state.jobs.push(next);
  appendWorkspaceJobEvent(next, "queued", `Retry of ${previous.jobId}`);
  saveState();
  log(`workspace job retry ${previous.jobId} -> ${next.jobId}`);
  setImmediate(() => executeWorkspaceJob(next.jobId));
  return publicWorkspaceJob(next, true);
}

function transitionWorkspaceJob(job, nextState, message) {
  job.state = nextState;
  appendWorkspaceJobEvent(job, nextState, message);
  saveState();
}

function appendWorkspaceJobEvent(job, kind, message) {
  job.events.push({
    sequence: job.events.length + 1,
    kind,
    at: Date.now(),
    message,
  });
}

function failWorkspaceJob(job, code, message) {
  job.failureCode = code;
  job.failureMessage = message;
  job.completedAt = Date.now();
  transitionWorkspaceJob(job, "failed", message);
}

function timeOutWorkspaceJob(job) {
  job.failureCode = "workspace.execution_timed_out";
  job.failureMessage = job.maximumRuntimeSeconds === null
    ? "Workspace job reached its execution budget"
    : `Workspace job reached its ${job.maximumRuntimeSeconds} second execution budget`;
  job.completedAt = Date.now();
  transitionWorkspaceJob(job, "timed_out", job.failureMessage);
}

function remainingRuntimeSeconds(job) {
  if (job.maximumRuntimeSeconds === null || job.maximumRuntimeSeconds === undefined) return null;
  const deadlineAt = job.deadlineAt ?? (job.startedAt + job.maximumRuntimeSeconds * 1000);
  return Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
}

function validateWorkspaceRun(body) {
  if (body?.schema !== WORKSPACE_RUN_SCHEMA) {
    throw new HttpError(400, "workspace.schema_unsupported", "unsupported workspace run schema");
  }
  const runId = String(body.runId ?? "").trim();
  const projectId = String(body.projectId ?? "").trim();
  const runtime = String(body.runtime ?? "").trim();
  if (!runId || !projectId) {
    throw new HttpError(400, "workspace.identity_missing", "runId and projectId are required");
  }
  if (!WORKSPACE_RUNTIMES.includes(runtime)) {
    throw new HttpError(400, "workspace.runtime_unsupported", "unsupported runtime");
  }
  const files = Array.isArray(body.files) ? body.files : [];
  const paths = new Set();
  const normalizedFiles = files.map((file) => {
    const path = validateWorkspacePath(file?.path);
    if (paths.has(path)) {
      throw new HttpError(400, "workspace.path_duplicate", `duplicate workspace path: ${path}`);
    }
    paths.add(path);
    if (typeof file?.content !== "string") {
      throw new HttpError(400, "workspace.content_invalid", `workspace file must be text: ${path}`);
    }
    return {
      path,
      content: file.content,
      language: String(file.language ?? ""),
    };
  });
  const code = body.code === null || body.code === undefined ? null : String(body.code);
  const entryPath = body.entryPath === null || body.entryPath === undefined
    ? null
    : validateWorkspacePath(body.entryPath);
  if (code === null && entryPath === null) {
    throw new HttpError(400, "workspace.entry_missing", "entryPath or code is required");
  }
  let inputJSON = String(body.inputJSON ?? "{}");
  try {
    JSON.parse(inputJSON);
  } catch {
    throw new HttpError(400, "workspace.input_invalid", "inputJSON is not valid JSON");
  }
  return { runId, projectId, runtime, entryPath, code, inputJSON, files: normalizedFiles };
}

function validateWorkspacePath(value) {
  return normalizeWorkspacePath(value, false);
}

function validateRuntimeEntryPath(value) {
  const path = normalizeWorkspacePath(value, true);
  if (!/^\.aru-runtime-[A-Za-z0-9_-]{1,48}\.(mjs|py|sh)$/.test(path)) {
    throw new HttpError(400, "workspace.path_invalid", "runtime entry path is invalid");
  }
  return path;
}

function normalizeWorkspacePath(value, allowRuntimeEntry) {
  const path = String(value ?? "").replaceAll("\\", "/").trim();
  const segments = path.split("/");
  if (!path || isAbsolute(path) || path.includes("\0") ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      (!allowRuntimeEntry && path.startsWith(".aru-runtime-"))) {
    throw new HttpError(400, "workspace.path_invalid", "workspace paths must be safe relative paths");
  }
  return segments.join("/");
}

function resolveWorkspacePath(root, path, validator = validateWorkspacePath) {
  const target = resolve(root, validator(path));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new HttpError(400, "workspace.path_invalid", "workspace path escaped the run root");
  }
  return target;
}

function writeWorkspaceFile(root, path, content, validator = validateWorkspacePath) {
  const target = resolveWorkspacePath(root, path, validator);
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o777 });
  writeFileSync(target, content, { encoding: "utf8", mode: 0o666 });
  chmodSync(target, 0o666);
}

function makeWorkspaceTreeWritable(directory) {
  chmodSync(directory, 0o777);
  for (const name of readdirSync(directory)) {
    const absolute = join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      makeWorkspaceTreeWritable(absolute);
    } else if (stat.isFile()) {
      chmodSync(absolute, 0o666);
    }
  }
}

function temporaryEntryName(runtime, runId) {
  const safeID = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || randomBytes(8).toString("hex");
  const extension = runtime === "node" ? "mjs" : runtime === "python" ? "py" : "sh";
  return `.aru-runtime-${safeID}.${extension}`;
}

async function runWorkspaceContainer({
  jobId, runtime, workspaceDirectory, entryPath, inputJSON, maximumRuntimeSeconds,
}) {
  const image = config.runtimeImages[runtime];
  const containerName = workspaceJobContainerName(jobId);
  const command = runtime === "node"
    ? ["node", `/workspace/${entryPath}`]
    : runtime === "python"
      ? ["python3", `/workspace/${entryPath}`]
      : ["sh", `/workspace/${entryPath}`];
  const args = [
    "run", "--rm", "--init",
    "--name", containerName,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", config.containerMemory,
    "--cpus", config.containerCPUs,
    "--user", "65532:65532",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${workspaceDirectory},dst=/workspace,rw`,
    "--workdir", "/workspace",
    "--env", `ARU_WORKSPACE_INPUT=${inputJSON}`,
    image,
    ...command,
  ];
  return runProcess(config.containerRuntime, args, config.maxWorkspaceOutputBytes, {
    jobId,
    containerName,
    maximumRuntimeSeconds,
  });
}

function runProcess(command, args, maxOutputBytes, jobControl = null) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (jobControl !== null) {
      activeJobProcesses.set(jobControl.jobId, {
        child,
        containerRuntime: command,
        containerName: jobControl.containerName,
      });
    }
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    const timeout = jobControl?.maximumRuntimeSeconds === null ||
      jobControl?.maximumRuntimeSeconds === undefined
      ? null
      : scheduleExecutionDeadline(jobControl.maximumRuntimeSeconds, () => {
          timedOut = true;
          stopActiveJobProcess(jobControl.jobId);
        });
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        terminateChildProcess(child, "SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => {
      timeout?.cancel();
      if (jobControl !== null) activeJobProcesses.delete(jobControl.jobId);
      reject(new HttpError(503, "workspace.runtime_unavailable", "container runtime failed"));
    });
    child.on("close", (code) => {
      timeout?.cancel();
      if (jobControl !== null) activeJobProcesses.delete(jobControl.jobId);
      const standardError = Buffer.concat(stderr).toString("utf8");
      resolvePromise({
        exitCode: timedOut ? 124 : outputExceeded ? 137 : Number(code ?? 1),
        timedOut,
        standardOutput: Buffer.concat(stdout).toString("utf8"),
        standardError: outputExceeded
          ? `${standardError}\nAru stopped the run because process output exceeded the configured server safety boundary.`.trim()
          : standardError,
      });
    });
  });
}

function scheduleExecutionDeadline(maximumRuntimeSeconds, expire) {
  const deadlineAt = Date.now() + maximumRuntimeSeconds * 1000;
  let timer = null;
  let cancelled = false;
  const scheduleNext = () => {
    if (cancelled) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(scheduleNext, Math.min(remaining, 60_000));
  };
  scheduleNext();
  return {
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

function workspaceJobContainerName(jobId) {
  return `aru-${String(jobId).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 48)}`;
}

function stopActiveJobProcess(jobId) {
  const active = activeJobProcesses.get(jobId);
  if (!active) return;
  spawnSync(active.containerRuntime, [
    "stop", "--time", String(CONTAINER_STOP_GRACE_SECONDS), active.containerName,
  ], { stdio: "ignore" });
  terminateChildProcess(active.child, "SIGTERM");
  setTimeout(() => terminateChildProcess(active.child, "SIGKILL"),
             CONTAINER_STOP_GRACE_SECONDS * 1000);
}

function terminateChildProcess(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

function removeStaleJobContainer(jobId) {
  if (!config.containerRuntime) return;
  spawnSync(config.containerRuntime, ["rm", "-f", workspaceJobContainerName(jobId)], {
    stdio: "ignore",
  });
}

function readWorkspaceOutputs(root, excludedPath) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files = [];
  const binaryFiles = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new HttpError(422, "workspace.symlink_rejected", "workspace result cannot contain symbolic links");
      }
      if (stat.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) continue;
      const path = relative(root, absolute).split(sep).join("/");
      if (path === excludedPath) continue;
      const data = readFileSync(absolute);
      if (artifactExtension(path) !== null) {
        binaryFiles.push({ path, data });
        continue;
      }
      let content;
      try {
        content = decoder.decode(data);
      } catch {
        binaryFiles.push({ path, data });
        continue;
      }
      files.push({ path, content, language: languageForWorkspacePath(path) });
    }
  };
  walk(root);
  return { files, binaryFiles };
}

function recoverInterruptedJobs() {
  const interrupted = state.jobs.filter((job) =>
    ["queued", "preparing", "running"].includes(job.state));
  const recoveredJobIds = [];
  for (const job of interrupted) {
    job.events ??= [];
    removeStaleJobContainer(job.jobId);
    if (job.maximumRuntimeSeconds !== null && job.maximumRuntimeSeconds !== undefined &&
        job.startedAt !== null && job.startedAt !== undefined) {
      job.deadlineAt ??= job.startedAt + job.maximumRuntimeSeconds * 1000;
      if (job.deadlineAt <= Date.now()) {
        job.failureCode = "workspace.execution_timed_out";
        job.failureMessage = `Workspace job reached its ${job.maximumRuntimeSeconds} second execution budget`;
        job.completedAt = Date.now();
        job.state = "timed_out";
        appendWorkspaceJobEvent(job, "timed_out", job.failureMessage);
        continue;
      }
    }
    job.state = "queued";
    job.completedAt = null;
    job.exitCode = null;
    job.failureCode = null;
    job.failureMessage = null;
    job.result = null;
    appendWorkspaceJobEvent(job, "recovered", "Capability host resumed the durable workspace job");
    recoveredJobIds.push(job.jobId);
  }
  if (interrupted.length > 0) {
    saveState();
    log(`recovered ${recoveredJobIds.length} interrupted workspace job(s) for execution`);
  }
  return recoveredJobIds;
}


return { publicWorkspaceJobPolicy, handleWorkspaceJobPolicyUpdate, handleWorkspaceJobSubmit, executeWorkspaceJob, workspaceJob, publicWorkspaceJob, workspaceJobInventory, matchWorkspaceJobRoute, handleWorkspaceJobStatus, handleWorkspaceJobEvents, handleWorkspaceJobCancel, cancelWorkspaceJob, handleWorkspaceJobRetry, retryWorkspaceJob, recoverInterruptedJobs };
}
