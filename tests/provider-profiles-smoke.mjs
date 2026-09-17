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

await assert.rejects(() => call("POST", "/aru/v1/provider-profiles", {}, "revoked"),
  (error) => error.code === "credential.revoked");

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


const localRoute = {
  expectedRevision: created.body.revision,
  displayName: "My route",
  protocol: "openai-compatible",
  baseURL: "http://127.0.0.1:11434",
  path: "v1/chat/completions",
  model: "local-model",
  authMode: "bearer",
  maxToolRounds: 7,
};
// A paired phone cannot move a stored key to another origin without
// re-entering it; the rejected edit leaves the profile and key untouched.
await assert.rejects(
  () => call("PUT", `/aru/v1/provider-profiles/${profileId}`, localRoute, "phone"),
  (error) => error instanceof HttpError && error.code === "provider_profile.secret_required",
);
assert.equal(state.providerProfiles[0].baseURL, "https://api.example.test/");
assert.equal(state.providerProfiles[0].revision, created.body.revision);
const updated = await call("PUT", `/aru/v1/provider-profiles/${profileId}`,
  { ...localRoute, apiKey: "key-one" }, "phone");
assert.equal(updated.body.health, "ready");
assert.equal(secretStore.read(profileId), "key-one");
const renamed = await call("PUT", `/aru/v1/provider-profiles/${profileId}`,
  { ...localRoute, expectedRevision: updated.body.revision, displayName: "Same origin" }, "phone");
assert.equal(secretStore.read(profileId), "key-one");
assert.equal(renamed.body.displayName, "Same origin");
assert.equal(updated.body.maxOutputTokens, null);
assert.equal(updated.body.maxToolRounds, 7);

const anthropic = await call("PUT", `/aru/v1/provider-profiles/${profileId}`, {
  expectedRevision: renamed.body.revision,
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
    if (args[0] === "--version") return { status: 2, stdout: "", stderr: "usage: secret-tool ..." };
    if (args[0] === "lookup" && args.includes("availability-probe")) {
      return { status: 1, stdout: "", stderr: "" };
    }
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
assert.deepEqual(linuxSecretCalls.map((call) => call.args[0]), ["lookup", "lookup", "store", "clear"]);
assert.equal(linuxSecretCalls[2].input, "new-linux-key\n");
assert.ok(linuxSecretCalls.every((call) => !call.args.includes("--version")));

let unavailableProbeCount = 0;
let unavailableProbeClock = 100;
const unavailableLinuxSecretStore = createProviderSecretStore({
  platform: "linux",
  now: () => unavailableProbeClock,
  run: () => {
    unavailableProbeCount += 1;
    return {
      status: 1,
      stdout: "",
      stderr: "secret-tool: The name org.freedesktop.secrets was not provided by any service files\n",
    };
  },
});
assert.deepEqual(unavailableLinuxSecretStore.availability(), {
  supported: false,
  storage: "unavailable",
  failure: "linux-secret-service-unavailable",
});
assert.equal(unavailableLinuxSecretStore.availability().supported, false);
assert.equal(unavailableProbeCount, 1, "one inventory projection must not probe once per profile");
unavailableProbeClock += 5_001;
assert.equal(unavailableLinuxSecretStore.availability().supported, false);
assert.equal(unavailableProbeCount, 2, "a recovered Secret Service must not require a Host restart");

const absentLinuxSecretToolStore = createProviderSecretStore({
  platform: "linux",
  run: () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } }),
});
assert.deepEqual(absentLinuxSecretToolStore.availability(), {
  supported: false,
  storage: "unavailable",
  failure: "secret-tool-not-found",
});
assert.throws(
  () => absentLinuxSecretToolStore.read("provider_deadbeef"),
  /没有安装 secret-tool/,
);

const missingLinuxSecretStore = createProviderSecretStore({
  platform: "linux",
  run: (command, args) => {
    if (args.includes("availability-probe")) return { status: 1, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  },
});
assert.equal(missingLinuxSecretStore.read("provider_deadbeef"), null);

const failingLinuxSecretStore = createProviderSecretStore({
  platform: "linux",
  run: (command, args) => {
    if (args.includes("availability-probe")) return { status: 1, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "secret-tool: Cannot autolaunch D-Bus\n" };
  },
});
assert.throws(
  () => failingLinuxSecretStore.read("provider_deadbeef"),
  /Linux Secret Service.*(?:不可访问|读取)/,
);

const failingLinuxSecretRemovalStore = createProviderSecretStore({
  platform: "linux",
  run: (command, args) => {
    if (args.includes("availability-probe")) return { status: 1, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "secret-tool: Cannot autolaunch D-Bus\n" };
  },
});
assert.throws(
  () => failingLinuxSecretRemovalStore.remove("provider_deadbeef"),
  /Linux Secret Service.*不可访问/,
);

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
    () => {
      if (authority === "revoked") throw new HttpError(403, "credential.revoked", "revoked");
      return { deviceId: "device_test", deviceRole: authority === "console" ? "host-console" : null };
    },
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

const replayInput = { displayName: "Phone replay", protocol: "openai-compatible", baseURL: "https://api.example.test/",
  path: "v1/chat/completions", model: "model-one", authMode: "bearer", apiKey: "key-one",
  requestId: "44444444-4444-4444-8444-444444444444" };
const firstProfile = await call("POST", "/aru/v1/provider-profiles", replayInput, "phone");
const againProfile = await call("POST", "/aru/v1/provider-profiles", replayInput, "phone");
assert.equal(firstProfile.body.profileId, againProfile.body.profileId);
const originalProfile = JSON.stringify(state.providerProfiles.find((item) => item.profileId === firstProfile.body.profileId));
await assert.rejects(() => call("PUT", `/aru/v1/provider-profiles/${firstProfile.body.profileId}`,
  { ...replayInput, expectedRevision: firstProfile.body.revision, model: "" }, "phone"));
assert.equal(JSON.stringify(state.providerProfiles.find((item) => item.profileId === firstProfile.body.profileId)), originalProfile);
console.log("ARU_PROVIDER_PROFILE_REPLAY_SMOKE_OK");
