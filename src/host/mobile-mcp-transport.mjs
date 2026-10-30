import { randomUUID } from "node:crypto";

// One short-lived session per catalog/call. Failed sessions never poison later runs.
// No automatic replay of tools/call: a dropped response may follow a real effect.
export function createMobileMCPTransport({ fetchImpl = fetch } = {}) {
  return async function connect(config, { signal, catalog = false } = {}) {
    const controller = new AbortController();
    const timeout = catalog ? 30_000 : (config.requestTimeoutSeconds ?? 1800) * 1000;
    const timer = setTimeout(() => controller.abort(new Error("MCP request timed out")), timeout);
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const pending = new Map();
    let endpoint = config.url, sessionId, version, reader;
    let endpointReady, endpointFailed;
    const ready = new Promise((resolve, reject) => { endpointReady = resolve; endpointFailed = reject; });
    // The stream can fail after endpoint discovery; every waiter has an owner.
    ready.catch(() => {});
    function close() {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      controller.abort(); reader?.cancel().catch(() => {});
      for (const waiter of pending.values()) waiter.reject(new Error("MCP connection closed"));
      pending.clear();
    }
    controller.signal.addEventListener("abort", () => {
      endpointFailed(new Error("MCP connection interrupted or timed out"));
      for (const waiter of pending.values()) waiter.reject(new Error("MCP connection interrupted or timed out"));
      pending.clear();
    }, { once: true });
    async function request(url, method, body) {
      const headers = { ...config.headers, Accept: "application/json, text/event-stream" };
      if (body) headers["Content-Type"] = "application/json";
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      if (version) headers["MCP-Protocol-Version"] = version;
      const response = await fetchImpl(url, { method, headers, body: body && JSON.stringify(body),
        signal: controller.signal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error([401, 403].includes(response.status)
          ? "MCP authentication failed; repair authorization on the phone and synchronize again"
          : `MCP HTTP ${response.status}; check the server and retry`);
      }
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      return response;
    }
    async function stream(response, onEvent) {
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
            let type = "message"; const data = [];
            for (const line of event.split(/\r?\n/)) {
              if (line.startsWith("event:")) type = line.slice(6).trim();
              if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (data.length && await onEvent(type, data.join("\n"))) return;
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    function result(message, id) {
      if (message?.id !== id) throw new Error("MCP response identity mismatch");
      if (message.error) throw new Error(`MCP protocol error ${message.error.code ?? "unknown"}; check server configuration and retry`);
      if (!("result" in message)) throw new Error("MCP response has no result");
      return message.result;
    }
    async function rpc(method, params, notification = false) {
      controller.signal.throwIfAborted();
      const id = randomUUID();
      const body = { jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params ? { params } : {}) };
      let waiting;
      if (config.transport === "sse" && !notification) {
        waiting = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        waiting.catch(() => {});
      }
      try {
        const response = await request(endpoint, "POST", body);
        if (notification) { await response.body?.cancel(); return; }
        if (config.transport === "sse") { await response.body?.cancel(); return result(await waiting, id); }
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          let found;
          await stream(response, async (_type, data) => {
            const message = JSON.parse(data);
            if (message.id === id) { found = message; return true; }
            return false;
          });
          return result(found, id);
        }
        return result(await response.json(), id);
      } finally { pending.delete(id); }
    }
    try {
      const url = new URL(config.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid MCP address");
      if (config.transport === "sse") {
        const response = await request(endpoint, "GET");
        stream(response, async (type, data) => {
          if (type === "endpoint") {
            const next = new URL(data, config.url);
            if (next.origin !== url.origin) throw new Error("MCP endpoint changed origin; update the registered address");
            endpoint = next.href; endpointReady();
          } else {
            const message = JSON.parse(data); pending.get(message.id)?.resolve(message);
          }
          return false;
        }).then(() => { throw new Error("MCP event stream closed"); }).catch(error => {
          endpointFailed(error);
          for (const waiter of pending.values()) waiter.reject(error);
          pending.clear(); controller.abort();
        });
        await ready;
      }
      const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {},
        clientInfo: { name: "aru-host", version: "1" } });
      version = init.protocolVersion;
      await rpc("notifications/initialized", undefined, true);
      return { rpc, close };
    } catch (error) { close(); throw error; }
  };
}
