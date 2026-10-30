import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createMobileCollaboratorReplicaHost } from "../mobile-collaborator-replicas.mjs";
import { randomBytes } from "node:crypto";
import { createProviderSecretStore } from "../provider-secret-store.mjs";
import { createMobileMCPTransport } from "../src/host/mobile-mcp-transport.mjs";
import { createCollaboratorConversationHost } from "../collaborator-conversations.mjs";

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const tool = { name: "write_note", inputSchemaJSON: '{"type":"object","properties":{"text":{"type":"string"}}}', enabled: true };
const connection = (id = "one") => ({ id, name: id, transport: "streamable-http", url: "https://private.invalid/mcp?token=secret-query", headers: { Authorization: "Bearer secret-header" }, tools: [tool], approvalMode: "always_allow" });
const body = (connections = [connection()], revision = 1, epoch = 1) => ({
  schema: "aru.selfhost.mobile-collaborator-replica.v1", sourceCollaboratorId: "phone", displayName: "Phone", systemPrompt: "hello", memories: [], references: [], conversations: [],
  readerHostCollaboratorIds: ["host"], executorHostCollaboratorId: "host", epoch, revision, generatedAt: 1,
  mcpConnections: connections, rules: [{ ruleId: "rule", title: "Run tools", nextFireAt: 1, enabled: true,
    conversationMode: "follow_latest", scheduleKind: "one_time", sourceVersion: "one", updatedAt: 1, mcpServerIds: connections.map(c => c.id) }],
});
function setup(t, options = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mobile-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secrets = new Map(); let removeFails = false, writeFails = false;
  const secretStore = options.secretStore ?? { read: async key => secrets.get(key), write: async (key, value) => { if (writeFails) throw new Error("locked"); secrets.set(key, value); },
    remove: async key => { if (removeFails) throw new Error("locked"); secrets.delete(key); } };
  const calls = [];
  const connect = options.connect ?? (async config => {
    if (config.id === "broken") throw new Error("offline");
    return { close() {}, async rpc(method, params) {
      if (method === "tools/list") return { tools: [{ name: "write_note", inputSchema: JSON.parse(tool.inputSchemaJSON) }] };
      calls.push({ config, params }); return { content: [{ type: "text", text: "saved" }] };
    } };
  });
  let captured, response;
  const make = () => createMobileCollaboratorReplicaHost({ dataDir: root, readJSONBody: async req => req.body,
    sendJSON: (_res, status, value) => { response = { status, value }; }, HttpError,
    collaboratorForId: id => ({ collaboratorId: id, displayName: "Host", approvalPolicy: { mode: "always_allow" } }),
    maximumRequestBytes: 1e6, trigger: (_executor, replica, rule) => { captured = { replica, rule }; },
    now: () => 1000, setTimer: () => 1, clearTimer() {}, mcpSecretStore: secretStore, mcpConnect: connect });
  let host = make();
  async function route(method, path, data) { await host.route({ method, url: path, body: data }, {}, path, () => {}); return response.value; }
  const put = data => route("PUT", "/aru/v1/mobile-collaborator-replicas/phone", data);
  function identity() { return { authority: "mobile-replica", mobileSourceId: "phone", mobileEpoch: captured.replica.epoch,
    mobileMCPFingerprint: captured.replica.mcp?.fingerprint, executorCollaboratorId: "host", mobileMCPServerIds: captured.rule.mcpServerIds }; }
  return { root, calls, secrets, put, route, identity, get host() { return host; }, get captured() { return captured; },
    restart() { host.stop(); host = make(); }, lockWrites(value) { writeFails = value; }, lockRemoval(value) { removeFails = value; } };
}

