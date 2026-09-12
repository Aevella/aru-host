import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const configured of [false, true]) {
  test(`node status explains container scope when configured=${configured}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "aru-container-status-"));
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [fileURLToPath(new URL("../aru-selfhost-stub.mjs", import.meta.url)),
      "--data-dir", directory, "--listen-host", "127.0.0.1", "--port", String(port),
      "--base-url", base, "--transport-kind", "lan", "--container-runtime",
      configured ? fileURLToPath(new URL("./fake-container-runtime.sh", import.meta.url)) : "none"],
    { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.resume();
    t.after(async () => {
      if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
      await rm(directory, { recursive: true, force: true });
    });
    let manifest;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { manifest = await (await fetch(`${base}/.well-known/aru.json`)).json(); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(manifest?.capabilities["workspace-runtime"].enabled, configured);
    assert.equal(manifest.capabilities["node-workspaces"].enabled, true);
    const pairingURL = output.split(/\r?\n/).find(line => line.startsWith("aru://pair?"));
    assert.ok(pairingURL);
    const grant = await (await fetch(`${base}/aru/v1/pair`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: new URL(pairingURL).searchParams.get("pairingToken"), deviceLabel: "scope-test", deviceRole: "host-console" }),
    })).json();
    const headers = { "content-type": "application/json", authorization: `Bearer ${grant.credentialSecret}` };
    const rpc = (method, params) => fetch(`${base}/aru/v1/mcp`, { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }) });
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "scope-test", version: "1" } });
    headers["mcp-session-id"] = init.headers.get("mcp-session-id");
    await init.arrayBuffer();
    const result = await (await rpc("tools/call", { name: "aru_node_status", arguments: {} })).json();
    assert.equal(result.result.isError, false);
    assert.equal(result.result.structuredContent.workspaceRuntimeAvailable, configured);
    const description = result.result.structuredContent.workspaceRuntimeDescription;
    assert.match(description, /Node\/Python\/Shell/);
    assert.match(description, /[Pp]roject files/);
    assert.match(description, /independent/);
  });
}
