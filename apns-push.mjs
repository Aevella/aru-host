import { spawnSync } from "node:child_process";
import {
  createPrivateKey,
  createHash,
  sign,
} from "node:crypto";
import { connect as connectHTTP2, constants as http2Constants } from "node:http2";

const REGISTRATION_SCHEMA = "aru.selfhost.remote-push-registration.v1";
const STATUS_SCHEMA = "aru.selfhost.remote-push-status.v1";
const DEFAULT_TOPIC = "cn.aelion.aru";
const DEFAULT_SERVICE = "cn.aelion.aru.host-apns.v1";
const DEFAULT_ACCOUNT = "apns-provider";
const APNS_ENVIRONMENTS = new Set(["sandbox", "production"]);

export function createAPNsPushHost({
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  serverId,
  credentialStore = createAPNsCredentialStore(),
  sendPush = sendAPNsNotification,
  topic = DEFAULT_TOPIC,
  log = () => {},
  now = Date.now,
}) {
  state.remotePushRegistrations ??= [];
  normalizeRegistrations();

  async function route(req, res, path, requireDevice) {
    if (path !== "/aru/v1/push-devices/current") return false;
    const device = requireDevice();
    if (req.method === "GET") {
      sendJSON(res, 200, publicStatus(device.deviceId));
      return true;
    }
    if (req.method === "PUT") {
      const body = await readJSONBody(req, 64 * 1024);
      try {
        register(device, body);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "push.registration_invalid", "push registration is invalid");
      }
      sendJSON(res, 200, publicStatus(device.deviceId));
      return true;
    }
    if (req.method === "DELETE") {
      unregister(device.deviceId);
      sendJSON(res, 200, publicStatus(device.deviceId));
      return true;
    }
    return false;
  }

  function register(device, body) {
    if (body?.schema !== REGISTRATION_SCHEMA) {
      throw new HttpError(400, "push.registration_schema_unsupported", "unsupported push registration schema");
    }
    const deviceToken = validatedDeviceToken(body.deviceToken);
    const environment = validatedEnvironment(body.environment);
    if (body.topic !== topic) {
      throw new HttpError(400, "push.topic_unsupported", "push topic does not match this Aru build");
    }
    const timestamp = now();
    const current = state.remotePushRegistrations.find(
      (item) => item.deviceId === device.deviceId
        && item.environment === environment
        && item.topic === topic,
    );
    if (current) {
      current.deviceToken = deviceToken;
      current.updatedAt = timestamp;
      current.disabledAt = null;
      current.lastFailure = null;
    } else {
      state.remotePushRegistrations.push({
        schema: REGISTRATION_SCHEMA,
        deviceId: device.deviceId,
        deviceToken,
        environment,
        topic,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastAttemptAt: null,
        lastDeliveredAt: null,
        lastFailure: null,
        disabledAt: null,
      });
    }
    saveState();
  }

  function unregister(deviceId) {
    const before = state.remotePushRegistrations.length;
    state.remotePushRegistrations = state.remotePushRegistrations.filter(
      (item) => item.deviceId !== deviceId,
    );
    if (state.remotePushRegistrations.length !== before) saveState();
  }

  function publicStatus(deviceId) {
    const registrations = activeRegistrations().filter((item) => item.deviceId === deviceId);
    return {
      schema: STATUS_SCHEMA,
      serverId,
      topic,
      credentialStorage: credentialStore.availability(),
      providerConfigured: providerConfigured(),
      registrations: registrations.map((item) => ({
        environment: item.environment,
        topic: item.topic,
        tokenFingerprint: tokenFingerprint(item.deviceToken),
        updatedAt: item.updatedAt,
        lastAttemptAt: item.lastAttemptAt,
        lastDeliveredAt: item.lastDeliveredAt,
        lastFailure: item.lastFailure,
      })),
    };
  }

  async function deliverHostedCollaboratorTurn(event) {
    if (event?.outcome !== "completed" || event?.turn?.source !== "proactive") return;
    const body = String(event.assistantMessage?.content ?? "").trim();
    if (!body) return;
    const registrations = activeRegistrations();
    if (registrations.length === 0) return;
    let credentials;
    try {
      credentials = credentialStore.read();
    } catch (error) {
      log(`remote push skipped: ${safePushFailure(error)}`);
      return;
    }
    if (!credentials) {
      log("remote push skipped: APNs provider credentials are unavailable");
      return;
    }
    const payload = {
      title: event.collaborator.displayName,
      body,
      threadId: `aru.host.${event.collaborator.collaboratorId}`,
      route: {
        schema: "aru.remote-notification-route.v1",
        serverId,
        collaboratorId: event.collaborator.collaboratorId,
        conversationId: event.conversation.conversationId,
        messageId: event.assistantMessage.messageId,
      },
    };
    await Promise.all(registrations.map(async (registration) => {
      registration.lastAttemptAt = now();
      try {
        await sendPush({ credentials, registration, payload });
        registration.lastDeliveredAt = now();
        registration.lastFailure = null;
      } catch (error) {
        registration.lastFailure = safePushFailure(error);
        if (invalidatesDeviceToken(error)) registration.disabledAt = now();
        log(`remote push failed for ${registration.deviceId}: ${registration.lastFailure}`);
      }
    }));
    saveState();
  }

  function activeRegistrations() {
    const activeDevices = new Set(
      state.devices.filter((device) => !device.revokedAt).map((device) => device.deviceId),
    );
    return state.remotePushRegistrations.filter(
      (item) => !item.disabledAt && activeDevices.has(item.deviceId),
    );
  }

  function normalizeRegistrations() {
    state.remotePushRegistrations = state.remotePushRegistrations.filter((item) => {
      try {
        item.schema = REGISTRATION_SCHEMA;
        item.deviceToken = validatedDeviceToken(item.deviceToken);
        item.environment = validatedEnvironment(item.environment);
        item.topic = item.topic === topic ? topic : "";
        item.createdAt = safeTimestamp(item.createdAt, now());
        item.updatedAt = safeTimestamp(item.updatedAt, item.createdAt);
        item.lastAttemptAt = optionalTimestamp(item.lastAttemptAt);
        item.lastDeliveredAt = optionalTimestamp(item.lastDeliveredAt);
        item.lastFailure = typeof item.lastFailure === "string" ? item.lastFailure : null;
        item.disabledAt = optionalTimestamp(item.disabledAt);
        return Boolean(item.topic && item.deviceId);
      } catch {
        return false;
      }
    });
  }

  function providerConfigured() {
    try {
      return credentialStore.read() !== null;
    } catch (error) {
      log(`remote push credential status unavailable: ${safePushFailure(error)}`);
      return false;
    }
  }

  return {
    route,
    deliverHostedCollaboratorTurn,
    publicStatus,
    manifestCapability() {
      return {
        enabled: true,
        endpoint: "/aru/v1/push-devices/current",
        topic,
        transport: "apns-http2-token",
        registration: "paired-device-owned",
        providerConfigured: providerConfigured(),
      };
    },
  };
}

