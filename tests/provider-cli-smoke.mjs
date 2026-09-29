#!/usr/bin/env node

import assert from "node:assert/strict";
import { runProviderCLI } from "../provider-cli.mjs";

const profileId = "provider_deadbeef";
const calls = [];
let output = "";
const profile = {
  schema: "aru.selfhost.provider-profile.v1",
  profileId,
  revision: 3,
  displayName: "Primary",
  protocol: "openai-compatible",
  baseURL: "https://api.example.test/",
  path: "v1/chat/completions",
  model: "model-one",
  authMode: "bearer",
  maxOutputTokens: null,
  maxToolRounds: null,
  health: "ready",
  hasSecret: true,
};

const dependencies = {
  baseURL: "http://127.0.0.1:8787",
  readCredential: () => "local-operator-secret",
  readSecret: async () => "provider-secret-value",
  write: (value) => { output += value; },
  fetchImpl: async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    let body;
    if (init.method === "GET" && path.endsWith(profileId)) body = profile;
    else if (init.method === "GET") body = { profiles: [profile] };
    else if (init.method === "DELETE") body = { profileId, deleted: true };
    else body = { ...profile, ...JSON.parse(init.body ?? "{}") };
    return { ok: true, status: 200, json: async () => body };
  },
};

await runProviderCLI([
  "add",
  "--name", "Primary",
  "--base-url", "https://api.example.test",
  "--model", "model-one",
], dependencies);
assert.equal(calls[0].init.headers.authorization, "Bearer local-operator-secret");
assert.equal(JSON.parse(calls[0].init.body).apiKey, "provider-secret-value");
assert.equal(output.includes("provider-secret-value"), false);
assert.equal(output.includes("local-operator-secret"), false);

output = "";
await runProviderCLI(["update", profileId, "--model", "model-two"], dependencies);
const update = JSON.parse(calls.at(-1).init.body);
assert.equal(update.expectedRevision, 3);
assert.equal(update.model, "model-two");
assert.equal(Object.hasOwn(update, "apiKey"), false, "ordinary metadata edits must keep the existing key");

await assert.rejects(
  () => runProviderCLI(["delete", profileId], dependencies),
  /repeat with --yes/,
);
await runProviderCLI(["delete", profileId, "--yes"], dependencies);

output = "";
await runProviderCLI(["list"], dependencies);
assert.match(output, new RegExp(`${profileId}\\tPrimary`));

await assert.rejects(
  () => runProviderCLI([
    "add",
    "--name", "Unsafe",
    "--base-url", "https://api.example.test",
    "--model", "model-one",
    "--api-key", "must-not-enter-argv",
  ], dependencies),
  /unknown option: --api-key/,
);

console.log("ARU_PROVIDER_CLI_SMOKE_OK");
