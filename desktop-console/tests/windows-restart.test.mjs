import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createWindowsPlatform } from "../src/platform/windows.mjs";

function platform(execFile) {
  return createWindowsPlatform({
    serviceName: "test-console", credentialAccount: "home",
    homeDir: "C:\\Users\\test", env: { ARU_WINDOWS_BASE_ROOT: "C:\\Custom Host" }, execFile,
  });
}

test("restart uses the installed instance control tool and waits for completion", async () => {
  const calls = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const host = platform(async (...args) => { calls.push(args); return pending; });
  let completed = false;
  const restart = host.restartService().then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(calls.length, 1);
  const [executable, args] = calls[0];
  assert.equal(executable, "powershell.exe");
  assert.ok(args[args.indexOf("-File") + 1].endsWith("aru-selfhostctl-windows.ps1"));
  assert.equal(args.includes("-Command"), false);
  assert.deepEqual(args.slice(args.indexOf("-Instance")), ["-Instance", "home", "restart", "-BaseRoot", "C:\\Custom Host"]);
  finish({ stdout: "", stderr: "" });
  await restart;
  assert.equal(completed, true);
});

test("a failed stop propagates without an independent start fallback", async () => {
  const failure = new Error("Host task did not stop; no replacement was started");
  let calls = 0;
  const host = platform(async () => { calls++; throw failure; });
  await assert.rejects(host.restartService(), error => error === failure);
  assert.equal(calls, 1);
});

test("setup and manual restart share stop-before-start ordering", async () => {
  const source = (await readFile(new URL("../../aru-selfhostctl-windows.ps1", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const restart = source.match(/function RestartCommand \{([\s\S]*?)\n\}/)[1];
  assert.match(restart, /RequireInstalled\s+StopHostTask\s+Start-ScheduledTask/);
  const setup = source.match(/function SetupRuntimeCommand \{([\s\S]*?)\n\}/)[1];
  assert.match(setup, /if \(\$LASTEXITCODE -ne 0\).*\n  RestartCommand/);
  assert.doesNotMatch(setup, /Start-ScheduledTask/);
});
