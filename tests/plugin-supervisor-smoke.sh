#!/usr/bin/env bash
# Sourced by http-smoke.sh. The caller owns server startup, pairing, and restart.

PLUGIN_SUPERVISOR_MANIFEST_V1='{"schema":"aru.selfhost.plugin-manifest.v1","pluginId":"memory.example","displayName":"Memory Example","version":"1.0.0","publisher":"Example","source":"https://example.invalid/memory","packageMode":"oci","image":"registry.example/memory@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocols":["memory-v1"],"permissions":{"network":"outbound","persistentVolume":true,"secretHandles":[],"hostPaths":[],"deviceAccess":false},"resources":{"memoryMiB":128,"cpuMillis":500,"pids":32}}'
PLUGIN_SUPERVISOR_MANIFEST_V2='{"schema":"aru.selfhost.plugin-manifest.v1","pluginId":"memory.example","displayName":"Memory Example","version":"2.0.0","publisher":"Example","source":"https://example.invalid/memory","packageMode":"oci","image":"registry.example/memory@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","protocols":["memory-v1"],"permissions":{"network":"outbound","persistentVolume":true,"secretHandles":[],"hostPaths":[],"deviceAccess":false},"resources":{"memoryMiB":256,"cpuMillis":750,"pids":48}}'
PLUGIN_SUPERVISOR_MANIFEST_FAIL='{"schema":"aru.selfhost.plugin-manifest.v1","pluginId":"memory.example","displayName":"Memory Example","version":"3.0.0","publisher":"Example","source":"https://example.invalid/memory","packageMode":"oci","image":"registry.example/failstart@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","protocols":["memory-v1"],"permissions":{"network":"outbound","persistentVolume":true,"secretHandles":[],"hostPaths":[],"deviceAccess":false},"resources":{"memoryMiB":256,"cpuMillis":750,"pids":48}}'