test("sealed MCP survives restart, discovers and calls without a phone; credentials never enter readable replica", async t => {
  const f = setup(t); await f.put(body()); f.restart(); await f.host.runDue();
  const who = f.identity(), tools = await f.host.mcpTools(who);
  const remote = tools.find(item => item.mobileMCP);
  const result = await f.host.callMCP(remote.name, { text: "hi" }, who, { tool: remote });
  assert.equal(result.content[0].text, "saved"); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].config.headers.Authorization, "Bearer secret-header");
  const disk = readFileSync(join(f.root, "mobile-collaborator-replicas", "records-v2", "scheduler.json"), "utf8");
  assert.ok(!disk.includes("secret-header") && !disk.includes("secret-query") && !disk.includes("private.invalid"));
  assert.ok(!JSON.stringify(tools).includes("secret-header"));
});

test("one offline MCP does not hide healthy tools; checking again recovers without deleting configuration", async t => {
  let online = false;
  const f = setup(t, { connect: async config => {
    if (config.id === "broken" && !online) throw new Error("offline");
    return { close() {}, rpc: async () => ({ tools: [{ name: "write_note", inputSchema: { type: "object" } }] }) };
  } });
  await f.put(body([connection(), connection("broken")]));
  const first = await f.route("POST", "/aru/v1/mobile-collaborator-replicas/phone/mcp-check", { epoch: 1 });
  assert.deepEqual(first.connections.map(x => x.state), ["ready", "failed"]);
  online = true;
  const second = await f.route("POST", "/aru/v1/mobile-collaborator-replicas/phone/mcp-check", { epoch: 1 });
  assert.ok(second.connections.every(x => x.state === "ready"));
});

test("credential storage failure is retryable using the same epoch and revision", async t => {
  const f = setup(t); f.lockWrites(true); await assert.rejects(f.put(body()));
  f.lockWrites(false); const receipt = await f.put(body()); assert.equal(receipt.mcpVersion, 1);
  await f.host.runDue(); assert.ok((await f.host.mcpTools(f.identity())).some(x => x.mobileMCP));
});

test("revocation blocks stale tools even when credential cleanup fails, and retry finishes cleanup", async t => {
  const f = setup(t); await f.put(body()); await f.host.runDue();
  const who = f.identity(), remote = (await f.host.mcpTools(who)).find(x => x.mobileMCP);
  f.lockRemoval(true);
  await assert.rejects(f.route("POST", "/aru/v1/mobile-collaborator-replicas/phone/revoke", { epoch: 1 }));
  assert.throws(() => f.host.callMCP(remote.name, {}, who, { tool: remote }), /revoked/);
  f.lockRemoval(false); await f.route("POST", "/aru/v1/mobile-collaborator-replicas/phone/revoke", { epoch: 1 });
  assert.equal(f.secrets.size, 0);
  await f.put(body([connection()], 2, 2)); await f.host.runDue();
  assert.ok((await f.host.mcpTools(f.identity())).some(x => x.mobileMCP));
});

test("changed configuration rejects old request; selected conversation cannot use another connection", async t => {
  const f = setup(t); await f.put(body()); await f.host.runDue();
  const who = f.identity(), remote = (await f.host.mcpTools(who)).find(x => x.mobileMCP);
  assert.throws(() => f.host.callMCP(remote.name, {}, { ...who, mobileMCPServerIds: [] }, { tool: remote }), /scope/);
  await f.put(body([], 2));
  assert.throws(() => f.host.callMCP(remote.name, {}, who, { tool: remote }), /changed/);
  assert.equal(f.calls.length, 0);
});

test("confirmation policy never waits indefinitely or borrows the executor's blanket approval", async t => {
  const f = setup(t); await f.put(body([{ ...connection(), approvalMode: "requires_confirmation" }])); await f.host.runDue();
  const who = f.identity(), remote = (await f.host.mcpTools(who)).find(x => x.mobileMCP);
  await assert.rejects(f.host.callMCP(remote.name, {}, who, { tool: remote }), /requires confirmation/);
  assert.equal(f.calls.length, 0);
});