export function createAPNsCredentialStore({
  platform = process.platform,
  service = DEFAULT_SERVICE,
  account = DEFAULT_ACCOUNT,
  run = spawnSync,
} = {}) {
  let cachedAvailability;

  function availability() {
    if (cachedAvailability) return cachedAvailability;
    if (platform === "darwin") {
      const result = run("/usr/bin/security", ["help"], {
        encoding: "utf8", timeout: 3_000, windowsHide: true,
      });
      cachedAvailability = result.error?.code === "ENOENT"
        ? { supported: false, storage: "unavailable" }
        : { supported: true, storage: "macos-keychain" };
      return cachedAvailability;
    }
    if (platform === "linux") {
      const result = run("/usr/bin/secret-tool", ["--version"], {
        encoding: "utf8", timeout: 3_000, windowsHide: true,
      });
      cachedAvailability = result.error?.code === "ENOENT" || result.status !== 0
        ? { supported: false, storage: "unavailable" }
        : { supported: true, storage: "linux-secret-service" };
      return cachedAvailability;
    }
    cachedAvailability = { supported: false, storage: "unavailable" };
    return cachedAvailability;
  }

  function read() {
    if (!availability().supported) return null;
    const result = platform === "darwin"
      ? run("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
        encoding: "utf8", timeout: 5_000, windowsHide: true,
      })
      : run("/usr/bin/secret-tool", ["lookup", "service", service, "account", account], {
        encoding: "utf8", timeout: 5_000, windowsHide: true,
      });
    if (result.status === 44 || result.status === 1 || /could not be found/i.test(result.stderr ?? "")) {
      return null;
    }
    if (result.status !== 0) throw new Error("无法从系统安全凭据存储读取 APNs provider key");
    try {
      const stored = String(result.stdout ?? "").trim();
      const encoded = stored.startsWith("aru-apns-v1:")
        ? stored.slice("aru-apns-v1:".length)
        : null;
      if (!encoded) throw new Error("unsupported credential encoding");
      return validatedCredentials(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    } catch {
      throw new Error("系统安全凭据存储中的 APNs provider key 无法解码");
    }
  }

  return { availability, read };
}

