import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCodeInvocation } from "../claude-code-driver.mjs";

test("Windows npm shim invokes JavaScript directly, preserving argument boundaries", () => {
  const args = ["--resume", "session&echo bad", "--mcp-config", "C:\\Work Space\\mcp.json"];
  const result = claudeCodeInvocation("C:\\User Space\\npm\\claude.cmd", args, "win32", "node.exe");
  assert.equal(result.command, "node.exe");
  assert.equal(result.args[0], "C:\\User Space\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js");
  assert.deepEqual(result.args.slice(1), args);
});
test("native Claude binaries keep their direct invocation", () => {
  assert.deepEqual(claudeCodeInvocation("claude.exe", ["--version"], "win32"),
    { command: "claude.exe", args: ["--version"] });
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { claudeDesktopExecutableCandidates, nodePackageExecutableCandidates } from "../collaborator-host.mjs";

test("Windows npm entry executes without interpreting shell metacharacters", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "aru claude npm "));
  try {
    const directory = join(root, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "cli.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const args = ["--resume", "session&echo BAD", "--mcp-config", join(root, "space name.json")];
    const invocation = claudeCodeInvocation(join(root, "claude.cmd"), args);
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