test("late remote completion after configuration removal cannot become success and is not replayed", async t => {
  let finish, invoked = 0;
  const f = setup(t, { connect: async () => ({ close() {}, rpc: async method => {
    if (method === "tools/list") return { tools: [{ name: "write_note", inputSchema: { type: "object" } }] };
    invoked++; return new Promise(resolve => { finish = () => resolve({ content: [] }); });
  } }) });
  await f.put(body()); await f.host.runDue(); const who = f.identity(), remote = (await f.host.mcpTools(who)).find(x => x.mobileMCP);
  const pending = f.host.callMCP(remote.name, {}, who, { tool: remote });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await f.put(body([], 2)); finish(); await assert.rejects(pending, /changed/); assert.equal(invoked, 1);
});

async function serverFixture(t, handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function requestBody(req) { let body = ""; for await (const chunk of req) body += chunk; return JSON.parse(body); }

test("real HTTP transport handles auth, session negotiation, SSE response and a dropped write without replay", async t => {
  let writes = 0;
  const url = await serverFixture(t, async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer token"); const msg = await requestBody(req);
    if (msg.method === "initialize") { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25" } })); return; }
    assert.equal(req.headers["mcp-session-id"], "session");
    if (!msg.id) { res.writeHead(202); res.end(); return; }
    if (msg.method === "tools/call") { writes++; req.socket.destroy(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } })}\n\n`);
  });
  const connect = createMobileMCPTransport();
  const client = await connect({ url, headers: { Authorization: "Bearer token" }, transport: "streamable-http" });
  t.after(client.close); assert.deepEqual(await client.rpc("tools/list", {}), { tools: [] });
  await assert.rejects(client.rpc("tools/call", { name: "write" })); assert.equal(writes, 1);
});

test("stalled invocation terminates and a fresh session succeeds without replaying the old write", async t => {
  let stalled = true, writes = 0;
  const url = await serverFixture(t, async (req, res) => {
    const msg = await requestBody(req);
    if (!msg.id) { res.writeHead(202); res.end(); return; }
    if (msg.method === "tools/call") { writes++; if (stalled) return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize"
      ? { protocolVersion: "2025-11-25" } : { content: [{ type: "text", text: "recovered" }] } }));
  });
  const connect = createMobileMCPTransport();
  const config = { url, headers: {}, transport: "streamable-http", requestTimeoutSeconds: 0.2 };
  const first = await connect(config);
  await assert.rejects(first.rpc("tools/call", { name: "write" })); first.close();
  assert.equal(writes, 1);
  stalled = false;
  const next = await connect({ ...config, requestTimeoutSeconds: 5 }); t.after(next.close);
  assert.equal((await next.rpc("tools/call", { name: "write" })).content[0].text, "recovered");
  assert.equal(writes, 2);
});

test("legacy SSE transport discovers same-origin POST endpoint and cancels cleanly", async t => {
  let stream;
  const url = await serverFixture(t, async (req, res) => {
    if (req.method === "GET") { stream = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: endpoint\ndata: /messages\n\n"); return; }
    assert.equal(req.url, "/messages"); const msg = await requestBody(req);
    res.writeHead(202); res.end();
    if (msg.id) stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { protocolVersion: "2024-11-05" } : { content: [{ type: "text", text: "done" }] } })}\n\n`);
  });
  const client = await createMobileMCPTransport()({ url, headers: {}, transport: "sse" });
  t.after(client.close); assert.equal((await client.rpc("tools/call", { name: "read" })).content[0].text, "done");
});

test("cross-origin redirects never carry delegated credentials", async t => {
  let leaked = false;
  const destination = await serverFixture(t, (_req, res) => { leaked = true; res.end(); });
  const url = await serverFixture(t, (_req, res) => { res.writeHead(307, { Location: destination }); res.end(); });
  await assert.rejects(createMobileMCPTransport()({ url, transport: "streamable-http", headers: { Authorization: "private" } }));
  assert.equal(leaked, false);
});

