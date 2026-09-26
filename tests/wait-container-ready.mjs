// Readiness is asynchronous: an HTTP listener alone is not a verified engine.
const base = process.argv[2];
const deadline = Date.now() + 15_000;
let last;
while (Date.now() < deadline) {
  let manifest;
  try { manifest = await (await fetch(`${base}/.well-known/aru.json`, { signal: AbortSignal.timeout(1000) })).json(); }
  catch (error) { last = error.message; }
  if (manifest) {
    const capability = manifest.capabilities?.['workspace-runtime'];
    if (capability?.enabled) process.exit(0);
    last = JSON.stringify(capability?.readiness);
    if (capability?.readiness?.status === 'failed') throw new Error(`Core container verification failed: ${last}`);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
throw new Error(`Core container readiness timed out: ${last}`);
