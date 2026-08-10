#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAppServerDriver } from "../codex-app-server-driver.mjs";

class FakeWebSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatch("open", {});
    });
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) ?? [];
    entries.push({ listener, once: options.once === true });
    this.listeners.set(type, entries);
  }

  send(value) {
    const message = JSON.parse(value);
    if (message.id === undefined) return;
    queueMicrotask(() => {
      this.dispatch("message", {
        data: JSON.stringify({ id: message.id, result: {} }),
      });
    });
  }

  dispatch(type, event) {
    const entries = this.listeners.get(type) ?? [];
    this.listeners.set(type, entries.filter((entry) => !entry.once));
    for (const entry of entries) entry.listener(event);
  }
}

const root = mkdtempSync(join(tmpdir(), "aru-codex-driver-"));
const executable = join(root, "codex");
writeFileSync(executable, [
  "#!/bin/sh",
  "printf 'listening on: ws://127.0.0.1:54321\\n' >&2",
  "/bin/sleep 0.1",
].join("\n"));
chmodSync(executable, 0o755);

const originalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = FakeWebSocket;

let executableAvailable = false;
let resolutionCount = 0;
const driver = createCodexAppServerDriver({
  executable: null,
  resolveExecutable() {
    resolutionCount += 1;
    return executableAvailable ? executable : null;
  },
});

assert.equal(driver.status(), "unavailable");
assert.equal(resolutionCount, 0, "status reads must not launch executable probes");
await assert.rejects(() => driver.ensureConnected(), /codex executable is unavailable/);
assert.equal(resolutionCount, 1);

executableAvailable = true;
await driver.ensureConnected();
assert.equal(resolutionCount, 2, "a later connection must retry executable discovery");
assert.equal(driver.status(), "running");

globalThis.WebSocket = originalWebSocket;
console.log("ARU_CODEX_APP_SERVER_DRIVER_SMOKE_OK");
