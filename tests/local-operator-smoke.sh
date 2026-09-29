#!/usr/bin/env bash
set -Eeuo pipefail

SELFHOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_dir="$(mktemp -d)"
log_file="$data_dir/host.log"
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
operator_credential="local-operator-smoke-secret"
operator_hash="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$operator_credential")"
pid=""

cleanup() {
  [[ -z "$pid" ]] || kill "$pid" >/dev/null 2>&1 || true
  [[ -z "$pid" ]] || wait "$pid" >/dev/null 2>&1 || true
  rm -rf "$data_dir"
}
trap cleanup EXIT

node "$SELFHOST_DIR/aru-selfhost-stub.mjs" \
  --listen-host 127.0.0.1 \
  --port "$port" \
  --data-dir "$data_dir/state" \
  --base-url "http://127.0.0.1:$port" \
  --transport-kind lan \
  --display-name "Local Operator Smoke" \
  --node-kind vps \
  --local-operator-credential-sha256 "$operator_hash" \
  >"$log_file" 2>&1 &
pid=$!

for _ in {1..50}; do
  if curl -fsS "http://127.0.0.1:$port/.well-known/aru.json" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$port/.well-known/aru.json" >/dev/null

unauthorized_status="$(curl -sS -o "$data_dir/unauthorized.json" -w '%{http_code}' \
  -X DELETE "http://127.0.0.1:$port/aru/v1/provider-profiles/provider_deadbeef")"
test "$unauthorized_status" = "401"
grep -Fq 'credential.missing' "$data_dir/unauthorized.json"

# A nonexistent profile still returns 404 after the credential and loopback
# checks. That distinguishes accepted local-operator authority from a public or
# ordinary unauthenticated provider mutation.
authorized_status="$(curl -sS -o "$data_dir/authorized.json" -w '%{http_code}' \
  -X DELETE "http://127.0.0.1:$port/aru/v1/provider-profiles/provider_deadbeef" \
  -H "authorization: Bearer $operator_credential")"
test "$authorized_status" = "404"
grep -Fq 'provider_profile.unknown' "$data_dir/authorized.json"

echo "ARU_LOCAL_OPERATOR_SMOKE_OK"