export async function sendAPNsNotification({ credentials, registration, payload }) {
  const host = registration.environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  const token = makeProviderToken(credentials);
  const body = encodedPayload(payload);
  const response = await postHTTP2(host, {
    [http2Constants.HTTP2_HEADER_METHOD]: "POST",
    [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${registration.deviceToken}`,
    authorization: `bearer ${token}`,
    "apns-topic": registration.topic,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": "0",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  }, body);
  if (response.status === 200) return;
  let reason = "APNs request failed";
  try { reason = JSON.parse(response.body).reason ?? reason; } catch {}
  throw new APNsResponseError(response.status, reason);
}

class APNsResponseError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function makeProviderToken(credentials, issuedAt = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: credentials.keyId }));
  const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: issuedAt }));
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(credentials.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function encodedPayload(payload) {
  const route = payload.route;
  let body = String(payload.body ?? "").trim();
  while (body.length > 64) {
    const value = JSON.stringify({
      aps: {
        alert: { title: payload.title, body },
        sound: "default",
        "thread-id": payload.threadId,
      },
      aru: route,
    });
    if (Buffer.byteLength(value) <= 4_096) return value;
    body = `${[...body].slice(0, Math.floor([...body].length * 0.82)).join("")}…`;
  }
  return JSON.stringify({
    aps: { alert: { title: payload.title, body }, sound: "default", "thread-id": payload.threadId },
    aru: route,
  });
}

function postHTTP2(origin, headers, body) {
  return new Promise((resolve, reject) => {
    const client = connectHTTP2(origin);
    client.once("error", reject);
    const request = client.request(headers);
    let status = 0;
    let responseBody = "";
    request.setEncoding("utf8");
    request.on("response", (value) => { status = Number(value[":status"] ?? 0); });
    request.on("data", (chunk) => { responseBody += chunk; });
    request.on("end", () => {
      client.close();
      resolve({ status, body: responseBody });
    });
    request.once("error", (error) => {
      client.close();
      reject(error);
    });
    request.end(body);
  });
}

function validatedCredentials(value) {
  const teamId = String(value?.teamId ?? "").trim();
  const keyId = String(value?.keyId ?? "").trim();
  const privateKey = String(value?.privateKey ?? "").trim();
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("APNs team id is invalid");
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("APNs key id is invalid");
  if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(privateKey)) {
    throw new Error("APNs private key is invalid");
  }
  createPrivateKey(privateKey);
  return { teamId, keyId, privateKey };
}

function validatedDeviceToken(value) {
  const token = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]+$/.test(token) || token.length < 32 || token.length > 512 || token.length % 2 !== 0) {
    throw new Error("APNs device token is invalid");
  }
  return token;
}

function validatedEnvironment(value) {
  const environment = String(value ?? "");
  if (!APNS_ENVIRONMENTS.has(environment)) throw new Error("APNs environment is invalid");
  return environment;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function tokenFingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function invalidatesDeviceToken(error) {
  return error?.status === 410
    || ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(error?.reason);
}

function safePushFailure(error) {
  const reason = String(error?.reason ?? error?.message ?? "APNs delivery failed");
  return reason.replace(/[\r\n\u0000]/g, " ").slice(0, 240);
}

function safeTimestamp(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function optionalTimestamp(value) {
  return value === null || value === undefined ? null : safeTimestamp(value, null);
}
