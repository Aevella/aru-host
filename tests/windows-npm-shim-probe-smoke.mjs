#!/usr/bin/env node
// Real-Windows proof for the npm-installed Codex/Claude Code path: Node
// refuses to spawn the npm `.cmd` shim without a shell (EINVAL), and the Host
// driver probe must still reach the CLI through the shim's JavaScript entry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverLaunchSpec, probeDriver, resolveDriverExecutable } from "../collaborator-host.mjs";

if (process.platform !== "win32") {
  console.log("ARU_WINDOWS_NPM_SHIM_PROBE_SKIPPED (not Windows)");
  process.exit(0);
}

// A non-ASCII directory name mirrors a Chinese Windows user profile.
const root = mkdtempSync(join(tmpdir(), "aru-npm-shim-张三-"));
const npmDir = join(root, "npm");
const entryDir = join(npmDir, "node_modules", "@openai", "codex", "bin");
mkdirSync(entryDir, { recursive: true });
const entry = join(entryDir, "codex.js");
writeFileSync(entry, 'if (process.argv[2] === "--version") { console.log("codex-cli 0.0.0-shim-test"); process.exit(0); }\nprocess.exit(2);\n');
const shim = join(npmDir, "codex.cmd");
writeFileSync(shim, [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  "",
].join("\r\n"));

// The bug being fixed: a bare spawn of the shim is refused by Node itself.
const raw = spawnSync(shim, ["--version"], { encoding: "utf8", windowsHide: true });
assert.equal(raw.error?.code, "EINVAL", `expected Node to refuse the bare .cmd spawn, got ${raw.error?.code ?? raw.status}`);

const spec = driverLaunchSpec(shim);
assert.equal(spec.source, "npm-shim");
assert.equal(spec.file, process.execPath);
assert.deepEqual(spec.args, [entry]);

const definition = { id: "codex", executableCandidates: [join(root, "codex-missing.exe"), shim] };
const probe = probeDriver(definition, Date.now());
assert.equal(probe.status, "ready", JSON.stringify(probe));
assert.equal(probe.version, "codex-cli 0.0.0-shim-test");
assert.deepEqual(resolveDriverExecutable(definition), spec);
console.log("ARU_WINDOWS_NPM_SHIM_PROBE_OK");
