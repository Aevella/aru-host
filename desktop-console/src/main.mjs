import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { parsePairingLink, readInstalledVersion, readPort, validateHostRequest } from "./runtime.mjs";
import { waitForContainerRuntime } from "./container-readiness.mjs";
import { createDesktopPlatform } from "./platform/index.mjs";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const serviceName = "cn.aelion.aru.host-console.v2";
const credentialAccount = "home";
const platform = createDesktopPlatform({
  homeDir: app.getPath("home"),
  serviceName,
  credentialAccount,
});
const hostCoreRoot = app.isPackaged
  ? join(process.resourcesPath, "HostCore")
  : resolve(sourceRoot, "..", ".host-core");
let mainWindow;
let containerSetupAttempt;

app.setName("Aru Host");
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  registerIPC();
  createWindow();
});
app.on("window-all-closed", () => app.quit());

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    show: false,
    backgroundColor: "#e8e5eb",
    icon: resolve(sourceRoot, "..", "assets", "icon.svg"),
    webPreferences: {
      preload: resolve(sourceRoot, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow.loadFile(resolve(sourceRoot, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalURL(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
}

function registerIPC() {
  ipcMain.handle("host:open-container-setup", () => shell.openExternal(
    platform.id === "windows"
      ? "https://podman-desktop.io/docs/installation/windows-install"
      : "https://podman.io/docs/installation"));
  ipcMain.handle("host:setup-container-runtime", async () => {
    if (containerSetupAttempt) return containerSetupAttempt;
    containerSetupAttempt = (async () => {
      await platform.setupContainerRuntime();
      return waitForContainerRuntime(signal =>
        requestHost("GET", "/.well-known/aru.json", undefined, false, {}, signal));
    })();
    try { return await containerSetupAttempt; }
    finally { containerSetupAttempt = undefined; }
  });
  ipcMain.handle("host:bootstrap", async () => {
    await ensureHostInstalled();
    const manifest = await requestHost("GET", "/.well-known/aru.json", undefined, false);
    let credential = await platform.readCredential();
    if (!credential) credential = await pairConsole();
    const firewall = await platform.firewallState();
    try {
      const [diagnostics, nodeSettings, deviceInventory, update] = await Promise.all([
        requestHost("GET", "/aru/v1/diagnostics"),
        requestHost("GET", "/aru/v1/node-settings"),
        requestHost("GET", "/aru/v1/devices"),
        checkForUpdate().catch(() => null),
      ]);
      return { manifest, diagnostics, nodeSettings, deviceInventory, update, secretStorage: platform.secretStorageId, firewall };
    } catch (error) {
      if (error.code !== "credential_rejected") throw error;
      await platform.deleteCredential();
      await pairConsole();
      return {
        manifest,
        diagnostics: await requestHost("GET", "/aru/v1/diagnostics"),
        nodeSettings: await requestHost("GET", "/aru/v1/node-settings"),
        deviceInventory: await requestHost("GET", "/aru/v1/devices"),
        update: await checkForUpdate().catch(() => null),
        secretStorage: platform.secretStorageId,
        firewall,
      };
    }
  });
  ipcMain.handle("host:request", (_event, method, path, body) => requestHost(method, path, body));
  ipcMain.handle("host:mcp-catalog", () => loadMCPCatalog());
  ipcMain.handle("host:issue-mobile-pairing", () => issuePairingLink());
  ipcMain.handle("host:repair-connection", async () => {
    await platform.deleteCredential();
    await pairConsole();
    return true;
  });
  ipcMain.handle("host:choose-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("host:download", (_event, path, suggestedName) => downloadHostFile(path, suggestedName));
  ipcMain.handle("host:qr", (_event, value) => QRCode.toDataURL(String(value), {
    margin: 1, width: 360, color: { dark: "#4f4869", light: "#00000000" },
  }));
  ipcMain.handle("host:service", async (_event, action) => {
    if (action === "start") await platform.startService();
    else if (action === "restart") await platform.restartService();
    else throw new Error("Unsupported service action");
    return true;
  });
  ipcMain.handle("host:uninstall", async () => {
    await platform.uninstallHost();
    await platform.deleteCredential().catch(() => {});
    return true;
  });
  ipcMain.handle("host:configure-firewall", () => platform.configureFirewall());
  ipcMain.handle("host:check-update", () => checkForUpdate());
  ipcMain.handle("host:open-update", (_event, url) => {
    if (!isAllowedExternalURL(url)) throw new Error("Invalid update URL");
    return shell.openExternal(url);
  });
}

async function ensureHostInstalled() {
  const release = JSON.parse(await readFile(join(hostCoreRoot, "release.json"), "utf8"));
  if (release.schema !== "aru.host.release.v1" || release.version !== app.getVersion()) {
    throw new Error("The bundled Host Core does not match this Console release");
  }
  let installedVersion = null;
  try { installedVersion = readInstalledVersion(await readFile(platform.installEnvPath, "utf8")); } catch {}
  if (installedVersion !== release.version || !platform.hostInstalled()) {
    await platform.runInstaller(hostCoreRoot, release.version);
    return;
  }
  await platform.startService();
}

async function pairConsole() {
  const link = await issuePairingLink();
  const token = new URL(link).searchParams.get("pairingToken");
  const grant = await requestHost("POST", "/aru/v1/pair", {
    pairingToken: token,
    deviceLabel: "Aru Host Console",
    deviceRole: "host-console",
  }, false);
  if (!grant?.credentialSecret) throw new Error("Aru Host returned an invalid Console credential");
  await platform.writeCredential(grant.credentialSecret);
  return grant.credentialSecret;
}

async function issuePairingLink() {
  return parsePairingLink(await platform.issuePairingOutput());
}

async function requestHost(method, path, body, authenticated = true, extraHeaders = {}, signal) {
  const request = validateHostRequest(method, path);
  let contents = "";
  try { contents = await readFile(platform.nodeEnvPath, "utf8"); } catch {}
  const url = new URL(request.path, `http://127.0.0.1:${readPort(contents)}`);
  const headers = { Accept: "application/json", ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authenticated) {
    const credential = await platform.readCredential();
    if (!credential) throw new Error("The secure Console connection is unavailable");
    headers.Authorization = `Bearer ${credential}`;
  }
  const response = await fetch(url, {
    signal,
    method: request.method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) {
    const error = new Error("The Console credential is no longer accepted");
    error.code = "credential_rejected";
    throw error;
  }
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(failure.message ?? failure.error ?? `Host returned HTTP ${response.status}`);
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? response.json() : response.text();
}

async function loadMCPCatalog() {
  let contents = "";
  try { contents = await readFile(platform.nodeEnvPath, "utf8"); } catch {}
  const base = `http://127.0.0.1:${readPort(contents)}`;
  const credential = await platform.readCredential();
  if (!credential) throw new Error("The secure Console connection is unavailable");
  const headers = { Authorization: `Bearer ${credential}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
  const initializedResponse = await fetch(`${base}/aru/v1/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Aru Host Console", version: app.getVersion() } } }),
  });
  if (!initializedResponse.ok) throw new Error("MCP initialize failed");
  const initialized = await initializedResponse.json();
  const sessionId = initializedResponse.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("Host did not return an MCP session");
  const toolsResponse = await fetch(`${base}/aru/v1/mcp`, {
    method: "POST", headers: { ...headers, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  if (!toolsResponse.ok) throw new Error("MCP tool discovery failed");
  const tools = await toolsResponse.json();
  return {
    serverName: initialized.result.serverInfo.name,
    serverVersion: initialized.result.serverInfo.version,
    protocolVersion: initialized.result.protocolVersion,
    tools: tools.result.tools,
  };
}

async function downloadHostFile(path, suggestedName) {
  validateHostRequest("GET", path);
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: suggestedName });
  if (result.canceled || !result.filePath) return null;
  const contents = await readFile(platform.nodeEnvPath, "utf8");
  const credential = await platform.readCredential();
  const response = await fetch(new URL(path, `http://127.0.0.1:${readPort(contents)}`), {
    headers: { Authorization: `Bearer ${credential}` },
  });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  await mkdir(dirname(result.filePath), { recursive: true });
  await writeFile(result.filePath, Buffer.from(await response.arrayBuffer()));
  if (platform.id !== "windows") await chmod(result.filePath, 0o600);
  return result.filePath;
}

async function checkForUpdate() {
  const response = await fetch("https://api.github.com/repos/Aevella/aru-host/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `Aru-Host/${app.getVersion()}` },
  });
  if (!response.ok) throw new Error("Could not check the stable release channel");
  const release = await response.json();
  const version = String(release.tag_name ?? "").replace(/^v/, "");
  if (!isNewerVersion(version, app.getVersion())) return null;
  const name = platform.releaseAssetName(version);
  const asset = release.assets?.find((candidate) => candidate.name === name);
  return asset ? { version, name, url: asset.browser_download_url, preview: platform.id === "windows" } : null;
}

function isNewerVersion(candidate, current) {
  const parse = (value) => String(value).split(".").map((part) => Number(part));
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const a = parse(candidate); const b = parse(current);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

function isAllowedExternalURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["github.com", "api.github.com"].includes(url.hostname);
  } catch { return false; }
}
