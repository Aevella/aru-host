import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureContainerRuntime, replaceRuntime } from "../container-runtime-setup.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "aru-setup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "node.env");
  const original = "ARU_CONTAINER_RUNTIME=none\nARU_PORT=8787\nARU_PYTHON_IMAGE=python:custom\n";
  await writeFile(config, original);
  return { config, original };
}

async function successfulRun(command, args) {
  if (args[0] === "info") return;
  assert.ok(args.includes("none"));
  assert.ok(args.includes("65532:65532"));
  const mount = args[args.indexOf("--mount") + 1];
  const directory = mount.slice("type=bind,src=".length, mount.indexOf(",dst="));
  const language = args.includes("node") ? "node" : args.includes("python3") ? "python" : "shell";
  assert.equal(await readFile(join(directory, "input.txt"), "utf8"), "aru-runtime-check");
  await writeFile(join(directory, `${language}.txt`), "ok");
}

test("missing or stopped engines leave configuration unchanged", async t => {
  const { config, original } = await fixture(t);
  await assert.rejects(configureContainerRuntime(config, {
    candidates: ["missing", "stopped"], run: async () => { throw new Error("not ready"); },
  }), /No running container engine/);
  assert.equal(await readFile(config, "utf8"), original);
});

test("all three sandbox jobs and file receipts precede activation; unrelated settings survive", async t => {
  const { config } = await fixture(t);
  const calls = [];
  const result = await configureContainerRuntime(config, {
    platform: "darwin", candidates: ["/runtime with spaces/podman"],
    run: async (...args) => { calls.push(args); return successfulRun(...args); },
  });
  assert.equal(result, "/runtime with spaces/podman");
  assert.equal(calls.length, 4);
  assert.ok(calls[2][1].includes("python:custom"));
  assert.equal(await readFile(config, "utf8"), "ARU_CONTAINER_RUNTIME='/runtime with spaces/podman'\nARU_PORT=8787\nARU_PYTHON_IMAGE=python:custom\n");
});

test("engine info succeeds but job failure does not activate runtime", async t => {
  const { config, original } = await fixture(t);
  await assert.rejects(configureContainerRuntime(config, {
    candidates: ["podman"], run: async (_, args) => { if (args[0] === "run") throw new Error("mount denied"); },
  }), /mount denied/);
  assert.equal(await readFile(config, "utf8"), original);
  // Repair and retry uses the same canonical config, without a pending-state latch.
  await configureContainerRuntime(config, { candidates: ["podman"], run: successfulRun });
  assert.match(await readFile(config, "utf8"), /ARU_CONTAINER_RUNTIME='podman'/);
});

test("zero exit without output receipts cannot claim success", async t => {
  const { config, original } = await fixture(t);
  await assert.rejects(configureContainerRuntime(config, { candidates: ["podman"], run: async () => {} }));
  assert.equal(await readFile(config, "utf8"), original);
});

test("settings edited during preparation are preserved", async t => {
  const { config } = await fixture(t);
  await assert.rejects(configureContainerRuntime(config, {
    candidates: ["podman"], run: async (...args) => {
      await successfulRun(...args);
      if (args[1][0] === "run") await writeFile(config, "ARU_CONTAINER_RUNTIME=none\nARU_PORT=9999\n");
    },
  }), /settings changed/);
  assert.match(await readFile(config, "utf8"), /ARU_PORT=9999/);
});

test("Windows literal paths and Unix shell quoting preserve executable identity", () => {
  assert.equal(replaceRuntime("ARU_CONTAINER_RUNTIME=none\r\n", "C:\\Program Files\\Podman\\podman.exe", "win32"),
    "ARU_CONTAINER_RUNTIME=C:\\Program Files\\Podman\\podman.exe\r\n");
  assert.equal(replaceRuntime("", "/user's/podman", "darwin"), "\nARU_CONTAINER_RUNTIME='/user'\\''s/podman'\n");
});
