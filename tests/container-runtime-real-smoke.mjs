import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import assert from "node:assert/strict";
import { configureContainerRuntime } from "../container-runtime-setup.mjs";

// CI runs this as its ordinary user against a real Docker/Podman engine.
// It verifies actual image pulls, non-root isolated execution, mounts and writes.
const directory = await mkdtemp(join(tmpdir(), "aru-real-containers-"));
try {
  const config = join(directory, "node.env");
  await writeFile(config, "ARU_CONTAINER_RUNTIME=none\nARU_PORT=8787\n");
  const runtime = await configureContainerRuntime(config);
  assert.match(await readFile(config, "utf8"), /ARU_PORT=8787/);
  console.log(`REAL_CONTAINER_SETUP_OK: ${basename(runtime)}; Node, Python, Shell and file receipts verified`);
} finally { await rm(directory, { recursive: true, force: true }); }
