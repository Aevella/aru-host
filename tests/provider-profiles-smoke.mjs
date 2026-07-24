#!/usr/bin/env node
import assert from "node:assert/strict";
import { createProviderProfileHost } from "../provider-profiles.mjs";
import { createProviderSecretStore } from "../provider-secret-store.mjs";

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const state = {};
const secrets = new Map();
const secretStore = {
  availability: () => ({ supported: true, storage: "test", failure: null }),
  read: (id) => secrets.get(id) ?? null,
  write: (id, value) => secrets.set(id, value),
  remove: (id) => secrets.delete(id),
};
let clock = 100;
let saves = 0;
let profileHost;
profileHost = createProviderProfileHost({
  state,
  saveState: () => { saves += 1; },
  readJSONBody: async (req) => req.body,
  sendJSON(res, status, body) { res.status = status; res.body = body; },
  HttpError,
  secretStore,
  testProfile: async (profileId) => {
    const profile = state.providerProfiles.find((item) => item.profileId === profileId);
    assert.equal(secretStore.read(profileId), profile.authMode === "none" ? null : "key-one");
  },
  now: () => ++clock,
});

await assert.rejects(
  () => call("POST", "/aru/v1/provider-profiles", {
    displayName: "Escaping route",
    protocol: "openai-compatible",
    baseURL: "https://api.example.test",
    path: "http://169.254.169.254/latest/meta-data/",
    model: "model-one",
    authMode: "bearer",
    apiKey: "must-not-be-written",
  }),
  (error) => error instanceof HttpError && error.code === "provider_profile.path_cross_origin",
);
assert.equal(secrets.size, 0);

const created = await call("POST", "/aru/v1/provider-profiles", {
  displayName: "My OpenAI route",
  protocol: "openai-compatible",
  baseURL: "https://api.example.test",
  path: "/v1/chat/completions",
  model: "model-one",
  authMode: "bearer",
  maxToolRounds: null,
  apiKey: "key-one",
});
assert.equal(created.status, 201);
assert.equal(created.body.health, "ready");
assert.equal(created.body.hasSecret, true);
assert.equal(JSON.stringify(state).includes("key-one"), false);
assert.equal(JSON.stringify(created.body).includes("key-one"), false);
const profileId = created.body.profileId;

const inventory = await call("GET", "/aru/v1/provider-profiles");
assert.equal(inventory.body.profiles.length, 1);
assert.equal(inventory.body.profiles[0].baseURL, "https://api.example.test/");
assert.equal(inventory.body.profiles[0].path, "v1/chat/completions");
assert.equal(inventory.body.profiles[0].maxToolRounds, null);

const noAuth = await call("POST", "/aru/v1/provider-profiles", {
  displayName: "Local no-auth route",
  protocol: "openai-compatible",
  baseURL: "http://127.0.0.1:11434",
  path: "v1/chat/completions",
  model: "local-model",
  authMode: "none",
});
assert.equal(noAuth.body.health, "ready");
assert.equal(noAuth.body.hasSecret, false);
assert.equal(secretStore.read(noAuth.body.profileId), null);

await assert.rejects(
  () => call("PUT", `/aru/v1/provider-profiles/${profileId}`, {
    expectedRevision: created.body.revision,
    displayName: "Phone mutation",
    protocol: "openai-compatible",
    baseURL: "https://api.example.test",
    path: "v1/chat/completions",
    model: "model-one",
    authMode: "bearer",
    maxToolRounds: 2,
  }, "phone"),
  (error) => error instanceof HttpError && error.code === "credential.host_console_required",
);

const updated = await call("PUT", `/aru/v1/provider-profiles/${profileId}`, {
  expectedRevision: created.body.revision,
  displayName: "My route",
  protocol: "openai-compatible",
  baseURL: "http://127.0.0.1:11434",
  path: "v1/chat/completions",
  model: "local-model",
  authMode: "bearer",
  maxToolRounds: 7,
});
assert.equal(updated.body.health, "ready");
assert.equal(secretStore.read(profileId), "key-one");
assert.equal(updated.body.maxOutputTokens, null);
assert.equal(updated.body.maxToolRounds, 7);

