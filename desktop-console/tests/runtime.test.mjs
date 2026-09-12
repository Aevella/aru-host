import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  desktopReleaseAsset,
  linuxReleaseAsset,
  parsePairingLink,
  readInstalledVersion,
  readPort,
  validateHostRequest,
} from "../src/runtime.mjs";
import { createDesktopPlatform } from "../src/platform/index.mjs";

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
  assert.deepEqual(validateHostRequest("POST", "/aru/v1/hosted-collaborators/root_1/projects/project_1/publish"), {
    method: "POST", path: "/aru/v1/hosted-collaborators/root_1/projects/project_1/publish",
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
  assert.equal(readPort("ARU_PORT=8789\r\n"), 8789, "Windows-written env files keep working");
  assert.equal(readPort("ARU_PORT=nope\n"), 8787);
});

test("release asset names are architecture- and platform-specific", () => {
  assert.equal(linuxReleaseAsset("0.28.1", "x64"), "aru-host-linux-0.28.1-x64.deb");
  assert.equal(linuxReleaseAsset("0.28.1", "arm64"), "aru-host-linux-0.28.1-arm64.deb");
  assert.equal(linuxReleaseAsset("0.28.1", "ia32"), null);
  assert.equal(desktopReleaseAsset("windows", "0.30.0", "x64"), "aru-host-windows-0.30.0-x64.exe");
  assert.equal(desktopReleaseAsset("windows", "0.30.0", "arm64"), "aru-host-windows-0.30.0-arm64.exe");
  assert.equal(desktopReleaseAsset("windows", "0.30.0", "ia32"), null);
  assert.equal(desktopReleaseAsset("darwin", "0.30.0", "x64"), null);
});

test("platform selection maps process platforms to owners and rejects the rest", () => {
  const context = { homeDir: "/home/test", env: {}, serviceName: "svc", credentialAccount: "home" };
  assert.equal(createDesktopPlatform(context, "linux").id, "linux");
  assert.equal(createDesktopPlatform(context, "linux").secretStorageId, "linux-secret-service");
  assert.equal(createDesktopPlatform({ ...context, homeDir: "C:\\Users\\test" }, "win32").id, "windows");
  assert.equal(createDesktopPlatform({ ...context, homeDir: "C:\\Users\\test" }, "win32").secretStorageId, "windows-dpapi");
  assert.throws(() => createDesktopPlatform(context, "darwin"));
});

test("windows platform owns scheduled-task lifetime and DPAPI credential outlet", async () => {
  const calls = [];
  const execFile = async (command, args) => {
    calls.push([command, args]);
    return { stdout: "", stderr: "" };
  };
  const written = [];
  const writeSecretInput = async (command, args, input) => {
    written.push({ command, args, input });
  };
  const platform = createDesktopPlatform({
    homeDir: "C:\\Users\\test",
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    serviceName: "cn.aelion.aru.host-console.v2",
    credentialAccount: "home",
    execFile,
    fileExists: () => true,
    writeSecretInput,
  }, "win32");

  assert.match(platform.nodeEnvPath, /AruHost[\\/]instances[\\/]home[\\/]config[\\/]node\.env$/);

  await platform.startService();
  assert.equal(calls.at(-1)[0], "powershell.exe");
  assert.match(calls.at(-1)[1].join(" "), /Start-ScheduledTask -TaskName 'Aru Host \(home\)'/);

  await platform.runInstaller("C:\\Resources\\HostCore", "0.30.0");
  const installerArgs = calls.at(-1)[1];
  assert.ok(installerArgs.includes("-File"));
  assert.match(installerArgs.join(" "), /install-windows\.ps1/);
  assert.match(installerArgs.join(" "), /-ReleaseVersion 0\.30\.0/);

  await platform.writeCredential("secret-value");
  assert.equal(written.length, 1);
  assert.equal(written[0].command, "powershell.exe");
  const writeScript = written[0].args.join(" ");
  assert.match(writeScript, /ProtectedData\]::Protect/);
  assert.match(writeScript, /host-console\.v2[\\/]+home\.dpapi/);
  assert.equal(written[0].input, "secret-value\n", "secret travels over stdin, never argv");
  assert.doesNotMatch(writeScript, /secret-value/);

  const readCalls = [];
  const readPlatform = createDesktopPlatform({
    homeDir: "C:\\Users\\test",
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    serviceName: "cn.aelion.aru.host-console.v2",
    credentialAccount: "home",
    execFile: async (command, args) => {
      readCalls.push([command, args]);
      const error = new Error("missing");
      error.code = 44;
      throw error;
    },
    fileExists: () => true,
  }, "win32");
  assert.equal(await readPlatform.readCredential(), null, "exit 44 means not-found, not failure");
  assert.match(readCalls.at(-1)[1].join(" "), /ProtectedData\]::Unprotect/);
});

test("desktop shell keeps renderer privileges narrow", async () => {
  const [main, preload, html, packageManifest] = await Promise.all([
    readFile(new URL("../src/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/preload.cjs", import.meta.url), "utf8"),
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
  assert.deepEqual(metadata.build.win.target, ["nsis"]);
  assert.equal(metadata.build.win.artifactName, "aru-host-windows-${version}-${arch}.${ext}");
  assert.equal(metadata.build.nsis.perMachine, false, "Windows install stays per-user, no admin requirement");
  assert.equal(metadata.build.nsis.deleteAppDataOnUninstall, false, "uninstall preserves user data by default");
});
