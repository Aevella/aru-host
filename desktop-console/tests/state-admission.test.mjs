import test from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createLinuxPlatform } from "../src/platform/linux.mjs";
import { createWindowsPlatform } from "../src/platform/windows.mjs";

test("Windows state admission uses configured data and Node paths and propagates failures", async () => {
  const calls = [];
  const failure = new Error("host.state_unreadable");
  const platform = createWindowsPlatform({ homeDir: "/fixture", env: {}, serviceName: "fixture", credentialAccount: "home",
    readTextFile: async () => 'ARU_NODE_BINARY="C:\\Node Path\\node.exe"\nARU_DATA_DIR=C:\\Host Data\n',
    execFile: async (...args) => { calls.push(args); throw failure; },
  });
  await assert.rejects(platform.validateState("/payload"), error => error === failure);
  assert.equal(calls[0][0], "C:\\Node Path\\node.exe");
  assert.deepEqual(calls[0][1].slice(1), ["--data-dir", "C:\\Host Data", "--container-runtime", "none", "--check-state"]);
});

test("Linux state admission preserves shell-escaped paths as positional arguments", async () => {
  let call;
  const platform = createLinuxPlatform({ homeDir: "/fixture", env: { ARU_LINUX_BASE_ROOT: "/Host Data" },
    execFile: async (...args) => { call = args; },
  });
  await platform.validateState("/Payload Space");
  assert.equal(call[0], "/bin/bash");
  assert.deepEqual(call[1].slice(-2), [join("/Host Data", "instances", "home", "config", "node.env"), join("/Payload Space", "aru-selfhost-stub.mjs")]);
  assert.match(call[1][1], /--check-state$/);
});
