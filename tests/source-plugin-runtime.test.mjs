import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSourcePluginRuntime } from "../source-plugin-runtime.mjs";

class TestHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const noNetwork = { network: "none", persistentVolume: false };
const outboundNetwork = { network: "outbound", persistentVolume: false };
const repositoryContainerFixture = fileURLToPath(new URL("./fake-container-runtime.sh", import.meta.url));

test("Node permission mode without network enforcement does not advertise a source runtime", async (t) => {
  const fixture = await createFixture(t, { nodeMode: "legacy" });
  const runtime = fixture.runtime({ containerRuntime: null });

  assert.equal(runtime.available, false);
  await assert.rejects(
    runtime.validateDraft({ sourceCode: "export const tools = [];", permissions: noNetwork, resources: {} }),
    (error) => error.code === "plugin.source_runtime_unavailable"
      && /Node\.js 25\+/.test(error.message),
  );
});

test("Node 22/24-style permission mode uses the container for denied and outbound network", async (t) => {
  const fixture = await createFixture(t, { nodeMode: "legacy" });
  const runtime = fixture.runtime({ containerRuntime: fixture.container });

  assert.equal(runtime.available, true);
  await fixture.validate(runtime, noNetwork);
  await fixture.validate(runtime, outboundNetwork);

  assert.deepEqual(await fixture.hostRuns(), []);
  const runs = await fixture.containerRuns();
  assert.equal(runs.length, 2);
  assert.match(runs[0], /--network none/);
  assert.doesNotMatch(runs[1], /--network none/);
});

test("network-capable Node permission mode runs on the host with the exact grant", async (t) => {
  const fixture = await createFixture(t, { nodeMode: "network-aware" });
  const runtime = fixture.runtime({ containerRuntime: fixture.container });

  await fixture.validate(runtime, noNetwork);
  await fixture.validate(runtime, outboundNetwork);

  assert.deepEqual(await fixture.containerRuns(), []);
  const runs = await fixture.hostRuns();
  assert.equal(runs.length, 2);
  assert.doesNotMatch(runs[0], /--allow-net/);
  assert.match(runs[1], /--allow-net/);
});

test("a failing container never falls back to the less capable host runtime", async (t) => {
  const fixture = await createFixture(t, { nodeMode: "legacy", containerFails: true });
  const runtime = fixture.runtime({ containerRuntime: fixture.container });

  await assert.rejects(
    fixture.validate(runtime, outboundNetwork),
    (error) => error.code === "plugin.execution_failed"
      && /newuidmap write to uid_map failed: Invalid argument/.test(error.message),
  );
  assert.deepEqual(await fixture.hostRuns(), []);
});

test("the container smoke runtime executes source plugins for legacy Node hosts", async (t) => {
  const fixture = await createFixture(t, { nodeMode: "legacy", realRunner: true });
  const runtime = fixture.runtime({ containerRuntime: repositoryContainerFixture });

  const result = await runtime.validateDraft({
    sourceCode: "export const tools = [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object' } }];",
    permissions: noNetwork,
    resources: {},
  });
  assert.equal(result.tools[0].name, "ping");
  assert.deepEqual(await fixture.hostRuns(), []);
});

async function createFixture(t, { nodeMode, containerFails = false, realRunner = false }) {
  const root = await mkdtemp(join(tmpdir(), "aru-source-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const runnerPath = join(root, "source-plugin-runner.mjs");
  const nodeBinary = join(root, "fake-node");
  const container = join(root, "fake-container");
  const hostRecord = join(root, "host-runs.txt");
  const containerRecord = join(root, "container-runs.txt");
  await writeFile(runnerPath, realRunner
    ? await readFile(fileURLToPath(new URL("../source-plugin-runner.mjs", import.meta.url)), "utf8")
    : "// fixture runner\n");
  await writeExecutable(nodeBinary, fakeNodeScript({ nodeMode, hostRecord }));
  await writeExecutable(container, fakeContainerScript({ containerRecord, containerFails }));

  return {
    container,
    runtime: ({ containerRuntime }) => createSourcePluginRuntime({
      dataDir,
      runnerPath,
      nodeBinary,
      containerRuntime,
      nodeImage: "node:22-bookworm-slim",
      maximumSourceBytes: 64 * 1024,
      maximumOutputBytes: 64 * 1024,
      callTimeoutSeconds: 5,
      HttpError: TestHttpError,
    }),
    validate(runtime, permissions) {
      return runtime.validateDraft({
        sourceCode: "export const tools = [];",
        permissions,
        resources: {},
      });
    },
    hostRuns: () => readLines(hostRecord),
    containerRuns: () => readLines(containerRecord),
  };
}

async function writeExecutable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

function fakeNodeScript({ nodeMode, hostRecord }) {
  return `#!/usr/bin/env bash
set -eu
args="$*"
if [[ "$args" == *"--eval"* ]]; then
  if [[ "$args" == *"readFileSync"* ]]; then
    if [[ "$args" == *"--allow-fs-read="* ]]; then exit 0; fi
    echo "Error [ERR_ACCESS_DENIED]: filesystem denied" >&2
    exit 1
  fi
  if [[ "$args" != *"createServer"* ]]; then exit 0; fi
  if [[ "${nodeMode}" == "legacy" ]]; then
    if [[ "$args" == *"--allow-net"* ]]; then
      echo "bad option: --allow-net" >&2
      exit 9
    fi
    exit 0
  fi
  if [[ "$args" != *"--allow-net"* ]]; then
    echo "Error [ERR_ACCESS_DENIED]: network denied" >&2
    exit 1
  fi
  exit 0
fi
printf '%s\\n' "$args" >> ${shellQuote(hostRecord)}
read -r _request || true
echo 'ARU_SOURCE_PLUGIN_RESULT_JSON={"ok":true,"tools":[]}'
`;
}

function fakeContainerScript({ containerRecord, containerFails }) {
  return `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> ${shellQuote(containerRecord)}
read -r _request || true
${containerFails ? "echo 'newuidmap write to uid_map failed: Invalid argument' >&2\nexit 44" : "echo 'ARU_SOURCE_PLUGIN_RESULT_JSON={\"ok\":true,\"tools\":[]}'"}
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function readLines(path) {
  try {
    const value = await readFile(path, "utf8");
    return value.trim() ? value.trim().split("\n") : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
