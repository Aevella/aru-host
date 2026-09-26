import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCodeLaunch } from "../claude-code-driver.mjs";

const NPM_SHIM = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)';

test("Windows npm shim launches JavaScript directly, preserving argument boundaries", () => {
  const args = ["--resume", "session&echo bad", "--mcp-config", "C:\\Work Space\\mcp.json"];
  const shim = "C:\\User Space\\npm\\claude.cmd";
  const entry = "C:\\User Space\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  const spec = driverLaunchSpec(shim, {
    platform: "win32",
    nodePath: "node.exe",
    exists: (candidate) => candidate === shim || candidate === entry,
    readShim: () => NPM_SHIM,
  });
  const result = claudeCodeLaunch(spec, args);
  assert.equal(result.command, "node.exe");
  assert.equal(result.args[0], entry);
  assert.deepEqual(result.args.slice(1), args);
});

test("native Claude binaries keep their direct invocation", () => {
  assert.deepEqual(claudeCodeLaunch("claude.exe", ["--version"]),
    { command: "claude.exe", args: ["--version"] });
  assert.deepEqual(claudeCodeLaunch(driverLaunchSpec("/usr/local/bin/claude", { platform: "darwin" }), ["-p"]),
    { command: "/usr/local/bin/claude", args: ["-p"] });
});

test("an unmapped shim is refused instead of passing Claude arguments through cmd.exe", () => {
  const shim = "C:\\Tools\\claude.cmd";
  const spec = driverLaunchSpec(shim, {
    platform: "win32",
    exists: (candidate) => candidate === shim,
    readShim: () => "@echo off\r\ncustom-launcher %*",
  });
  assert.equal(spec.shell, true);
  assert.throws(() => claudeCodeLaunch(spec, ["--resume", "x"]), /without a shell/);
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  claudeDesktopExecutableCandidates,
  driverLaunchSpec,
  nodePackageExecutableCandidates,
} from "../collaborator-host.mjs";

test("Windows npm entry executes without interpreting shell metacharacters", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "aru claude npm "));
  try {
    const directory = join(root, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "cli.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    writeFileSync(join(root, "claude.cmd"), NPM_SHIM);
    const args = ["--resume", "session&echo BAD", "--mcp-config", join(root, "space name.json")];
    const invocation = claudeCodeLaunch(driverLaunchSpec(join(root, "claude.cmd")), args);
    const child = spawnSync(invocation.command, invocation.args, { encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), args);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Desktop and package-manager CLI paths are discoverable without shell PATH", () => {
  const versions = ["2.1.9", "2.1.266"].map(name => ({ name, isDirectory: () => true }));
  const desktop = claudeDesktopExecutableCandidates("/test-home", () => versions);
  assert.match(desktop[0], /2\.1\.266/);
  const npm = nodePackageExecutableCandidates("claude", {
    homeDirectory: "/test-home", env: { NPM_CONFIG_PREFIX: "/test-npm" }, readDirectory: () => []
  });
  assert.ok(npm.includes("/test-npm/bin/claude"));
  assert.ok(npm.includes("/test-home/.volta/bin/claude"));
});
