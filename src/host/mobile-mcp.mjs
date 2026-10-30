import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createMobileMCPTransport } from "./mobile-mcp-transport.mjs";

const STATUS_TOOL = "aru_mobile_mcp_status";
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash("sha256").update(value).digest("hex");
export function createMobileMCP({ secretStore, connect = createMobileMCPTransport() }) {
  const observations = new Map();
  const active = new Map();
  const account = (id, epoch) => `mobile_mcp_${digest(`${id}/${epoch}`)}`;
  async function seal(id, epoch, connections) {
    if (!Array.isArray(connections)) throw new Error("mcpConnections must be an array");
    const ids = new Set();
    for (const config of connections) {
      if (!config || typeof config.id !== "string" || !config.id || ids.has(config.id)) throw new Error("MCP connection identity is missing or duplicated");
      ids.add(config.id);
    }
    const plain = canonical(connections);
    const fingerprint = digest(plain);
    if (!connections.length) return { fingerprint, count: 0 };
    let encoded;
    try { encoded = await secretStore.read(account(id, epoch)); }
    catch {
      // This key protects a disposable execution projection, not canonical data.
      // A complete phone snapshot can replace a damaged key; write still requires
      // a working secret backend and never falls back to plaintext.
      encoded = null;
    }
    if (!encoded || Buffer.from(encoded, "base64").length !== 32) { encoded = randomBytes(32).toString("base64"); await secretStore.write(account(id, epoch), encoded); }
    const key = Buffer.from(encoded, "base64"), nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(account(id, epoch)));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { fingerprint, count: connections.length, nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }
  async function open(replica) {
    if (!replica.mcp?.count) return [];
    const key = await secretStore.read(account(replica.sourceCollaboratorId, replica.epoch));
    if (!key) throw new Error("MCP credentials unavailable; synchronize again from the phone");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), Buffer.from(replica.mcp.nonce, "base64"));
    decipher.setAAD(Buffer.from(account(replica.sourceCollaboratorId, replica.epoch)));
    decipher.setAuthTag(Buffer.from(replica.mcp.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(replica.mcp.ciphertext, "base64")), decipher.final()]));
  }
  function invalidate(id) {
    for (const entry of active.get(id) ?? []) entry.abort();
    observations.delete(id);
  }
  async function remove(id, epoch) { await secretStore.remove(account(id, epoch)); }
  async function session(replica, config, signal, catalog, action) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const entries = active.get(replica.sourceCollaboratorId) ?? new Set(); entries.add(controller); active.set(replica.sourceCollaboratorId, entries);
    let client;
    try { client = await connect(config, { signal: controller.signal, catalog }); return await action(client); }
    finally { client?.close(); entries.delete(controller); if (!entries.size) active.delete(replica.sourceCollaboratorId); signal?.removeEventListener("abort", abort); }
  }
  function toolName(config, tool) { return `mobile_mcp_${digest(`${config.id}/${tool.name}`).slice(0, 24)}`; }
  function projected(config, tool) {
    let inputSchema = tool.inputSchema;
    if (!inputSchema) { try { inputSchema = JSON.parse(tool.inputSchemaJSON); } catch { return null; } }
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema) || (inputSchema.type && inputSchema.type !== "object")) return null;
    inputSchema = { ...inputSchema, type: "object" };
    return { name: toolName(config, tool), title: `${config.name} · ${tool.title || tool.name}`,
      description: `${config.name} / ${tool.name}: ${tool.description || ""}`,
      inputSchema, annotations: tool.annotations,
      mobileMCP: { serverId: config.id, toolName: tool.name,
        approvalMode: tool.approvalMode ?? config.approvalMode ?? "requires_confirmation" } };
  }
  async function catalog(replica, signal, admit, allowedIds) {
    admit();
    let configs;
    try { configs = await open(replica); }
    catch { admit(); observations.set(replica.sourceCollaboratorId, [{ state: "failed", message: "MCP credentials could not be read. Synchronize again from the phone; other Host tools remain available." }]); return [statusTool()]; }
    admit();
    const states = [];
    const groups = await Promise.all(configs.filter(config => !allowedIds || allowedIds.includes(config.id)).map(async config => {
      const cached = Array.isArray(config.tools) ? config.tools : [];
      let discovered = cached;
      try {
        if (config.failure) throw new Error(config.failure);
        if (config.expiresAt && config.expiresAt <= Date.now()) throw new Error("MCP authorization expired");
        discovered = await session(replica, config, signal, true, async client => {
          const tools = [], cursors = new Set(); let cursor;
          do {
            const page = await client.rpc("tools/list", cursor ? { cursor } : {});
            if (!Array.isArray(page.tools)) throw new Error("MCP tool catalog is malformed");
            tools.push(...page.tools);
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor)) throw new Error("MCP catalog cursor did not advance");
            cursors.add(cursor);
          } while (cursor);
          return tools;
        });
        states.push({ serverId: config.id, name: config.name, state: "ready", toolCount: discovered.length });
      } catch {
        states.push({ serverId: config.id, name: config.name, state: "failed",
          message: config.failure || "Connection or authorization failed. Check this MCP on the phone, synchronize, and retry; other servers remain available." });
      }
      const policy = new Map(cached.map(tool => [tool.name, tool]));
      return discovered.filter(tool => tool?.name && policy.get(tool.name)?.enabled !== false)
        .map(tool => projected(config, { ...tool, approvalMode: policy.get(tool.name)?.approvalMode }))
        .filter(Boolean);
    }));
    admit(); observations.set(replica.sourceCollaboratorId, states.sort((a, b) => configs.findIndex(c => c.id === a.serverId) - configs.findIndex(c => c.id === b.serverId)));
    return [statusTool(), ...groups.flat()];
  }
  function statusTool() { return { name: STATUS_TOOL, title: "代执行 MCP 连接状态", description: "Read each delegated MCP connection's readiness and recovery action. Failed discovery is not an empty server.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }; }
  async function call(replica, name, args, context, admit) {
    admit();
    if (name === STATUS_TOOL) return { content: [{ type: "text", text: JSON.stringify(observations.get(replica.sourceCollaboratorId) ?? []) }] };
    const tool = context.tool;
    if (!tool?.mobileMCP) throw new Error("Unknown delegated MCP tool");
    const configs = await open(replica); admit();
    const config = configs.find(item => item.id === tool.mobileMCP.serverId);
    if (!config || config.failure) throw new Error(config?.failure || "MCP was removed; synchronize and start a new task");
    if (config.expiresAt && config.expiresAt <= Date.now()) throw new Error("MCP authorization expired. Open the phone, renew authorization and synchronize; other connections remain available.");
    const policy = config.tools?.find(item => item.name === tool.mobileMCP.toolName);
    if (policy?.enabled === false) throw new Error("MCP tool is disabled");
    if ((policy?.approvalMode ?? config.approvalMode) !== "always_allow") {
      throw new Error("This MCP tool requires confirmation. Allow it in the phone's MCP tool settings and synchronize before unattended execution. This attempt has ended without calling the service.");
    }
    try {
      const result = await session(replica, config, context.signal, false, client => {
        admit(); return client.rpc("tools/call", { name: tool.mobileMCP.toolName, arguments: args });
      });
      admit();
      if (!result || !Array.isArray(result.content)) throw new Error("Invalid MCP tool result");
      return result;
    } catch {
      admit();
      throw new Error(`${config.name}: MCP invocation failed or was interrupted. The remote action may have completed; check its result before repeating a write. Repair the connection and start a new attempt. No automatic replay was performed.`);
    }
  }
  return { seal, catalog, call, invalidate, remove, status: id => observations.get(id) ?? [] };
}
