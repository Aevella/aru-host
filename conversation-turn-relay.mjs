import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const TURN_SCHEMA = "aru.selfhost.conversation-turn.v1";
const ACTIVE_STATES = new Set(["accepted", "running"]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "interrupted", "cancelled"]);

export function createConversationTurnRelay({
  dataDir,
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  maximumRequestBytes,
  log,
  onTurnUpdated = async () => {},
}) {
  const resultDirectory = join(dataDir, "conversation-turns");
  mkdirSync(resultDirectory, { recursive: true });
  for (const name of readdirSync(resultDirectory)) {
    if (name.endsWith(".tmp")) rmSync(join(resultDirectory, name), { force: true });
  }
  state.conversationTurns ??= [];
  const controllers = new Map();

  for (const turn of state.conversationTurns) {
    if (!ACTIVE_STATES.has(turn.state)) continue;
    turn.state = "interrupted";
    turn.completedAt = Date.now();
    turn.failureCode = "conversation_turn.host_restarted";
    turn.failureMessage = "Host restarted after accepting the provider request; the request was not replayed.";
  }
  saveState();

  async function route(req, res, path, requireDevice) {
    if (path === "/aru/v1/conversation-turns" && req.method === "POST") {
      await submit(req, res, requireDevice(req));
      return true;
    }
    if (path === "/aru/v1/conversation-turns" && req.method === "GET") {
      const device = requireDevice(req);
      sendJSON(res, 200, inventory(device));
      return true;
    }
    const match = /^\/aru\/v1\/conversation-turns\/([^/]+)(?:\/(cancel|acknowledge))?$/.exec(path);
    if (!match) return false;
    const device = requireDevice(req);
    const turnId = decodeURIComponent(match[1]);
    if (req.method === "GET" && !match[2]) {
      status(res, turnId, device);
      return true;
    }
    if (req.method === "POST" && match[2] === "cancel") {
      cancel(res, turnId, device);
      return true;
    }
    if (req.method === "POST" && match[2] === "acknowledge") {
      acknowledge(res, turnId, device);
      return true;
    }
    return false;
  }

  async function submit(req, res, device) {
    const body = await readJSONBody(req, maximumRequestBytes);
    let clientTurnId;
    let conversationId;
    let protocolId;
    let endpoint;
    let headers;
    let providerBody;
    try {
      clientTurnId = requiredText(body.clientTurnId, "clientTurnId");
      conversationId = requiredText(body.conversationId, "conversationId");
      protocolId = requiredProtocol(body.protocolId);
      endpoint = validatedProviderEndpoint(body.request?.endpoint);
      headers = validatedHeaders(body.request?.headers);
      providerBody = decodedBody(body.request?.bodyBase64);
    } catch (error) {
      throw new HttpError(400, "conversation_turn.invalid_request", String(error?.message ?? error));
    }
    const existing = state.conversationTurns.find((candidate) =>
      candidate.deviceId === device.deviceId && candidate.clientTurnId === clientTurnId);
    if (existing) {
      return sendJSON(res, 200, publicTurn(existing, { includeResult: true }));
    }

    const now = Date.now();
    const turn = {
      schema: TURN_SCHEMA,
      turnId: `turn_${randomUUID()}`,
      clientTurnId,
      conversationId,
      protocolId,
      providerHost: endpoint.host,
      deviceId: device.deviceId,
      state: "accepted",
      providerStatus: null,
      providerContentType: null,
      resultFilename: null,
      failureCode: null,
      failureMessage: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
    state.conversationTurns.push(turn);
    saveState();
    sendJSON(res, 202, publicTurn(turn));
    await notifyTurnUpdated(turn);
    setImmediate(() => execute(turn, endpoint, headers, providerBody));
    return true;
  }

  async function execute(turn, endpoint, headers, body) {
    const controller = new AbortController();
    let temporaryPath = null;
    controllers.set(turn.turnId, controller);
    turn.state = "running";
    turn.startedAt = Date.now();
    turn.updatedAt = turn.startedAt;
    saveState();
    await notifyTurnUpdated(turn);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: controller.signal,
      });
      const filename = `${turn.turnId}.response`;
      const finalPath = join(resultDirectory, filename);
      temporaryPath = `${finalPath}.${process.pid}.tmp`;
      const temporaryFilename = `${filename}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, Buffer.alloc(0), { mode: 0o600 });
      turn.providerStatus = response.status;
      turn.providerContentType = response.headers.get("content-type") ?? "application/octet-stream";
      turn.resultFilename = temporaryFilename;
      turn.updatedAt = Date.now();
      saveState();
      await notifyTurnUpdated(turn);
      if (response.body) {
        for await (const chunk of response.body) {
          if (!chunk?.byteLength) continue;
          appendFileSync(temporaryPath, Buffer.from(chunk));
          turn.updatedAt = Date.now();
        }
      } else {
        appendFileSync(temporaryPath, Buffer.from(await response.arrayBuffer()));
      }
      renameSync(temporaryPath, finalPath);
      turn.resultFilename = filename;
      turn.state = response.ok ? "succeeded" : "failed";
      if (!response.ok) {
        turn.failureCode = "conversation_turn.provider_http_error";
        turn.failureMessage = providerFailureMessage(finalPath, response.status);
      }
      turn.completedAt = Date.now();
      turn.updatedAt = turn.completedAt;
      saveState();
      await notifyTurnUpdated(turn);
      log(`conversation turn ${turn.turnId} ${turn.state} via ${turn.providerHost}`);
    } catch {
      turn.state = controller.signal.aborted ? "cancelled" : "failed";
      turn.failureCode = controller.signal.aborted
        ? "conversation_turn.cancelled"
        : "conversation_turn.transport_failed";
      turn.failureMessage = controller.signal.aborted
        ? "The remote turn was cancelled explicitly."
        : "Host could not complete the provider request.";
      turn.completedAt = Date.now();
      turn.updatedAt = turn.completedAt;
      saveState();
      await notifyTurnUpdated(turn);
      log(`conversation turn ${turn.turnId} ${turn.state}: ${turn.failureMessage}`);
    } finally {
      if (temporaryPath) rmSync(temporaryPath, { force: true });
      controllers.delete(turn.turnId);
    }
  }

  function inventory(device) {
    return {
      schema: "aru.selfhost.conversation-turn-inventory.v1",
      turns: state.conversationTurns
        .filter((turn) => turn.deviceId === device.deviceId)
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((turn) => publicTurn(turn)),
    };
  }

  function status(res, turnId, device) {
    const turn = ownedTurn(turnId, device);
    return sendJSON(res, 200, publicTurn(turn, { includeResult: true }));
  }

  function cancel(res, turnId, device) {
    const turn = ownedTurn(turnId, device);
    if (TERMINAL_STATES.has(turn.state)) {
      return sendJSON(res, 200, publicTurn(turn, { includeResult: true }));
    }
    controllers.get(turn.turnId)?.abort();
    if (turn.state === "accepted") {
      turn.state = "cancelled";
      turn.failureCode = "conversation_turn.cancelled";
      turn.failureMessage = "The remote turn was cancelled explicitly.";
      turn.completedAt = Date.now();
      turn.updatedAt = turn.completedAt;
      saveState();
      void notifyTurnUpdated(turn);
    }
    return sendJSON(res, 200, publicTurn(turn));
  }

  function acknowledge(res, turnId, device) {
    const turn = ownedTurn(turnId, device);
    if (!TERMINAL_STATES.has(turn.state)) {
      throw new HttpError(409, "conversation_turn.still_running", "cannot acknowledge a running turn");
    }
    purge(turn.turnId);
    turn.resultFilename = null;
    turn.acknowledgedAt = turn.acknowledgedAt ?? Date.now();
    turn.updatedAt = turn.acknowledgedAt;
    saveState();
    sendJSON(res, 200, publicTurn(turn));
  }

  function ownedTurn(turnId, device) {
    const turn = state.conversationTurns.find((candidate) =>
      candidate.turnId === turnId && candidate.deviceId === device.deviceId);
    if (!turn) throw new HttpError(404, "conversation_turn.unknown", "unknown conversation turn");
    return turn;
  }

  function publicTurn(turn, { includeResult = false } = {}) {
    const value = {
      schema: turn.schema,
      turnId: turn.turnId,
      clientTurnId: turn.clientTurnId,
      conversationId: turn.conversationId,
      protocolId: turn.protocolId,
      state: turn.state,
      providerStatus: turn.providerStatus,
      providerContentType: turn.providerContentType,
      failureCode: turn.failureCode,
      failureMessage: turn.failureMessage,
      createdAt: turn.createdAt,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      updatedAt: turn.updatedAt,
      acknowledgedAt: turn.acknowledgedAt ?? null,
    };
    if (includeResult && turn.resultFilename) {
      const path = join(resultDirectory, turn.resultFilename);
      if (existsSync(path)) {
        const result = readFileSync(path);
        value.resultByteCount = result.byteLength;
        if (result.byteLength > 0) value.resultBase64 = result.toString("base64");
      }
    }
    return value;
  }

  function diagnosticsCapability() {
    return {
      id: "conversation-turn-relay",
      enabled: true,
      activeTurnCount: state.conversationTurns.filter((turn) => ACTIVE_STATES.has(turn.state)).length,
      retainedTurnCount: state.conversationTurns.length,
    };
  }

  function purge(turnId) {
    const turn = state.conversationTurns.find((candidate) => candidate.turnId === turnId);
    if (!turn) return;
    if (turn.resultFilename) rmSync(join(resultDirectory, turn.resultFilename), { force: true });
  }

  async function notifyTurnUpdated(turn) {
    try {
      await onTurnUpdated(turn);
    } catch (error) {
      log(`conversation turn activity update failed: ${String(error?.message ?? error)}`);
    }
  }

  return { route, diagnosticsCapability, purge };
}

function providerFailureMessage(resultPath, status) {
  const fallback = `Provider returned HTTP ${status}.`;
  try {
    const value = JSON.parse(readFileSync(resultPath, "utf8"));
    const detail = [value?.error?.message, value?.error, value?.message]
      .find((candidate) => typeof candidate === "string" && candidate.trim());
    if (!detail) return fallback;
    const safe = detail
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    return safe ? `Provider returned HTTP ${status}: ${safe}` : fallback;
  } catch {
    return fallback;
  }
}

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requiredProtocol(value) {
  if (value !== "openai-compatible" && value !== "anthropic-messages") {
    throw new Error("protocolId is unsupported");
  }
  return value;
}

function validatedProviderEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(requiredText(value, "request.endpoint")); }
  catch { throw new Error("request.endpoint is invalid"); }
  if (endpoint.protocol !== "https:") throw new Error("provider endpoint must use HTTPS");
  const host = endpoint.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local")) {
    throw new Error("provider endpoint cannot target the local host");
  }
  return endpoint;
}

function validatedHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request.headers must be an object");
  }
  const headers = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") throw new Error("request header values must be strings");
    const normalized = key.toLowerCase();
    if (["host", "content-length", "connection", "transfer-encoding"].includes(normalized)) continue;
    headers[key] = headerValue;
  }
  return headers;
}

function decodedBody(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("request.bodyBase64 is required");
  }
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("request.bodyBase64 must be canonical Base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("request.bodyBase64 must be canonical Base64");
  }
  return decoded;
}
