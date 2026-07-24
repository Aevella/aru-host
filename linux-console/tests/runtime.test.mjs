import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  linuxReleaseAsset,
  parsePairingLink,
  readInstalledVersion,
  readPort,
  validateHostRequest,
} from "../src/runtime.mjs";

test("Host request allowlist admits owned routes and blocks traversal", () => {
  assert.deepEqual(validateHostRequest("GET", "/aru/v1/diagnostics"), {
    method: "GET", path: "/aru/v1/diagnostics",
  });
  assert.deepEqual(validateHostRequest("POST", "/aru/v1/plugins/plugin.test/enable"), {
    method: "POST", path: "/aru/v1/plugins/plugin.test/enable",
  });
  assert.deepEqual(validateHostRequest("POST", "/aru/v1/hosted-collaborators/root_1/surfaces/surface_1/rollback"), {
    method: "POST", path: "/aru/v1/hosted-collaborators/root_1/surfaces/surface_1/rollback",
  });
  assert.deepEqual(validateHostRequest("PUT", "/aru/v1/hosted-collaborators/root_1/conversations/conversation_1/approvals/approval_1"), {
    method: "PUT", path: "/aru/v1/hosted-collaborators/root_1/conversations/conversation_1/approvals/approval_1",
  });
  assert.throws(() => validateHostRequest("GET", "https://example.com"));
  assert.throws(() => validateHostRequest("GET", "/aru/v1/../state"));
  assert.throws(() => validateHostRequest("POST", "/aru/v1/diagnostics"));
  assert.throws(() => validateHostRequest("PUT", "/aru/v1/plugins/plugin.test/source"));
  assert.throws(() => validateHostRequest("PUT", "/aru/v1/hosted-collaborators/root_1/surfaces/surface_1/rollback"));
});

test("pairing parser requires the complete local grant", () => {
  const link = "aru://pair?canonicalUrl=http%3A%2F%2F192.168.1.2%3A8787&serverId=home-linux&pairingToken=secret";
  assert.equal(parsePairingLink(`restarting\n${link}\nready`), link);
  assert.throws(() => parsePairingLink("aru://pair?serverId=home-linux"));
});

test("installed metadata remains bounded", () => {
  assert.equal(readInstalledVersion("ARU_INSTALL_RELEASE_VERSION=0.28.1\n"), "0.28.1");
  assert.equal(readInstalledVersion("ARU_INSTALL_RELEASE_VERSION='0.28.1'\n"), "0.28.1");
  assert.equal(readPort("ARU_PORT=8789\n"), 8789);
  assert.equal(readPort("ARU_PORT=nope\n"), 8787);
});

test("release asset names are architecture-specific", () => {
  assert.equal(linuxReleaseAsset("0.28.1", "x64"), "aru-host-linux-0.28.1-x64.deb");
  assert.equal(linuxReleaseAsset("0.28.1", "arm64"), "aru-host-linux-0.28.1-arm64.deb");
  assert.equal(linuxReleaseAsset("0.28.1", "ia32"), null);
});

test("desktop shell keeps renderer privileges narrow", async () => {
  const [main, preload, html, packageManifest] = await Promise.all([
    readFile(new URL("../src/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/preload.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/index.html", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(preload, /ipcRenderer\s*:/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);
  const metadata = JSON.parse(packageManifest);
  assert.equal(metadata.name, "aru-host");
  assert.equal(metadata.build.linux.executableName, "aru-host");
  assert.equal(metadata.build.linux.syncDesktopName, true);
  assert.ok(metadata.build.deb.depends.includes("libasound2t64 | libasound2"));
  assert.ok(metadata.build.deb.depends.includes("libatspi2.0-0t64 | libatspi2.0-0"));
  assert.ok(metadata.build.deb.depends.includes("libgtk-3-0t64 | libgtk-3-0"));
  assert.ok(metadata.build.deb.depends.includes("libsecret-tools"));
  assert.ok(metadata.build.deb.depends.includes("systemd"));
});
