import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aruHost", Object.freeze({
  bootstrap: () => ipcRenderer.invoke("host:bootstrap"),
  request: (method, path, body) => ipcRenderer.invoke("host:request", method, path, body),
  mcpCatalog: () => ipcRenderer.invoke("host:mcp-catalog"),
  issueMobilePairing: () => ipcRenderer.invoke("host:issue-mobile-pairing"),
  repairConnection: () => ipcRenderer.invoke("host:repair-connection"),
  chooseFolder: () => ipcRenderer.invoke("host:choose-folder"),
  download: (path, suggestedName) => ipcRenderer.invoke("host:download", path, suggestedName),
  qr: (value) => ipcRenderer.invoke("host:qr", value),
  service: (action) => ipcRenderer.invoke("host:service", action),
  uninstallHost: () => ipcRenderer.invoke("host:uninstall"),
  checkUpdate: () => ipcRenderer.invoke("host:check-update"),
  openUpdate: (url) => ipcRenderer.invoke("host:open-update", url),
}));
