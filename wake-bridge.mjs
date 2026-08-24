import { createHash, timingSafeEqual } from "node:crypto";

const REGISTRATION_SCHEMA = "aru.wake-bridge.registration.v1";
const STATUS_SCHEMA = "aru.wake-bridge.registration-status.v1";
const ENVELOPE_SCHEMA = "aru.wake-bridge.sealed-event.v1";
const INVENTORY_SCHEMA = "aru.wake-bridge.event-inventory.v1";
const ROUTE_SCHEMA = "aru.wake-bridge.event-route.v1";

export function createWakeBridge({
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  sendPush,
  credentialStore,
  topic = "cn.aelion.aru",
  now = Date.now,
  log = () => {},
}) {
  state.wakeBridgeEndpoints ??= [];
  state.wakeBridgeEvents ??= [];

  async function route(req, res, path) {
    if (path === "/aru/v1/wake-bridge/endpoints/current" && req.method === "PUT") {
      const body = await readJSONBody(req, 64 * 1024);
      const endpoint = register(body, bearer(req));
      sendJSON(res, 200, publicStatus(endpoint));
      return true;
    }
    if (path === "/aru/v1/wake-bridge/endpoints/current" && req.method === "DELETE") {
      const endpoint = endpointByFetchToken(bearer(req));
      state.wakeBridgeEndpoints = state.wakeBridgeEndpoints.filter(
        (item) => item.endpointId !== endpoint.endpointId,
      );
      state.wakeBridgeEvents = state.wakeBridgeEvents.filter(
        (event) => event.endpointId !== endpoint.endpointId,
      );
      saveState();
      sendJSON(res, 200, publicStatus(endpoint));
      return true;
    }
    const match = path.match(/^\/aru\/v1\/wake-bridge\/endpoints\/([^/]+)\/events(?:\/([^/]+)\/ack)?$/);
    if (!match) return false;
    const endpoint = endpointById(decodeURIComponent(match[1]));
    if (match[2]) {
      authorize(bearer(req), endpoint.fetchTokenHash);
      if (req.method !== "POST") return false;
      acknowledge(endpoint.endpointId, decodeURIComponent(match[2]));
      sendJSON(res, 200, publicStatus(endpoint));
      return true;
    }
    if (req.method === "POST") {
      authorize(bearer(req), endpoint.submitTokenHash);
      const { event: envelope, inserted } = admit(endpoint, await readJSONBody(req, 256 * 1024));
      sendJSON(res, 202, { schema: ENVELOPE_SCHEMA, eventId: envelope.eventId, accepted: true });
      if (inserted) void notify(endpoint, envelope);
      return true;
    }
    if (req.method === "GET") {
      authorize(bearer(req), endpoint.fetchTokenHash);
      sendJSON(res, 200, {
        schema: INVENTORY_SCHEMA,
        endpointId: endpoint.endpointId,
        events: state.wakeBridgeEvents
          .filter((event) => event.endpointId === endpoint.endpointId && !event.acknowledgedAt)
          .sort((a, b) => a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId))
          .slice(0, 32)
          .map(({ eventId, sealedPayload, createdAt }) => ({
            schema: ENVELOPE_SCHEMA, eventId, sealedPayload, createdAt,
          })),
      });
      return true;
    }
    return false;
  }

  function register(body, authorization) {
    if (body?.schema !== REGISTRATION_SCHEMA) {
      throw new HttpError(400, "wake.registration_schema_unsupported", "unsupported registration schema");
    }
    const endpointId = bounded(body.endpointId, "endpointId", 128);
    const existing = state.wakeBridgeEndpoints.find((item) => item.endpointId === endpointId);
    if (existing) authorize(authorization, existing.fetchTokenHash);
    const fetchToken = secret(body.fetchToken, "fetchToken");
    const submitToken = secret(body.submitToken, "submitToken");
    const value = {
      endpointId,
      fetchTokenHash: digest(fetchToken),
      submitTokenHash: digest(submitToken),
      encryptionKeyFingerprint: fingerprint(body.encryptionKeyFingerprint),
      deviceToken: deviceToken(body.deviceToken),
      environment: ["sandbox", "production"].includes(body.environment) ? body.environment : "",
      topic: body.topic === topic ? topic : "",
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      disabledAt: null,
      lastAttemptAt: existing?.lastAttemptAt ?? null,
      lastDeliveredAt: existing?.lastDeliveredAt ?? null,
      lastFailure: null,
    };
    if (!value.environment || !value.topic) {
      throw new HttpError(400, "wake.registration_invalid", "APNs environment or topic is invalid");
    }
    state.wakeBridgeEndpoints = state.wakeBridgeEndpoints.filter((item) => item.endpointId !== endpointId);
    state.wakeBridgeEndpoints.push(value);
    saveState();
    return value;
  }

  function admit(endpoint, body) {
    if (body?.schema !== ENVELOPE_SCHEMA) {
      throw new HttpError(400, "wake.event_schema_unsupported", "unsupported sealed event schema");
    }
    const eventId = bounded(body.eventId, "eventId", 128);
    const sealedPayload = bounded(body.sealedPayload, "sealedPayload", 192 * 1024);
    const existing = state.wakeBridgeEvents.find(
      (item) => item.endpointId === endpoint.endpointId && item.eventId === eventId,
    );
    if (existing) {
      if (existing.sealedPayload !== sealedPayload) {
        throw new HttpError(409, "wake.event_identity_conflict", "event id already owns another payload");
      }
      return { event: existing, inserted: false };
    }
    const recentCount = state.wakeBridgeEvents.filter(
      (item) => item.endpointId === endpoint.endpointId && item.createdAt >= now() - 60_000,
    ).length;
    if (recentCount >= 120) {
      throw new HttpError(429, "wake.event_rate_limited", "wake event rate limit exceeded");
    }
    const event = { endpointId: endpoint.endpointId, eventId, sealedPayload, createdAt: now(), acknowledgedAt: null };
    state.wakeBridgeEvents.push(event);
    pruneEvents();
    saveState();
    return { event, inserted: true };
  }

  function acknowledge(endpointId, eventId) {
    const event = state.wakeBridgeEvents.find(
      (item) => item.endpointId === endpointId && item.eventId === eventId,
    );
    if (event && !event.acknowledgedAt) {
      event.acknowledgedAt = now();
      saveState();
    }
  }

  async function notify(endpoint, event) {
    endpoint.lastAttemptAt = now();
    try {
      const credentials = credentialStore.read();
      if (!credentials) throw new Error("APNs provider credentials are unavailable");
      await sendPush({
        credentials,
        registration: endpoint,
        payload: {
          title: "Aru",
          body: "有一条外部消息在等你",
          threadId: `aru.wake.${endpoint.endpointId}`,
          route: { schema: ROUTE_SCHEMA, endpointId: endpoint.endpointId, eventId: event.eventId },
        },
      });
      endpoint.lastDeliveredAt = now();
      endpoint.lastFailure = null;
    } catch (error) {
      endpoint.lastFailure = String(error?.message ?? error).slice(0, 240);
      log(`wake bridge push failed for ${endpoint.endpointId}: ${endpoint.lastFailure}`);
    }
    saveState();
  }

  function endpointById(endpointId) {
    const value = state.wakeBridgeEndpoints.find((item) => item.endpointId === endpointId && !item.disabledAt);
    if (!value) throw new HttpError(404, "wake.endpoint_missing", "wake endpoint not found");
    return value;
  }

  function endpointByFetchToken(token) {
    const endpoint = state.wakeBridgeEndpoints.find((item) => {
      try { authorize(token, item.fetchTokenHash); return !item.disabledAt; } catch { return false; }
    });
    if (!endpoint) throw new HttpError(401, "wake.endpoint_unauthorized", "wake endpoint authorization failed");
    return endpoint;
  }

  function authorize(value, expectedHash) {
    const actual = Buffer.from(digest(value));
    const expected = Buffer.from(expectedHash);
    if (!value || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(401, "wake.endpoint_unauthorized", "wake endpoint authorization failed");
    }
  }

  function publicStatus(endpoint) {
    return {
      schema: STATUS_SCHEMA,
      endpointId: endpoint.endpointId,
      encryptionKeyFingerprint: endpoint.encryptionKeyFingerprint,
      providerConfigured: providerAvailable(),
      updatedAt: endpoint.updatedAt,
      lastAttemptAt: endpoint.lastAttemptAt,
      lastDeliveredAt: endpoint.lastDeliveredAt,
      lastFailure: endpoint.lastFailure,
    };
  }

  function providerAvailable() {
    try { return Boolean(credentialStore.read()); } catch { return false; }
  }

  function pruneEvents() {
    const cutoff = now() - 30 * 24 * 60 * 60 * 1000;
    state.wakeBridgeEvents = state.wakeBridgeEvents
      .filter((event) => !event.acknowledgedAt || event.acknowledgedAt >= cutoff)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10_000);
  }

  return { route, publicStatus };
}

function bearer(req) {
  const value = String(req.headers?.authorization ?? "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function digest(value) { return createHash("sha256").update(value).digest("base64url"); }
function secret(value, name) {
  const result = String(value ?? "");
  if (Buffer.byteLength(result) < 32 || Buffer.byteLength(result) > 256) throw invalid(`${name} is invalid`);
  return result;
}
function bounded(value, name, maximum) {
  const result = String(value ?? "").trim();
  if (!result || Buffer.byteLength(result) > maximum) throw invalid(`${name} is invalid`);
  return result;
}
function deviceToken(value) {
  const result = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{32,256}$/.test(result)) throw invalid("device token is invalid");
  return result;
}
function fingerprint(value) {
  const result = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(result)) throw invalid("encryption key fingerprint is invalid");
  return result;
}
function invalid(message) { const error = new Error(message); error.status = 400; return error; }