test("real conversation path passes external tools to the driver and returns its result under the phone owner", async t => {
  const f = setup(t); await f.put(body()); await f.host.runDue();
  let finished; const completion = new Promise(resolve => { finished = resolve; });
  const executor = { collaboratorId: "host", displayName: "Host", toolAccess: { mode: "selected", toolNames: [] }, approvalPolicy: { mode: "ask" } };
  const conversations = createCollaboratorConversationHost({ dataDir: f.root, HttpError,
    collaboratorForId: () => executor, readJSONBody: async req => req.body, sendJSON() {},
    toolCatalog: (who, signal) => f.host.mcpTools(who, signal),
    executeTool: (name, args, _device, who, context) => f.host.callMCP(name, args, who, context),
    driverForCollaborator: () => ({ async startTurn(request) {
      const remote = request.tools.find(item => item.name.startsWith("mobile_mcp_"));
      try {
        assert.ok(remote, "phone MCP must survive the computer collaborator's selected-tool filter");
        assert.ok(!JSON.stringify(request).includes("secret-header"));
        const result = await request.handler.onToolCall({ tool: remote.name, arguments: { text: "scheduled" } });
        assert.equal(result.content[0].text, "saved"); finished();
      } catch (error) { finished(error); }
      return { threadId: "thread", turnId: "turn" };
    }, interrupt() {} }),
  });
  conversations.runReplicaProactive(executor, f.captured.replica, f.captured.rule, "delivery_integration");
  const failure = await Promise.race([completion, new Promise(resolve => { const timeout = setTimeout(() => resolve(new Error("conversation path stalled")), 3000); timeout.unref(); })]);
  if (failure) throw failure;
  assert.equal(f.calls.length, 1);
});

test("expired OAuth is recoverable and never silently executed", async t => {
  const f = setup(t); await f.put(body([{ ...connection(), expiresAt: 1 }])); await f.host.runDue();
  const who = f.identity(), remote = (await f.host.mcpTools(who)).find(x => x.mobileMCP);
  await assert.rejects(f.host.callMCP(remote.name, {}, who, { tool: remote }), /expired/);
  assert.equal(f.calls.length, 0);
});

test("same-revision retry repairs missing derived key, while changed credentials require a new revision", async t => {
  const f = setup(t); await f.put(body()); f.secrets.clear();
  await f.put(body()); await f.host.runDue();
  assert.ok((await f.host.mcpTools(f.identity())).some(x => x.mobileMCP));
  await assert.rejects(f.put(body([{ ...connection(), url: "https://other.invalid" }])), /newer revision/);
});

test("replacing an epoch removes its credential key without disabling the new grant", async t => {
  const f = setup(t); await f.put(body()); const oldKey = [...f.secrets.keys()][0];
  f.lockRemoval(true); await f.put(body([connection()], 2, 2)); assert.ok(f.secrets.has(oldKey));
  f.lockRemoval(false); await f.put(body([connection()], 2, 2)); assert.ok(!f.secrets.has(oldKey));
  await f.host.runDue(); assert.ok((await f.host.mcpTools(f.identity())).some(x => x.mobileMCP));
});

test("production encrypted credential backend accepts the MCP owner and repaired snapshots replace damaged derived keys", async t => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-keyring-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700); writeFileSync(join(root, "master.key"), randomBytes(32), { mode: 0o600 });
  const secretStore = createProviderSecretStore({ platform: "linux", env: { ARU_PROVIDER_SECRET_ROOT: root } });
  const f = setup(t, { secretStore }); await f.put(body());
  const key = readdirSync(root).find(name => name.startsWith("mobile_mcp_")); assert.ok(key);
  writeFileSync(join(root, key), "damaged");
  await f.put(body()); f.restart(); await f.host.runDue();
  const who = f.identity(), remote = (await f.host.mcpTools(who)).find(x => x.mobileMCP);
  assert.equal((await f.host.callMCP(remote.name, {}, who, { tool: remote })).content[0].text, "saved");
  await f.route("POST", "/aru/v1/mobile-collaborator-replicas/phone/revoke", { epoch: 1 });
  assert.deepEqual(readdirSync(root), ["master.key"]);
});
