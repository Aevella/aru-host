import { randomUUID } from "node:crypto";

const INVENTORY_SCHEMA = "aru.selfhost.provider-profile-inventory.v1";
const PROFILE_SCHEMA = "aru.selfhost.provider-profile.v1";
const PROTOCOLS = new Set(["openai-compatible", "anthropic-messages"]);
const AUTH_MODES = new Set(["bearer", "x-api-key", "none"]);

export function createProviderProfileHost({
  state,
  saveState,
  readJSONBody,
  sendJSON,
  HttpError,
  secretStore,
  testProfile,
  isProfileInUse = () => false,
  now = Date.now,
}) {
  state.providerProfiles ??= [];

  async function route(req, res, path, requireDevice, requireLocalHostConsole) {
    if (path === "/aru/v1/provider-profiles") {
      if (req.method === "GET") {
        requireDevice();
        sendJSON(res, 200, inventory());
        return true;
      }
      if (req.method === "POST") {
        requireLocalHostConsole();
        const body = await readJSONBody(req, 64 * 1024);
        sendJSON(res, 201, await createProfile(body));
        return true;
      }
      return false;
    }
    const match = path.match(/^\/aru\/v1\/provider-profiles\/(provider_[A-Fa-f0-9-]+)(\/test)?$/);
    if (!match) return false;
    if (match[2] === "/test" && req.method === "POST") requireLocalHostConsole();
    else if (!match[2] && req.method === "GET") requireDevice();
    else if (!match[2] && (req.method === "PUT" || req.method === "DELETE")) requireLocalHostConsole();
    else return false;
    const profile = storedProfileForId(match[1]);
    if (match[2] === "/test" && req.method === "POST") {
      sendJSON(res, 200, await checkProfile(profile));
      return true;
    }
    if (match[2]) return false;
    if (req.method === "GET") {
      sendJSON(res, 200, publicProfile(profile));
      return true;
    }
    if (req.method === "PUT") {
      const body = await readJSONBody(req, 64 * 1024);
      sendJSON(res, 200, await updateProfile(profile, body));
      return true;
    }
    if (req.method === "DELETE") {
      if (isProfileInUse(profile.profileId)) {
        throw new HttpError(409, "provider_profile.in_use", "先把使用这个 API 配置的电脑协作者换到别的驱动");
      }
      requireSecretStorage();
      secretStore.remove(profile.profileId);
      state.providerProfiles = state.providerProfiles.filter((item) => item.profileId !== profile.profileId);
      saveState();
      sendJSON(res, 200, { schema: PROFILE_SCHEMA, profileId: profile.profileId, deleted: true });
      return true;
    }
    return false;
  }

  function inventory() {
    return {
      schema: INVENTORY_SCHEMA,
      secretStorage: secretStore.availability(),
      profiles: state.providerProfiles.map(publicProfile),
    };
  }

  async function createProfile(body) {
    requireSecretStorage();
    const timestamp = now();
    const profile = normalizedProfile({
      profileId: `provider_${randomUUID()}`,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      health: "unchecked",
      lastCheckedAt: null,
      lastError: null,
    }, body);
    if (profile.authMode !== "none") secretStore.write(profile.profileId, body.apiKey);
    state.providerProfiles.push(profile);
    saveState();
    return checkProfile(profile);
  }

  async function updateProfile(profile, body) {
    requireRevision(profile, body.expectedRevision);
    normalizedProfile(profile, body);
    if (profile.authMode === "none") {
      requireSecretStorage();
      secretStore.remove(profile.profileId);
    } else if (body.apiKey !== undefined && body.apiKey !== "") {
      requireSecretStorage();
      secretStore.write(profile.profileId, body.apiKey);
    }
    profile.revision += 1;
    profile.updatedAt = now();
    profile.health = "unchecked";
    profile.lastError = null;
    saveState();
    return checkProfile(profile);
  }

  async function checkProfile(profile) {
    try {
      await testProfile(profile.profileId);
      profile.health = "ready";
      profile.lastError = null;
    } catch (error) {
      profile.health = "unhealthy";
      profile.lastError = publicFailure(error);
    }
    profile.lastCheckedAt = now();
    saveState();
    return publicProfile(profile);
  }

  function profileForId(profileId) {
    const profile = storedProfileForId(profileId);
    return { ...profile, hasSecret: hasSecret(profileId) };
  }

  function publicProfile(profile) {
    const { hasSecret: _, ...metadata } = profile;
    return {
      schema: PROFILE_SCHEMA,
      ...metadata,
      maxToolRounds: profile.maxToolRounds ?? null,
      hasSecret: hasSecret(profile.profileId),
    };
  }

  return { route, inventory, profileForId };

  function storedProfileForId(profileId) {
    const profile = state.providerProfiles.find((item) => item.profileId === profileId);
    if (!profile) throw new HttpError(404, "provider_profile.unknown", "unknown provider profile");
    return profile;
  }

  function normalizedProfile(profile, body) {
    profile.displayName = shortText(body.displayName, "displayName", 80);
    profile.protocol = protocol(body.protocol);
    profile.baseURL = baseURL(body.baseURL);
    profile.path = apiPath(body.path, profile.protocol, profile.baseURL);
    profile.model = shortText(body.model, "model", 160);
    profile.authMode = authMode(body.authMode, profile.protocol);
    profile.maxOutputTokens = outputBudget(
      body.maxOutputTokens,
      profile.protocol,
      profile.maxOutputTokens,
    );
    profile.maxToolRounds = toolRoundBudget(body.maxToolRounds);
    return profile;
  }

  function requireRevision(profile, value) {
    if (!Number.isSafeInteger(value)) {
      throw new HttpError(400, "provider_profile.expected_revision_required", "expectedRevision required");
    }
    if (value !== profile.revision) {
      throw new HttpError(409, "provider_profile.revision_conflict", "API 配置已经在别处发生变化，请刷新后再保存");
    }
  }

  function shortText(value, name, maximum) {
    const text = String(value ?? "").trim();
    if (!text) throw new HttpError(400, `provider_profile.${name}_required`, `${name} required`);
    if ([...text].length > maximum) throw new HttpError(400, `provider_profile.${name}_too_long`, `${name} is too long`);
    return text;
  }

  function protocol(value) {
    const text = String(value ?? "").trim();
    if (!PROTOCOLS.has(text)) throw new HttpError(400, "provider_profile.protocol_invalid", "unsupported provider protocol");
    return text;
  }

  function authMode(value, providerProtocol) {
    const fallback = providerProtocol === "anthropic-messages" ? "x-api-key" : "bearer";
    const text = String(value ?? fallback).trim();
    if (!AUTH_MODES.has(text)) throw new HttpError(400, "provider_profile.auth_mode_invalid", "unsupported auth mode");
    return text;
  }

  function baseURL(value) {
    const text = shortText(value, "baseURL", 2048);
    let url;
    try { url = new URL(text); }
    catch { throw new HttpError(400, "provider_profile.base_url_invalid", "baseURL must be a valid URL"); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
      throw new HttpError(400, "provider_profile.base_url_insecure", "远程模型 API 必须使用 HTTPS；只有本机地址可以使用 HTTP");
    }
    if (url.username || url.password) {
      throw new HttpError(400, "provider_profile.base_url_credentials", "baseURL 不能包含用户名或密码");
    }
    return url.href;
  }

  function outputBudget(value, providerProtocol, existing) {
    if (providerProtocol !== "anthropic-messages") return null;
    const candidate = value ?? existing ?? 16_384;
    if (!Number.isSafeInteger(candidate) || candidate < 1) {
      throw new HttpError(
        400,
        "provider_profile.max_output_tokens_invalid",
        "Anthropic maxOutputTokens must be a positive integer",
      );
    }
    return candidate;
  }

  function toolRoundBudget(value) {
    const candidate = value ?? null;
    if (candidate === null || candidate === "") return null;
    if (!Number.isSafeInteger(candidate) || candidate < 1) {
      throw new HttpError(
        400,
        "provider_profile.max_tool_rounds_invalid",
        "maxToolRounds must be a positive integer or null",
      );
    }
    return candidate;
  }

  function apiPath(value, providerProtocol, providerBaseURL) {
    const fallback = providerProtocol === "anthropic-messages" ? "v1/messages" : "v1/chat/completions";
    const text = String(value ?? fallback).trim().replace(/^\/+/, "");
    if (!text || text.includes("..") || /[?#]/.test(text)) {
      throw new HttpError(400, "provider_profile.path_invalid", "path must be a safe relative API path");
    }
    const base = new URL(providerBaseURL.endsWith("/") ? providerBaseURL : `${providerBaseURL}/`);
    const endpoint = new URL(text, base);
    if (endpoint.origin !== base.origin) {
      throw new HttpError(400, "provider_profile.path_cross_origin", "path 必须留在 baseURL 的同一个来源内");
    }
    return text;
  }

  function hasSecret(profileId) {
    if (!secretStore.availability().supported) return false;
    return Boolean(secretStore.read(profileId));
  }

  function requireSecretStorage() {
    const availability = secretStore.availability();
    if (!availability.supported) {
      throw new HttpError(
        409,
        "provider_profile.secret_storage_unavailable",
        "这台 Host 没有可用的安全密钥存储，暂时不能保存模型 API 配置",
      );
    }
  }
}

function publicFailure(error) {
  return String(error?.message ?? "连接模型 API 失败").trim() || "连接模型 API 失败";
}
