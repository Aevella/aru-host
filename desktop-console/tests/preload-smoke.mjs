// Run with Electron, not node:test: this exercises the real sandbox loader.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function run() {
  const userData = await mkdtemp(join(tmpdir(), "aru-preload-smoke-"));
  app.setPath("userData", userData);
  let window;
  let exitCode = 1;
  try {
    const main = await readFile(join(root, "src/main.mjs"), "utf8");
    const preloadName = main.match(/preload: resolve\(sourceRoot, "([^"]+)"\)/)?.[1];
    assert.ok(preloadName, "real Console preload path must be found");
    await app.whenReady();
    ipcMain.handle("host:bootstrap", () => ({ probe: "sandbox-bridge-ok" }));
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(root, "src", preloadName),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let preloadError;
    window.webContents.on("preload-error", (_event, _path, error) => { preloadError = error; });
    await window.loadURL("data:text/html,<html><body>Preload smoke</body></html>");
    if (preloadError) throw preloadError;
    const result = await window.webContents.executeJavaScript(`(async () => ({
      bootstrap: await window.aruHost.bootstrap(),
      rawIPC: typeof window.aruHost.ipcRenderer,
      require: typeof window.require,
      process: typeof window.process
    }))()`);
    assert.deepEqual(result, {
      bootstrap: { probe: "sandbox-bridge-ok" },
      rawIPC: "undefined", require: "undefined", process: "undefined",
    });
    console.log("ARU_DESKTOP_PRELOAD_SMOKE_OK");
    exitCode = 0;
  } catch (error) {
    console.error(error);
  } finally {
    ipcMain.removeHandler("host:bootstrap");
    await rm(userData, { recursive: true, force: true }).catch(() => {});
    window?.destroy();
    app.exit(exitCode);
  }
}
run().catch(error => { console.error(error); app.exit(1); });
