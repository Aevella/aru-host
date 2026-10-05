// Synthetic loopback service for the native client/Host protocol acceptance test.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupSnapshotRoutes } from "../src/server/backup-snapshot-routes.mjs";
const directory = mkdtempSync(join(tmpdir(), "aru-snapshot-http-"));
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
let failNextReceipt = false;
const sendJSON = (res, status, value) => {
  if (res.failReceipt && status === 200) { status = 503; value = { error: "synthetic_receipt_loss" }; }
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
const routes = createBackupSnapshotRoutes({ config: { dataDir: directory }, serverId: "fixture-server", sendJSON, HttpError, applyRetention: () => {} });
let uploadedBytes = 0, chunkPuts = 0, chunkGets = 0, commits = 0;
const server = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== "Bearer synthetic") throw new HttpError(401, "unauthorized", "synthetic credential required");
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/test/stats") return sendJSON(res, 200, { uploadedBytes, chunkPuts, chunkGets, commits });
    if (path === "/test/fail-next-receipt" && req.method === "POST") { failNextReceipt = true; return sendJSON(res, 200, {}); }
    if (["POST", "PUT"].includes(req.method)) uploadedBytes += Number(req.headers["content-length"] ?? 0);
    if (req.method === "PUT" && path.includes("/chunks/")) chunkPuts++;
    if (req.method === "POST" && /^\/aru\/v1\/backups\/snapshots\/[a-f0-9-]{36}$/.test(path)) {
      commits++;
      res.failReceipt = failNextReceipt;
      failNextReceipt = false;
    }
    if (req.method === "GET" && path.includes("/chunks/")) chunkGets++;
    if (path === "/aru/v1/backups" && req.method === "GET") return sendJSON(res, 200, { packages: [] });
    if (await routes.route(req, res, path, () => ({ deviceId: "fixture-device" }))) return;
    sendJSON(res, 404, { missing: true });
  } catch (error) { sendJSON(res, error.status ?? 500, { code: error.code ?? "fixture.error", message: error.message }); }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`http://127.0.0.1:${server.address().port}\n`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => { rmSync(directory, { recursive: true, force: true }); process.exit(0); }));
