import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync, lstatSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../aru-selfhost-stub.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "aru-state-admission-"));
const data = join(root, "data");
const path = join(data, "state.json");
const args = [entry, "--data-dir", data, "--container-runtime", "none", "--port", "0"];
function check(extra = ["--check-state"]) {
  return spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8", timeout: 15_000 });
}
function rejected(extra) {
  const result = check(extra);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /host\.state_unreadable/);
  assert.equal(result.error, undefined, "startup must stop, not time out");
}
async function boot() {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(path) && output.includes("pairing")) return JSON.parse(readFileSync(path, "utf8"));
      if (child.exitCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Host failed to start: ${output}`);
  } finally {
    if (child.exitCode === null) {
      const ended = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await ended;
    }
  }
}
try {
  assert.equal(check().status, 0);
  assert.equal(existsSync(data), false, "read-only preflight must not create a data directory");
  mkdirSync(data);
  for (const contents of ["", "{broken", "null", "[]", "42", "{}",
    '{"serverId":"old","devices":{}}', '{"serverId":"old","jobs":[null]}']) {
    writeFileSync(path, contents);
    for (let attempt = 0; attempt < 2; attempt++) {
      rejected();
      rejected([]);
      assert.equal(readFileSync(path, "utf8"), contents);
    }
  }
  const launchd = check(["--launchd-supervised"]);
  assert.equal(launchd.status, 0);
  assert.match(launchd.stderr, /host\.state_unreadable/);
  rmSync(path);
  mkdirSync(path);
  rejected([]);
  assert.equal(lstatSync(path).isDirectory(), true);
  rmSync(path, { recursive: true });
  if (process.platform !== "win32") {
    symlinkSync(join(data, "missing-target"), path);
    rejected([]);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    rmSync(path);
  }
  const legacy = JSON.stringify({ serverId: "stable-existing-host", futureField: { keep: true }, devices: [] });
  writeFileSync(path, legacy);
  if (process.platform !== "win32" && process.getuid() !== 0) {
    chmodSync(path, 0);
    try { rejected([]); } finally { chmodSync(path, 0o600); }
    assert.equal(readFileSync(path, "utf8"), legacy);
  }
  assert.equal(check().status, 0);
  assert.equal(readFileSync(path, "utf8"), legacy, "preflight cannot normalize or rotate pairing");
  const restored = await boot();
  assert.equal(JSON.parse(readFileSync(`${path}.bak`, "utf8")).serverId, "stable-existing-host");
  const backup = readFileSync(`${path}.bak`);
  writeFileSync(path, "{broken-after-backup");
  rejected([]);
  assert.deepEqual(readFileSync(`${path}.bak`), backup);
  // Explicit restoration retains the old host identity and permits retry.
  writeFileSync(path, backup);
  assert.equal(restored.serverId, "stable-existing-host");
  assert.deepEqual(restored.futureField, { keep: true });
  const restarted = await boot();
  assert.equal(restarted.serverId, restored.serverId);
  rmSync(data, { recursive: true });
  const fresh = await boot();
  assert.equal(typeof fresh.serverId, "string");
  assert.ok(fresh.serverId.length > 0);
  console.log("ARU_STATE_STARTUP_SMOKE_OK");
} finally { rmSync(root, { recursive: true, force: true }); }
