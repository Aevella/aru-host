import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const RESULT_PREFIX = "ARU_SOURCE_PLUGIN_RESULT_JSON=";

export function createSourcePluginRuntime({
  dataDir,
  runnerPath,
  nodeBinary,
  containerRuntime,
  nodeImage,
  maximumSourceBytes,
  maximumOutputBytes,
  callTimeoutSeconds,
  HttpError,
}) {
  const packageRoot = join(dataDir, "plugin-packages");
  const dataRoot = join(dataDir, "plugin-data");
  const draftRoot = join(dataDir, "plugin-drafts");
  for (const path of [packageRoot, dataRoot, draftRoot]) mkdirSync(path, { recursive: true, mode: 0o700 });

  const hostPermissionRuntime = nodeSupportsPermissions(nodeBinary);
  const available = hostPermissionRuntime || Boolean(containerRuntime);

  function guide() {
    return {
      schema: "aru.selfhost.plugin-workshop-guide.v1",
      language: "javascript-esm",
      exports: ["tools", "callTool(name, arguments, context)"],
      lifecycle: [
        "validate",
        "apply-and-enable or save an optional draft",
        "refresh MCP catalog or begin the next model turn",
        "call",
      ],
      materializedToolName: "plugin__<plugin id with dots replaced by underscores>__<tool name>",
      security: {
        fileAccess: "none except the plugin's isolated data directory when persistentVolume is granted",
        childProcesses: "denied",
        devices: "denied",
        network: "denied unless outbound is granted",
        activation: "publishing never enables a plugin",
        secrets: "never embed credentials in source; scoped secret handles are not implemented",
      },
      requestDefaults: {
        authority: "zero",
        capabilities: ["persistent-storage", "network-outbound"],
        note: "omit capabilities for zero authority; use named capabilities only when the plugin truly needs them; secrets, host paths, devices, and custom resource budgets are unavailable",
      },
      example: [
        "import { appendFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        "export const tools = [{",
        "  name: 'remember_note',",
        "  title: 'Remember note',",
        "  description: 'Store one note in this plugin data directory.',",
        "  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },",
        "}];",
        "export async function callTool(name, args, context) {",
        "  if (name !== 'remember_note') throw new Error('unknown tool');",
        "  if (!context.dataDirectory) throw new Error('persistentVolume permission is required');",
        "  await appendFile(join(context.dataDirectory, 'notes.jsonl'), JSON.stringify({ text: args.text }) + '\\n');",
        "  return { accepted: true, textLength: args.text.length };",
        "}",
      ].join("\n"),
    };
  }

  async function validateDraft({ sourceCode, permissions, resources }) {
    requireAvailable();
    validateSourceCode(sourceCode);
    const draft = mkdtempSync(join(draftRoot, "draft-"));
    const entry = join(draft, "plugin.mjs");
    try {
      writeFileSync(entry, sourceCode, { mode: 0o600 });
      const result = await invoke(entry, permissions, resources, { action: "catalog" }, null);
      return { digest: digestSource(sourceCode), tools: result.tools };
    } finally {
      rmSync(draft, { recursive: true, force: true });
    }
  }

  function store(sourceCode, expectedDigest = digestSource(sourceCode)) {
    validateSourceCode(sourceCode);
    const actualDigest = digestSource(sourceCode);
    if (actualDigest !== expectedDigest) {
      throw new HttpError(409, "plugin.source_changed", "Plugin source changed after validation");
    }
    const directory = packageDirectory(actualDigest);
    if (!existsSync(directory)) {
      const staging = `${directory}.${randomUUID()}.tmp`;
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, "plugin.mjs"), sourceCode, { mode: 0o600 });
      renameSync(staging, directory);
    }
    return actualDigest;
  }

  async function probe(plugin) {
    const result = await invokePlugin(plugin, { action: "catalog" });
    return result.tools;
  }

  async function call(plugin, toolName, args) {
    const result = await invokePlugin(plugin, {
      action: "call",
      toolName,
      arguments: args,
    });
    return result.value;
  }

  function packagePresent(digest) {
    return existsSync(join(packageDirectory(digest), "plugin.mjs"));
  }

  function readPackage(digest) {
    const entry = join(packageDirectory(digest), "plugin.mjs");
    if (!existsSync(entry)) {
      throw new HttpError(404, "plugin.package_missing", "Plugin source package is missing");
    }
    return readFileSync(entry, "utf8");
  }

  function removePackage(digest) {
    rmSync(packageDirectory(digest), { recursive: true, force: true });
  }

  function removeData(pluginId) {
    rmSync(pluginDataDirectory(pluginId), { recursive: true, force: true });
  }

  function dataPresent(pluginId) {
    return existsSync(pluginDataDirectory(pluginId));
  }

  async function invokePlugin(plugin, request) {
    const entry = join(packageDirectory(plugin.manifest.image), "plugin.mjs");
    if (!existsSync(entry)) throw new HttpError(503, "plugin.package_missing", "Plugin source package is missing");
    const dataDirectory = plugin.manifest.permissions.persistentVolume
      ? ensurePluginDataDirectory(plugin.pluginId)
      : null;
    return invoke(entry, plugin.manifest.permissions, plugin.manifest.resources, request, dataDirectory);
  }

  async function invoke(entry, permissions, resources, request, dataDirectory) {
    const child = hostPermissionRuntime
      ? spawnHost(entry, permissions, resources, dataDirectory)
      : spawnContainer(entry, permissions, resources, dataDirectory);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exceeded = false;
    const terminate = () => {
      child.kill("SIGKILL");
      if (child.aruContainerName) {
        spawnSync(containerRuntime, ["rm", "-f", child.aruContainerName], { stdio: "ignore" });
      }
    };
    const append = (current, chunk) => {
      if (current.length + chunk.length > maximumOutputBytes) {
        exceeded = true;
        terminate();
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.stdin.end(JSON.stringify({
      ...request,
      dataDirectory: dataDirectory
        ? (hostPermissionRuntime ? realpathSync(dataDirectory) : "/data")
        : null,
    }));

    let timer = null;
    let timedOut = false;
    if (callTimeoutSeconds > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, callTimeoutSeconds * 1000);
      timer.unref();
    }
    const status = await new Promise((resolveStatus, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveStatus({ code, signal }));
    }).finally(() => { if (timer) clearTimeout(timer); });

    if (exceeded) throw new HttpError(413, "plugin.output_too_large", "Plugin output exceeded the node budget");
    if (timedOut) throw new HttpError(408, "plugin.execution_timed_out", "Plugin call exceeded the node time budget");
    const line = stdout.toString("utf8").split(/\r?\n/)
      .reverse().find((candidate) => candidate.startsWith(RESULT_PREFIX));
    if (!line) {
      const detail = stderr.toString("utf8").trim().slice(0, 500);
      throw new HttpError(503, "plugin.execution_failed",
        detail || `Plugin runner exited with ${status.signal ?? status.code}`);
    }
    let result;
    try {
      result = JSON.parse(line.slice(RESULT_PREFIX.length));
    } catch {
      throw new HttpError(503, "plugin.result_invalid", "Plugin returned an invalid result envelope");
    }
    if (!result.ok) throw new HttpError(422, "plugin.code_error", String(result.error ?? "Plugin failed"));
    return result;
  }

  function spawnHost(entry, permissions, resources, dataDirectory) {
    const args = [];
    if (resources?.memoryMiB) args.push(`--max-old-space-size=${resources.memoryMiB}`);
    args.push("--permission", `--allow-fs-read=${realpathSync(dirname(runnerPath))}`,
      `--allow-fs-read=${realpathSync(dirname(entry))}`);
    if (dataDirectory) {
      args.push(`--allow-fs-read=${realpathSync(dataDirectory)}`,
        `--allow-fs-write=${realpathSync(dataDirectory)}`);
    }
    if (permissions.network === "outbound") args.push("--allow-net");
    args.push(realpathSync(runnerPath), realpathSync(entry));
    return spawn(nodeBinary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: realpathSync(dirname(entry)),
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
    });
  }

  function spawnContainer(entry, permissions, resources, dataDirectory) {
    const containerName = `aru-source-plugin-${randomUUID()}`;
    const args = [
      "run", "--rm", "-i", "--name", containerName, "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--user", "0:0",
    ];
    if (permissions.network === "none") args.push("--network", "none");
    if (resources?.memoryMiB) args.push("--memory", `${resources.memoryMiB}m`);
    if (resources?.cpuMillis) args.push("--cpus", String(resources.cpuMillis / 1000));
    if (resources?.pids) args.push("--pids-limit", String(resources.pids));
    args.push("--mount", `type=bind,src=${resolve(runnerPath)},dst=/aru/runner.mjs,ro`);
    args.push("--mount", `type=bind,src=${resolve(entry)},dst=/aru/plugin.mjs,ro`);
    if (dataDirectory) args.push("--mount", `type=bind,src=${resolve(dataDirectory)},dst=/data,rw`);
    args.push(nodeImage, "node", "/aru/runner.mjs", "/aru/plugin.mjs");
    const child = spawn(containerRuntime, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.aruContainerName = containerName;
    return child;
  }

  function ensurePluginDataDirectory(pluginId) {
    const directory = pluginDataDirectory(pluginId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    return directory;
  }

  function pluginDataDirectory(pluginId) {
    return join(dataRoot, pluginId);
  }

  function packageDirectory(digest) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new HttpError(400, "plugin.source_digest_invalid", "Plugin source digest is invalid");
    }
    return join(packageRoot, digest.slice("sha256:".length));
  }

  function validateSourceCode(sourceCode) {
    if (typeof sourceCode !== "string" || sourceCode.trim() === "") {
      throw new HttpError(400, "plugin.source_required", "Plugin sourceCode is required");
    }
    if (Buffer.byteLength(sourceCode) > maximumSourceBytes) {
      throw new HttpError(413, "plugin.source_too_large", "Plugin source exceeds the node budget");
    }
  }

  function requireAvailable() {
    if (!available) {
      throw new HttpError(503, "plugin.source_runtime_unavailable",
        "Source plugins require Node.js 22+ permission mode or a container runtime");
    }
  }

  return {
    available,
    guide,
    validateDraft,
    store,
    probe,
    call,
    packagePresent,
    readPackage,
    removePackage,
    removeData,
    dataPresent,
  };
}

function digestSource(sourceCode) {
  return `sha256:${createHash("sha256").update(sourceCode).digest("hex")}`;
}

function nodeSupportsPermissions(nodeBinary) {
  const result = spawnSync(nodeBinary, ["--permission", "--eval", ""], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0;
}