const anthropic = await call("PUT", `/aru/v1/provider-profiles/${profileId}`, {
  expectedRevision: updated.body.revision,
  displayName: "My Anthropic route",
  protocol: "anthropic-messages",
  baseURL: "https://api.anthropic.com",
  path: "v1/messages",
  model: "claude-test",
  authMode: "x-api-key",
  maxOutputTokens: 32_768,
});
assert.equal(anthropic.body.maxOutputTokens, 32_768);
assert.equal(anthropic.body.maxToolRounds, null);
assert.ok(saves >= 4);

let availabilityProbeCount = 0;
const cachedAvailabilityStore = createProviderSecretStore({
  platform: "darwin",
  run: () => {
    availabilityProbeCount += 1;
    return { status: 0, stdout: "", stderr: "" };
  },
});
assert.equal(cachedAvailabilityStore.availability().supported, true);
assert.equal(cachedAvailabilityStore.availability().supported, true);
assert.equal(availabilityProbeCount, 1);

const linuxSecretCalls = [];
const linuxSecretStore = createProviderSecretStore({
  platform: "linux",
  run: (command, args, options) => {
    linuxSecretCalls.push({ command, args, input: options?.input });
    if (args[0] === "--version") return { status: 0, stdout: "secret-tool 0.20", stderr: "" };
    if (args[0] === "lookup") return { status: 0, stdout: "linux-key\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  },
});
assert.deepEqual(linuxSecretStore.availability(), {
  supported: true,
  storage: "linux-secret-service",
  failure: null,
});
assert.equal(linuxSecretStore.read("provider_deadbeef"), "linux-key");
linuxSecretStore.write("provider_deadbeef", "new-linux-key");
linuxSecretStore.remove("provider_deadbeef");
assert.equal(linuxSecretCalls[0].command, "/usr/bin/secret-tool");
assert.deepEqual(linuxSecretCalls.map((call) => call.args[0]), ["--version", "lookup", "store", "clear"]);
assert.equal(linuxSecretCalls[2].input, "new-linux-key\n");

const unsupportedHost = createProviderProfileHost({
  state: {},
  saveState() {},
  readJSONBody: async (req) => req.body,
  sendJSON(res, status, body) { res.status = status; res.body = body; },
  HttpError,
  secretStore: {
    availability: () => ({ supported: false, storage: "unavailable", failure: "unsupported" }),
    read() { throw new Error("must not read"); },
    write() { throw new Error("must not write"); },
    remove() { throw new Error("must not remove"); },
  },
  testProfile: async () => { throw new Error("must not test"); },
});
await assert.rejects(
  async () => {
    const req = {
      method: "POST",
      body: {
        displayName: "Unsupported storage",
        protocol: "openai-compatible",
        baseURL: "https://api.example.test",
        path: "v1/chat/completions",
        model: "model-one",
        authMode: "bearer",
        apiKey: "must-not-be-written",
      },
    };
    await unsupportedHost.route(
      req,
      {},
      "/aru/v1/provider-profiles",
      () => ({ deviceId: "device_test" }),
      () => ({ deviceId: "device_test", deviceRole: "host-console" }),
    );
  },
  (error) => error instanceof HttpError
    && error.status === 409
    && error.code === "provider_profile.secret_storage_unavailable",
);
console.log("ARU_PROVIDER_PROFILES_SMOKE_OK");

async function call(method, path, body = undefined, authority = "console") {
  const req = { method, body };
  const res = {};
  const matched = await profileHost.route(
    req,
    res,
    path,
    () => ({ deviceId: "device_test", deviceRole: authority === "console" ? "host-console" : null }),
    () => {
      if (authority !== "console") {
        throw new HttpError(403, "credential.host_console_required", "host console required");
      }
      return { deviceId: "device_test", deviceRole: "host-console" };
    },
  );
  assert.equal(matched, true);
  return res;
}
