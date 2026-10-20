import { readFile } from "node:fs/promises";
import { readPort, validateHostRequest } from "./runtime.mjs";

// Only structured codes are displayed; response bodies and OS paths may contain
// credentials. Keep the original cause in memory, never in a diagnostic file.
export function requestFailure(stage, cause, detail = "") {
  const candidate = cause?.cause?.code ?? cause?.code ?? cause?.name;
  const code = typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(candidate) ? candidate : "unknown";
  return Object.assign(new Error(`Host request failed at ${stage}${detail ? ` (${detail})` : ""}: ${code}`, { cause }), { code: `host_${stage}_failed`, stage });
}

export function createHostRequest({ platform, readText = readFile, fetchResponse = (...args) => globalThis.fetch(...args) }) {
  return async function requestHost(method, path, body, authenticated = true, extraHeaders = {}, signal) {
    const request = validateHostRequest(method, path);
    let contents = "";
    try { contents = await readText(platform.nodeEnvPath, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw requestFailure("configuration", error); }
    const port = readPort(contents);
    const url = new URL(request.path, `http://127.0.0.1:${port}`);
    const headers = { Accept: "application/json", ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authenticated) {
      const credential = await platform.readCredential();
      if (!credential) throw new Error("The secure Console connection is unavailable");
      headers.Authorization = `Bearer ${credential}`;
    }
    let response;
    try {
      response = await fetchResponse(url, { signal, method: request.method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) { throw requestFailure("connection", error, `127.0.0.1:${port}`); }
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error("The Console credential is no longer accepted"), { code: "credential_rejected" });
    }
    if (!response.ok) {
      // Manifest requests have no product error body to expose.
      if (request.path === "/.well-known/aru.json") throw requestFailure("http", null, `HTTP ${response.status}`);
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.message ?? failure.error ?? `Host returned HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (request.path === "/.well-known/aru.json" && !contentType.includes("json")) {
      throw requestFailure("response", null, "expected JSON manifest");
    }
    try { return await (contentType.includes("json") ? response.json() : response.text()); }
    catch (error) { throw requestFailure("parsing", error); }
  };
}
