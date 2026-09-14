import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverLaunchSpec, probeDriver, resolveDriverExecutable } from "../collaborator-host.mjs";

const NPM_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
`;

const shimPath = String.raw`C:\Users\张三\AppData\Roaming\npm\codex.cmd`;
const entryPath = String.raw`C:\Users\张三\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;

test("an npm .cmd shim on Windows launches its JavaScript entry with this Node", () => {
  const spec = driverLaunchSpec(shimPath, {
    platform: "win32",
    nodePath: String.raw`C:\Program Files\nodejs\node.exe`,
    exists: (candidate) => candidate === shimPath || candidate === entryPath,
    readShim: () => NPM_SHIM,
  });
  assert.deepEqual(spec, {
    file: String.raw`C:\Program Files\nodejs\node.exe`,
    args: [entryPath],
    shell: false,
    source: "npm-shim",
  });
});

test("a .cmd that is not an npm shim falls back to a quoted shell launch", () => {
  const spec = driverLaunchSpec(shimPath, {
    platform: "win32",
    exists: (candidate) => candidate === shimPath,
    readShim: () => "@ECHO off\r\ncodex-native.exe %*\r\n",
  });
  assert.deepEqual(spec, { file: `"${shimPath}"`, args: [], shell: true, source: "shell" });
});

test("a shim whose entry is missing does not point at a non-existent file", () => {
  const spec = driverLaunchSpec(shimPath, {
    platform: "win32",
    exists: (candidate) => candidate === shimPath,
    readShim: () => NPM_SHIM,
  });
  assert.equal(spec.source, "shell");
});

test("native executables and non-Windows platforms are launched directly", () => {
  const exe = String.raw`C:\Users\张三\AppData\Local\Programs\codex\codex.exe`;
  assert.deepEqual(driverLaunchSpec(exe, { platform: "win32", exists: () => true }), {
    file: exe, args: [], shell: false, source: "direct",
  });
  assert.deepEqual(driverLaunchSpec("/usr/local/bin/codex", { platform: "darwin" }), {
    file: "/usr/local/bin/codex", args: [], shell: false, source: "direct",
  });
  assert.equal(driverLaunchSpec("codex.cmd", { platform: "win32", exists: () => false }).source, "direct");
});

test("a failing candidate no longer hides a working candidate behind it", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "aru-driver-probe-"));
  const failing = join(root, "codex-broken");
  const working = join(root, "codex-good");
  writeFileSync(failing, "#!/bin/sh\necho 'spawn helper crashed' >&2\nexit 3\n");
  writeFileSync(working, "#!/bin/sh\necho 'codex-cli 9.9.9'\n");
  chmodSync(failing, 0o755);
  chmodSync(working, 0o755);
  const definition = {
    id: "codex",
    executableCandidates: [join(root, "codex-missing"), failing, working],
  };
  const probe = probeDriver(definition, 1);
  assert.equal(probe.status, "ready");
  assert.equal(probe.version, "codex-cli 9.9.9");
  assert.equal(probe.failure, null);
  assert.deepEqual(resolveDriverExecutable(definition), {
    file: working, args: [], shell: false, source: "direct",
  });

  const broken = probeDriver({ id: "codex", executableCandidates: [join(root, "codex-missing"), failing] }, 1);
  assert.equal(broken.status, "unhealthy");
  assert.equal(broken.failure, "version-probe-failed");
  assert.match(broken.failureDetail, /codex-broken: exit 3: spawn helper crashed/);
  assert.equal(resolveDriverExecutable({ id: "codex", executableCandidates: [failing] }), null);

  const missing = probeDriver({ id: "codex", executableCandidates: [join(root, "codex-missing")] }, 1);
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.failure, "command-not-found");
});
