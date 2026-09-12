import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createProviderSecretStore, windowsSecretFilePath } from "../provider-secret-store.mjs";
import { createAPNsCredentialStore } from "../apns-push.mjs";

// Proves the win32 DPAPI backend the same way the Linux backend is proved in
// provider-profiles-smoke.mjs: an injected `run` transcript, no real OS calls.
// The security claims under test: secrets travel over stdin/stdout only, the
// ciphertext path is deterministic, missing PowerShell degrades to an honest
// unavailable state, and exit 44 means not-found rather than failure.

function transcriptRun(transcript, responses = {}) {
  return (command, args, options = {}) => {
    transcript.push({ command, args, input: options.input ?? null });
    const key = args[args.length - 1];
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

// 1. Availability probes DPAPI through powershell.exe and memoizes.
{
  const transcript = [];
  const store = createProviderSecretStore({ platform: "win32", run: transcriptRun(transcript) });
  const first = store.availability();
  const second = store.availability();
  assert.deepEqual(first, { supported: true, storage: "windows-dpapi", failure: null });
  assert.equal(second, first);
  assert.equal(transcript.length, 1, "availability is probed exactly once");
  assert.equal(transcript[0].command, "powershell.exe");
  assert.match(transcript[0].args.join(" "), /ProtectedData\]::Protect/);
}

// 2. Missing PowerShell is an honest unavailable state, not a plaintext fallback.
{
  const store = createProviderSecretStore({
    platform: "win32",
    run: () => ({ status: null, error: { code: "ENOENT" } }),
  });
  assert.deepEqual(store.availability(), {
    supported: false, storage: "unavailable", failure: "powershell-not-found",
  });
  assert.throws(() => store.write("provider_abc123", "sk-test"), /安全凭据存储/);
}

// 3. Write/read/remove transcript: stdin-only secret, deterministic path, exit 44 = null.
{
  const profileId = "provider_ABCDEF123456";
  const expectedPath = windowsSecretFilePath("cn.aelion.aru.host-provider.v1", profileId, {
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  });
  assert.match(expectedPath, /AruHost[\\/]secrets[\\/]cn\.aelion\.aru\.host-provider\.v1[\\/]provider_ABCDEF123456\.dpapi$/);

  const transcript = [];
  const store = createProviderSecretStore({ platform: "win32", run: transcriptRun(transcript) });

  store.write(profileId, "sk-secret-value");
  const writeCall = transcript.at(-1);
  assert.equal(writeCall.input, "sk-secret-value\n", "secret travels over stdin");
  assert.doesNotMatch(writeCall.args.join(" "), /sk-secret-value/, "secret never appears in argv");
  assert.match(writeCall.args.join(" "), /ProtectedData\]::Protect/);
  assert.match(writeCall.args.join(" "), /provider_ABCDEF123456\.dpapi/);

  store.remove(profileId);
  assert.match(transcript.at(-1).args.join(" "), /Remove-Item/);

  const readingStore = createProviderSecretStore({
    platform: "win32",
    run: (command, args, options) => {
      transcript.push({ command, args, input: options?.input ?? null });
      if (args.join(" ").includes("Unprotect")) return { status: 0, stdout: "sk-secret-value" };
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(readingStore.read(profileId), "sk-secret-value");

  const missingStore = createProviderSecretStore({
    platform: "win32",
    run: (command, args) => {
      if (args.join(" ").includes("Unprotect")) return { status: 44, stdout: "" };
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(missingStore.read(profileId), null, "exit 44 is not-found, not an error");
}

// 4. APNs credential store shares the win32 backend and stays read-only.
{
  const transcript = [];
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const encoded = `aru-apns-v1:${Buffer.from(JSON.stringify({
    keyId: "KEY1234567", teamId: "TEAM123456",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim(),
  })).toString("base64url")}`;
  const store = createAPNsCredentialStore({
    platform: "win32",
    run: (command, args, options) => {
      transcript.push({ command, args, input: options?.input ?? null });
      if (args.join(" ").includes("Unprotect")) return { status: 0, stdout: encoded };
      return { status: 0, stdout: "" };
    },
  });
  assert.deepEqual(store.availability(), { supported: true, storage: "windows-dpapi" });
  const credentials = store.read();
  assert.equal(credentials.keyId, "KEY1234567");
  assert.equal(store.write, undefined, "APNs store remains read-only by design");
  assert.ok(transcript.every((call) => call.command === "powershell.exe"));

  const absent = createAPNsCredentialStore({
    platform: "win32",
    run: (command, args) => {
      if (args.join(" ").includes("Unprotect")) return { status: 44, stdout: "" };
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(absent.read(), null);
}

// 5. Non-windows platforms are untouched by the new backend.
{
  const store = createProviderSecretStore({ platform: "sunos", run: () => ({ status: 0 }) });
  assert.deepEqual(store.availability(), {
    supported: false, storage: "unavailable", failure: "platform-secret-store-unavailable",
  });
}

console.log("ARU_WINDOWS_SECRET_STORE_SMOKE_OK");