plugin_supervisor_request() {
  printf '{"schema":"aru.selfhost.plugin-mutation.v1","manifest":%s,"grantedPermissions":%s}' \
    "$1" "$(printf '%s' "$1" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(b).permissions)))')"
}
plugin_supervisor_smoke_before_restart() {
  local base_url="$1"
  local credential="$2"
  local data_dir="$3"

  if curl -fsS "$base_url/aru/v1/plugins" >/dev/null 2>&1; then
    echo "plugin inventory accepted an unauthenticated request" >&2
    return 1
  fi

  curl -fsS "$base_url/aru/v1/plugins" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const i=JSON.parse(b);if(i.schema!=="aru.selfhost.plugin-inventory.v1"||i.plugins?.length!==0)process.exit(1)})'

  local status
  status="$(curl -sS -o "$data_dir/bad-plugin.json" -w '%{http_code}' \
    -X POST "$base_url/aru/v1/plugins" \
    -H 'content-type: application/json' -H "authorization: Bearer $credential" \
    --data '{"schema":"aru.selfhost.plugin-mutation.v1","manifest":{"schema":"aru.selfhost.plugin-manifest.v1","pluginId":"bad","displayName":"Bad","version":"1","publisher":"Bad","source":"local","packageMode":"oci","image":"registry.example/bad:latest","protocols":[],"permissions":{"network":"none","persistentVolume":false,"secretHandles":[],"hostPaths":[],"deviceAccess":false},"resources":{"memoryMiB":null,"cpuMillis":null,"pids":null}},"grantedPermissions":{"network":"none","persistentVolume":false,"secretHandles":[],"hostPaths":[],"deviceAccess":false}}')"
  test "$status" = "400"
  grep -Fq 'plugin.image_not_pinned' "$data_dir/bad-plugin.json"

  status="$(curl -sS -o "$data_dir/option-plugin.json" -w '%{http_code}' \
    -X POST "$base_url/aru/v1/plugins" \
    -H 'content-type: application/json' -H "authorization: Bearer $credential" \
    --data '{"schema":"aru.selfhost.plugin-mutation.v1","manifest":{"schema":"aru.selfhost.plugin-manifest.v1","pluginId":"option","displayName":"Option","version":"1","publisher":"Bad","source":"local","packageMode":"oci","image":"--privileged@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","protocols":[],"permissions":{"network":"none","persistentVolume":false,"secretHandles":[],"hostPaths":[],"deviceAccess":false},"resources":{"memoryMiB":null,"cpuMillis":null,"pids":null}},"grantedPermissions":{"network":"none","persistentVolume":false,"secretHandles":[],"hostPaths":[],"deviceAccess":false}}')"
  test "$status" = "400"
  grep -Fq 'plugin.image_not_pinned' "$data_dir/option-plugin.json"

  status="$(curl -sS -o "$data_dir/secret-plugin.json" -w '%{http_code}' \
    -X POST "$base_url/aru/v1/plugins" \
    -H 'content-type: application/json' -H "authorization: Bearer $credential" \
    --data '{"schema":"aru.selfhost.plugin-mutation.v1","manifest":{"schema":"aru.selfhost.plugin-manifest.v1","pluginId":"secret","displayName":"Secret","version":"1","publisher":"Bad","source":"local","packageMode":"oci","image":"registry.example/secret@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","protocols":[],"permissions":{"network":"none","persistentVolume":false,"secretHandles":["api-key"],"hostPaths":[],"deviceAccess":false},"resources":{"memoryMiB":null,"cpuMillis":null,"pids":null}},"grantedPermissions":{"network":"none","persistentVolume":false,"secretHandles":["api-key"],"hostPaths":[],"deviceAccess":false}}')"
  test "$status" = "409"
  grep -Fq 'plugin.scoped_secrets_unavailable' "$data_dir/secret-plugin.json"

  curl -fsS -X POST "$base_url/aru/v1/plugins" \
    -H 'content-type: application/json' -H "authorization: Bearer $credential" \
    --data "$(plugin_supervisor_request "$PLUGIN_SUPERVISOR_MANIFEST_V1")" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const p=JSON.parse(b);if(p.schema!=="aru.selfhost.plugin.v1"||p.desiredState!=="disabled"||p.health!=="disabled"||p.dataPresent!==true||p.rollbackAvailable!==false)process.exit(1)})'

  curl -fsS -X POST "$base_url/aru/v1/plugins/memory.example/enable" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const p=JSON.parse(b);if(p.desiredState!=="enabled"||p.health!=="running")process.exit(1)})'

  curl -fsS -X POST "$base_url/aru/v1/plugins/memory.example/upgrade" \
    -H 'content-type: application/json' -H "authorization: Bearer $credential" \
    --data "$(plugin_supervisor_request "$PLUGIN_SUPERVISOR_MANIFEST_V2")" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const p=JSON.parse(b);if(p.manifest?.version!=="2.0.0"||p.health!=="running"||p.rollbackAvailable!==true)process.exit(1)})'

  status="$(curl -sS -o "$data_dir/failed-upgrade.json" -w '%{http_code}' \
    -X POST "$base_url/aru/v1/plugins/memory.example/upgrade" \
    -H 'content-type: application/json' -H "authorization: Bearer $credential" \
    --data "$(plugin_supervisor_request "$PLUGIN_SUPERVISOR_MANIFEST_FAIL")")"
  test "$status" = "503"
  grep -Fq 'plugin.upgrade_rolled_back' "$data_dir/failed-upgrade.json"
  curl -fsS "$base_url/aru/v1/plugins/memory.example" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const p=JSON.parse(b);if(p.manifest?.version!=="2.0.0"||p.health!=="running"||p.rollbackAvailable!==true)process.exit(1)})'

  curl -fsS -X POST "$base_url/aru/v1/plugins/memory.example/rollback" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const p=JSON.parse(b);if(p.manifest?.version!=="1.0.0"||p.health!=="running"||p.rollbackAvailable!==true)process.exit(1)})'
}

plugin_supervisor_smoke_after_restart() {
  local base_url="$1"
  local credential="$2"

  curl -fsS "$base_url/aru/v1/plugins/memory.example" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const p=JSON.parse(b);if(p.desiredState!=="enabled"||p.health!=="running"||p.manifest?.version!=="1.0.0")process.exit(1)})'
}

plugin_supervisor_smoke_uninstall() {
  local base_url="$1"
  local credential="$2"

  curl -fsS -X DELETE "$base_url/aru/v1/plugins/memory.example?deleteData=false" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.pluginId!=="memory.example"||r.dataDeleted!==false)process.exit(1)})'
  curl -fsS -X POST "$base_url/aru/v1/plugins" \
    -H 'content-type: application/json' -H "authorization: Bearer $credential" \
    --data "$(plugin_supervisor_request "$PLUGIN_SUPERVISOR_MANIFEST_V1")" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const p=JSON.parse(b);if(p.dataPresent!==true||p.desiredState!=="disabled")process.exit(1)})'
  curl -fsS -X DELETE "$base_url/aru/v1/plugins/memory.example?deleteData=true" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.dataDeleted!==true)process.exit(1)})'
  curl -fsS "$base_url/aru/v1/plugins" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const i=JSON.parse(b);if(i.plugins?.length!==0)process.exit(1)})'
}
