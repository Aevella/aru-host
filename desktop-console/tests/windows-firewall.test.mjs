import test from "node:test";
import assert from "node:assert/strict";
import { createWindowsPlatform, FIREWALL_FAILURE_PREFIX } from "../src/platform/windows.mjs";

const nodeEnv = [
  "ARU_NODE_BINARY=C:\\Users\\test\\AppData\\Local\\AruHost\\node\\node.exe",
  "ARU_LISTEN_HOST=0.0.0.0",
  "ARU_PORT=8791",
].join("\r\n");

function platformWith(execFile) {
  return createWindowsPlatform({
    homeDir: "C:\\Users\\test",
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    serviceName: "cn.aelion.aru.host-console.v2",
    credentialAccount: "home",
    execFile,
    fileExists: () => true,
    readTextFile: async () => nodeEnv,
  });
}

function scriptOf(call) {
  return call[1][call[1].indexOf("-Command") + 1];
}

test("firewall fix verifies the rule inside the elevated shell and reads it back", async () => {
  const calls = [];
  const platform = platformWith(async (command, args) => {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  });

  await platform.configureFirewall();

  const elevated = scriptOf(calls[0]);
  assert.match(elevated, /Start-Process -Verb RunAs -Wait -PassThru/);
  assert.match(elevated, /exit \$p\.ExitCode$/, "the outer shell surfaces the elevated exit code");
  assert.match(elevated, /-LocalPort 8791 -Profile Private,Domain/);
  assert.match(elevated, /-Program ''C:\\Users\\test\\AppData\\Local\\AruHost\\node\\node\.exe''/);
  assert.match(elevated, /Get-NetFirewallRule -DisplayName ''Aru Host \(home\)''[^}]*\{exit 0\}else\{exit 4\}/,
    "the elevated shell checks the rule it just created");
  assert.match(elevated, /-ErrorAction Stop/, "creation failures terminate before verification");
  assert.match(elevated, /catch \{ exit 5 \}/);

  const readBack = scriptOf(calls[1]);
  assert.match(readBack, /Get-NetFirewallRule -DisplayName 'Aru Host \(home\)'/, "success is read back unelevated");
});

test("firewall fix reports a missing rule instead of claiming completion", async () => {
  const failing = platformWith(async (command, args) => {
    if (/Start-Process/.test(scriptOf([command, args]))) {
      const error = new Error("elevated shell exited 4");
      error.code = 4;
      throw error;
    }
    return { stdout: "", stderr: "" };
  });
  await assert.rejects(failing.configureFirewall(), (error) =>
    error.message.startsWith(`${FIREWALL_FAILURE_PREFIX}8791:4`));

  let elevatedCalls = 0;
  const vanished = platformWith(async (command, args) => {
    const script = scriptOf([command, args]);
    if (/Start-Process/.test(script)) {
      elevatedCalls += 1;
      return { stdout: "", stderr: "" };
    }
    const error = new Error("no rule");
    error.code = 3;
    throw error;
  });
  await assert.rejects(vanished.configureFirewall(), (error) =>
    error.message.startsWith(`${FIREWALL_FAILURE_PREFIX}8791:4`));
  assert.equal(elevatedCalls, 1);
});
