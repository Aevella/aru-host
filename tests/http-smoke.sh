#!/usr/bin/env bash
set -Eeuo pipefail

SELFHOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SELFHOST_DIR/tests/plugin-supervisor-smoke.sh"
data_dir="$(mktemp -d)"
log_file="$(mktemp)"
config_file="$data_dir/node.env"
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
pid=""
cleanup() {
  [[ -z "$pid" ]] || kill "$pid" >/dev/null 2>&1 || true
  [[ -z "$pid" ]] || wait "$pid" >/dev/null 2>&1 || true
  rm -rf "$data_dir" "$log_file"
}
trap cleanup EXIT

cat > "$config_file" <<EOF
ARU_SERVER_ENTRY=$SELFHOST_DIR/aru-selfhost-stub.mjs
ARU_NODE_BINARY=$(command -v node)
ARU_LISTEN_HOST=127.0.0.1
ARU_PORT=$port
ARU_DATA_DIR=$data_dir/state
ARU_MANAGED_WORKSPACE_ROOT=$data_dir/managed-workspace
ARU_BASE_URL=http://127.0.0.1:$port
ARU_TRANSPORT_KIND=lan
ARU_DISPLAY_NAME=HTTP\ Smoke
ARU_NODE_KIND=home-mac
ARU_CONTAINER_RUNTIME=$SELFHOST_DIR/tests/fake-container-runtime.sh
ARU_FAKE_RUNTIME_STATE_DIR=$data_dir/fake-runtime
EOF

ARU_SMOKE_SECRET="must-not-reach-plugin" ARU_SELFHOST_CONFIG_FILE="$config_file" \
  "$SELFHOST_DIR/run-node.sh" >"$log_file" 2>&1 &
pid=$!

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:$port/.well-known/aru.json" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$port/.well-known/aru.json" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const m=JSON.parse(b);
        if(m.schema!=="aru.selfhost.manifest.v1") process.exit(1);
        if(m.capabilities?.["backup-vault"]?.enabled!==true) process.exit(2);
        if(m.capabilities?.["backup-vault"]?.settingsEndpoint!=="/aru/v1/backups/settings") process.exit(19);
        if(m.capabilities?.["backup-vault"]?.retention!=="host-enforced-after-upload") process.exit(20);
        if(m.capabilities?.["workspace-runtime"]?.enabled!==true) process.exit(3);
        if(m.capabilities?.["mcp-gateway"]?.enabled!==true) process.exit(4);
        if(m.capabilities?.["mcp-gateway"]?.credentialMode!=="paired-node-device-credential") process.exit(5);
        if(m.capabilities?.["artifact-vault"]?.enabled!==true) process.exit(6);
        if(m.capabilities?.["artifact-vault"]?.integrity!=="sha256") process.exit(7);
        if(m.capabilities?.["job-runtime"]?.enabled!==true) process.exit(8);
        if(m.capabilities?.["workspace-runtime"]?.execution!=="durable-jobs-v1") process.exit(9);
        if(m.capabilities?.["plugin-supervisor"]?.enabled!==true) process.exit(10);
        if(!m.capabilities?.["plugin-supervisor"]?.packageModes?.includes("oci")||m.capabilities?.["plugin-supervisor"]?.imageIdentity!=="sha256-digest-required") process.exit(11);
        if(m.capabilities?.["collaborator-host"]?.enabled!==true) process.exit(12);
        if(m.capabilities?.["collaborator-host"]?.authority!=="computer-host") process.exit(13);
        if(typeof m.capabilities?.["collaborator-host"]?.turnExecution!=="boolean") process.exit(14);
        if(m.capabilities?.["collaborator-host"]?.conversationEndpoint!=="/aru/v1/hosted-collaborators/{collaboratorId}/conversations") process.exit(21);
        if(m.capabilities?.["collaborator-host"]?.providerProfileEndpoint!=="/aru/v1/provider-profiles") process.exit(22);
        if(m.capabilities?.["collaborator-host"]?.cognitionEndpoint!=="/aru/v1/hosted-collaborators/{collaboratorId}/cognition") process.exit(23);
        if(m.capabilities?.["node-workspaces"]?.enabled!==true) process.exit(15);
        if(m.capabilities?.["node-workspaces"]?.commandExecution!==false) process.exit(16);
        if(m.capabilities?.["node-workspaces"]?.defaultWorkspace!=="host-managed") process.exit(18);
        if(m.capabilities?.["node-settings"]?.enabled!==true) process.exit(17);
      });'

pairing_url="$(grep -E '^aru://pair\?' "$log_file" | tail -1)"
pairing_token="$(node -e 'process.stdout.write(new URL(process.argv[1]).searchParams.get("pairingToken") ?? "")' "$pairing_url")"
test -n "$pairing_token"

grant="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/pair" \
  -H 'content-type: application/json' \
  --data "{\"pairingToken\":\"$pairing_token\",\"deviceLabel\":\"installer-smoke\",\"deviceRole\":\"host-console\"}")"
credential="$(printf '%s' "$grant" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const g=JSON.parse(b);if(!g.credentialSecret)process.exit(1);process.stdout.write(g.credentialSecret)
  });')"

curl -fsS "http://127.0.0.1:$port/aru/v1/devices" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);const current=p.devices?.find(d=>d.isCurrent===true);
        if(p.schema!=="aru.selfhost.paired-device-inventory.v1"||!current)process.exit(1);
        if(p.currentDeviceId!==current.deviceId||current.label!=="installer-smoke")process.exit(2);
      });'

curl -fsS "http://127.0.0.1:$port/aru/v1/node-settings" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.schema!=="aru.selfhost.node-settings.v1"||p.displayName!=="HTTP Smoke"||p.revision!==1)process.exit(1);
      });'

curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/node-settings" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.node-settings.v1","displayName":"Renamed Smoke Node","expectedRevision":1}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.displayName!=="Renamed Smoke Node"||p.revision!==2)process.exit(1)
      });'

curl -fsS "http://127.0.0.1:$port/.well-known/aru.json" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.displayName!=="Renamed Smoke Node"||p.capabilities?.["mcp-gateway"]?.displayName!=="Renamed Smoke Node Tools")process.exit(1)
      });'

stale_node_settings_status="$(curl -sS -o "$data_dir/stale-node-settings.json" -w '%{http_code}' \
  -X PUT "http://127.0.0.1:$port/aru/v1/node-settings" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.node-settings.v1","displayName":"Stale Name","expectedRevision":1}')"
test "$stale_node_settings_status" = "409"
grep -Fq 'node.revision_conflict' "$data_dir/stale-node-settings.json"

if curl -fsS "http://127.0.0.1:$port/aru/v1/agent-drivers" >/dev/null 2>&1; then
  echo "agent-driver inventory accepted an unauthenticated request" >&2
  exit 1
fi

curl -fsS "http://127.0.0.1:$port/aru/v1/agent-drivers" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);const drivers=p.drivers??[];
        if(p.schema!=="aru.selfhost.agent-driver-inventory.v1")process.exit(1);
        if(!drivers.some(d=>d.id==="codex"&&d.adapter==="codex-app-server"))process.exit(2);
        if(!drivers.some(d=>d.id==="claude-code"&&d.adapter==="claude-agent-sdk"))process.exit(3);
        if(!drivers.some(d=>d.id==="api"&&d.adapter==="direct-provider-api"))process.exit(7);
        if(typeof p.execution?.enabled!=="boolean"||!["driver-unavailable","ready","starting","running"].includes(p.execution?.status))process.exit(4);
        if(!Number.isInteger(p.execution?.conversationCount)||!Number.isInteger(p.execution?.activeTurnCount)||!Number.isInteger(p.execution?.pendingApprovalCount))process.exit(6);
        if(drivers.some(d=>d.executableCandidates!==undefined))process.exit(5);
      });'

curl -fsS "http://127.0.0.1:$port/aru/v1/provider-profiles" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.schema!=="aru.selfhost.provider-profile-inventory.v1"||!Array.isArray(p.profiles))process.exit(1);
        if(typeof p.secretStorage?.supported!=="boolean"||typeof p.secretStorage?.storage!=="string")process.exit(2);
        if(JSON.stringify(p).match(/api[_-]?key/i))process.exit(3);
      });'

hosted_collaborator="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/hosted-collaborators" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"displayName":"Computer Aru","driverId":"codex"}')"
hosted_collaborator_id="$(printf '%s' "$hosted_collaborator" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const p=JSON.parse(b);
    if(p.schema!=="aru.selfhost.hosted-collaborator.v1"||p.authority!=="computer-host")process.exit(1);
    if(p.clientProjection!=="read-only-replica"||typeof p.turnExecution!=="boolean")process.exit(2);
    if(p.toolAccess?.schema!=="aru.selfhost.collaborator-tool-access.v1"||p.toolAccess?.mode!=="all"||p.toolAccess?.toolNames?.length!==0)process.exit(3);
    process.stdout.write(p.collaboratorId);
  });')"

hosted_cognition="$(curl -fsS "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/cognition" \
  -H "authorization: Bearer $credential")"
printf '%s' "$hosted_cognition" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const p=JSON.parse(b);
    if(p.schema!=="aru.selfhost.collaborator-cognition.v1"||p.instructionEnvironment!=="isolated")process.exit(1);
    if(p.revision!==1||p.memories.length!==0||p.references.length!==0)process.exit(2);
  });'
hosted_cognition="$(curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/cognition" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedRevision":1,"instructionEnvironment":"inheritCodex","systemPrompt":"Be precise."}')"
printf '%s' "$hosted_cognition" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const p=JSON.parse(b);if(p.revision!==2||p.systemPrompt!=="Be precise."||p.instructionEnvironment!=="inheritCodex")process.exit(1);
  });'
curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/cognition/memories" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedRevision":2,"title":"Preference","content":"Explain the cause."}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.revision!==3||p.memories?.[0]?.content!=="Explain the cause.")process.exit(1)
      });'

hosted_conversation="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/conversations" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"title":"Host ledger smoke"}')"
hosted_conversation_id="$(printf '%s' "$hosted_conversation" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const p=JSON.parse(b);
    if(p.schema!=="aru.selfhost.collaborator-conversation.v1"||p.title!=="Host ledger smoke")process.exit(1);
    if(p.messageCount!==0||p.pendingApprovalCount!==0||p.cursor!==0)process.exit(2);
    process.stdout.write(p.conversationId);
  });')"
curl -fsS "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/conversations/$hosted_conversation_id" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(!Array.isArray(p.messages)||!Array.isArray(p.approvals))process.exit(1)
      });'
test -n "$hosted_collaborator_id"

surface_html='<!doctype html><html><body><button onclick="PolarisRoom.emit('"'"'pressed'"'"',{count:1})">Hello</button></body></html>'
surface_payload="$(node -e 'process.stdout.write(JSON.stringify({title:"Phone canvas",sourceHTML:process.argv[1],note:"Initial"}))' "$surface_html")"
surface_created="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data "$surface_payload")"
surface_id="$(printf '%s' "$surface_created" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const p=JSON.parse(b);
    if(p.schema!=="aru.selfhost.collaborator-surface.v1"||p.revision!==1||p.stateRevision!==1)process.exit(1);
    if(p.activeVersionOrdinal!==1||p.versions?.length!==1||p.versions[0]?.ordinal!==1)process.exit(2);
    if(!p.sourceHTML?.includes("PolarisRoom.emit")||p.stateJSON!=="{}")process.exit(3);
    if(p.networkAccess!=="none"||p.storageMode!=="isolated-persistent")process.exit(4);
    process.stdout.write(p.surfaceId);
  });')"
surface_initial_version_id="$(printf '%s' "$surface_created" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).activeVersionId));')"
test -n "$surface_id"
test -n "$surface_initial_version_id"

if curl -fsS "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces" >/dev/null 2>&1; then
  echo "collaborator surfaces accepted an unauthenticated request" >&2
  exit 1
fi

curl -fsS "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);const s=p.surfaces?.[0];
        if(p.schema!=="aru.selfhost.collaborator-surface-inventory.v1"||p.surfaces?.length!==1)process.exit(1);
        if(s?.title!=="Phone canvas"||s?.activeVersionOrdinal!==1||s?.sourceHTML!==undefined)process.exit(2);
      });'

curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id/state" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedStateRevision":1,"stateJSON":"{\"count\":1}"}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.stateRevision!==2||p.stateJSON!=="{\"count\":1}")process.exit(1);
      });'

curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id/events" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"type":"pressed","payload":{"count":1,"visible":true}}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.schema!=="aru.selfhost.collaborator-surface-event.v1"||p.sequence!==1)process.exit(1);
      });'

curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id/runtime" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedRevision":1,"networkAccess":"outbound"}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.revision!==2||p.networkAccess!=="outbound"||p.storageMode!=="isolated-persistent")process.exit(1);
      });'
curl -fsS "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id/events" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);const e=p.events?.[0];
        if(p.schema!=="aru.selfhost.collaborator-surface-event-inventory.v1"||e?.type!=="pressed")process.exit(1);
        if(e.payload?.count!==1||e.payload?.visible!==true||e.deviceId!==undefined)process.exit(2);
      });'

surface_updated_html='<!doctype html><html><body><h1>Version two</h1></body></html>'
surface_update_payload="$(node -e 'process.stdout.write(JSON.stringify({expectedRevision:2,title:"Phone canvas",sourceHTML:process.argv[1],note:"Second"}))' "$surface_updated_html")"
curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data "$surface_update_payload" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.revision!==3||p.activeVersionOrdinal!==2||p.versions?.map(v=>v.ordinal).join(",")!=="2,1")process.exit(1);
        if(p.eventCount!==1||p.stateRevision!==2)process.exit(2);
      });'

stale_surface_status="$(curl -sS -o "$data_dir/stale-surface.json" -w '%{http_code}' \
  -X PUT "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedRevision":2,"title":"Stale"}')"
test "$stale_surface_status" = "409"
grep -Fq 'surface.revision_conflict' "$data_dir/stale-surface.json"

rollback_payload="$(node -e 'process.stdout.write(JSON.stringify({expectedRevision:3,versionId:process.argv[1],note:"Restore initial"}))' "$surface_initial_version_id")"
curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id/rollback" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data "$rollback_payload" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);const active=p.versions?.[0];
        if(p.revision!==4||p.activeVersionOrdinal!==3||active?.restoredFromVersionId==null)process.exit(1);
        if(!p.sourceHTML?.includes("PolarisRoom.emit"))process.exit(2);
      });'

curl -fsS "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id/versions/$surface_initial_version_id" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.schema!=="aru.selfhost.collaborator-surface-version.v1"||!p.sourceHTML?.includes("PolarisRoom.emit"))process.exit(1);
      });'

curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id/archive" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedRevision":4}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.revision!==5||p.archivedAt==null)process.exit(1);
      });'
curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id/surfaces/$surface_id/restore" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedRevision":5}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.revision!==6||p.archivedAt!==null)process.exit(1);
      });'

managed_workspace_inventory="$(curl -fsS "http://127.0.0.1:$port/aru/v1/node-workspaces" \
  -H "authorization: Bearer $credential")"
managed_workspace_id="$(printf '%s' "$managed_workspace_inventory" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const p=JSON.parse(b);const w=p.workspaces?.[0];
    if(p.schema!=="aru.selfhost.node-workspace-inventory.v1"||p.workspaces?.length!==1)process.exit(1);
    if(w?.displayName!=="Aru Workspace"||w?.ownership!=="host-managed"||w?.isDefault!==true)process.exit(2);
    process.stdout.write(w.workspaceId??"");
  });')"
test -n "$managed_workspace_id"
test -d "$data_dir/managed-workspace"
curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/node-workspaces/$managed_workspace_id/directory" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"path":"Organized"}' >/dev/null
test -d "$data_dir/managed-workspace/Organized"
managed_revoke_status="$(curl -sS -o "$data_dir/managed-revoke.json" -w '%{http_code}' \
  -X DELETE "http://127.0.0.1:$port/aru/v1/node-workspaces/$managed_workspace_id" \
  -H "authorization: Bearer $credential")"
test "$managed_revoke_status" = "409"
grep -Fq 'node_workspace.managed_required' "$data_dir/managed-revoke.json"

authorized_root="$data_dir/authorized-root"
mkdir -p "$authorized_root/sub"
printf 'hello' > "$authorized_root/sub/note.txt"
workspace="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/node-workspaces" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data "$(node -e 'process.stdout.write(JSON.stringify({rootPath:process.argv[1],displayName:"Smoke Workspace"}))' "$authorized_root")")"
workspace_id="$(printf '%s' "$workspace" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const p=JSON.parse(b);if(p.schema!=="aru.selfhost.node-workspace.v1"||p.displayName!=="Smoke Workspace")process.exit(1);process.stdout.write(p.workspaceId)
  });')"
test -n "$workspace_id"

curl -fsS "http://127.0.0.1:$port/aru/v1/node-workspaces" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.schema!=="aru.selfhost.node-workspace-inventory.v1"||p.workspaces?.length!==2)process.exit(1);
        if(p.workspaces[0]?.ownership!=="host-managed"||p.workspaces[0]?.isDefault!==true)process.exit(2);
        if(p.workspaces[1]?.ownership!=="user-granted"||p.workspaces[1]?.isDefault!==false)process.exit(3)
      });'
curl -fsS "http://127.0.0.1:$port/aru/v1/node-workspaces/$workspace_id/files?path=sub" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.entries?.[0]?.path!=="sub/note.txt"||p.entries[0].kind!=="file")process.exit(1)
      });'
curl -fsS "http://127.0.0.1:$port/aru/v1/node-workspaces/$workspace_id/file?path=sub%2Fnote.txt" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.content!=="hello")process.exit(1)
      });'
curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/node-workspaces/$workspace_id/file" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"path":"sub/new.txt","content":"from Aru"}' >/dev/null
test "$(cat "$authorized_root/sub/new.txt")" = "from Aru"

workspace_escape_status="$(curl -sS -o "$data_dir/workspace-escape.json" -w '%{http_code}' \
  "http://127.0.0.1:$port/aru/v1/node-workspaces/$workspace_id/file?path=..%2Fstate.json" \
  -H "authorization: Bearer $credential")"
test "$workspace_escape_status" = "400"
grep -Fq 'node_workspace.path_outside_root' "$data_dir/workspace-escape.json"

curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedRevision":1,"displayName":"Computer Aru Renamed","driverId":"claude-code","toolAccess":{"schema":"aru.selfhost.collaborator-tool-access.v1","mode":"selected","toolNames":["aru_plugin_inventory","aru_node_status","aru_node_status"]}}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.displayName!=="Computer Aru Renamed"||p.driverId!=="claude-code"||p.revision!==2)process.exit(1);
        if(p.toolAccess?.mode!=="selected"||JSON.stringify(p.toolAccess?.toolNames)!==JSON.stringify(["aru_node_status","aru_plugin_inventory"]))process.exit(2);
      });'

curl -fsS "http://127.0.0.1:$port/aru/v1/hosted-collaborators" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.schema!=="aru.selfhost.hosted-collaborator-inventory.v1"||p.collaborators?.length!==1)process.exit(1);
      });'

invalid_driver_status="$(curl -sS -o "$data_dir/invalid-driver.json" -w '%{http_code}' \
  -X POST "http://127.0.0.1:$port/aru/v1/hosted-collaborators" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"displayName":"Invalid","driverId":"arbitrary-shell"}')"
test "$invalid_driver_status" = "400"
grep -Fq 'agent_driver.unknown' "$data_dir/invalid-driver.json"

invalid_tool_access_status="$(curl -sS -o "$data_dir/invalid-tool-access.json" -w '%{http_code}' \
  -X PUT "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedRevision":2,"toolAccess":{"mode":"sometimes","toolNames":[]}}')"
test "$invalid_tool_access_status" = "400"
grep -Fq 'collaborator.tool_access_invalid' "$data_dir/invalid-tool-access.json"

stale_revision_status="$(curl -sS -o "$data_dir/stale-revision.json" -w '%{http_code}' \
  -X PUT "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"expectedRevision":1,"displayName":"Stale write"}')"
test "$stale_revision_status" = "409"
grep -Fq 'collaborator.revision_conflict' "$data_dir/stale-revision.json"

backup_package="$data_dir/streaming-backup.aruencpkg"
node - "$backup_package" <<'NODE'
const fs = require("node:fs");
const output = process.argv[2];
const ciphertext = Buffer.from("streamed-ciphertext");
const header = {
  algorithm: "AES-256-GCM-CHUNKED",
  chunkByteCount: 1048576,
  chunkCount: 1,
  format: "aru-native-encrypted-package",
  kdf: "PBKDF2-HMAC-SHA256",
  kdfIterations: 120000,
  metadata: {
    archiveFormat: "polaris-native-archive",
    archiveVersion: 1,
    binaryBytes: 0,
    binaryCount: 0,
    createdAt: 1700,
    featureFlags: ["sqlite-canonical"],
    hasSecretBundle: false,
    hashAlgorithm: "sha256",
    objectCounts: { messages: 1 },
    plaintextByteCount: ciphertext.length,
    sourceName: "HTTP Smoke",
    sourcePlatform: "ios-native",
    warningCount: 0,
  },
  noncePrefixHex: "0011223344556677",
  saltHex: "00112233445566778899aabbccddeeff",
  version: 2,
};
const encodedHeader = Buffer.from(JSON.stringify(header));
const prefix = Buffer.alloc(12);
prefix.write("ARUEPKG2", 0, "ascii");
prefix.writeUInt32BE(encodedHeader.length, 8);
const length = Buffer.alloc(4);
length.writeUInt32BE(ciphertext.length, 0);
fs.writeFileSync(output, Buffer.concat([
  prefix,
  encodedHeader,
  length,
  ciphertext,
  Buffer.alloc(16, 0x5a),
]));
NODE
backup_sha="$(shasum -a 256 "$backup_package" | awk '{print $1}')"
backup_upload="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/backups" \
  -H "authorization: Bearer $credential" \
  -H 'content-type: application/vnd.aru.encrypted-backup' \
  -H 'x-aru-node-id: smoke-node' \
  -H 'x-aru-server-id: smoke-server' \
  -H 'x-aru-vault-package-id: smoke-package' \
  -H "x-aru-vault-package-sha256: $backup_sha" \
  --data-binary "@$backup_package")"
remote_backup_id="$(printf '%s' "$backup_upload" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const p=JSON.parse(b);if(!p.remotePackageId)process.exit(1);process.stdout.write(p.remotePackageId)
  });')"
curl -fsS "http://127.0.0.1:$port/aru/v1/backups" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b).packages?.[0];
        if(p?.metadata?.envelopeVersion!==2)process.exit(1);
        if(p?.metadata?.envelopeAlgorithm!=="AES-256-GCM-CHUNKED")process.exit(2);
        if(p?.metadata?.packageId!=="smoke-package")process.exit(3);
      });'
curl -fsS "http://127.0.0.1:$port/aru/v1/backups/$remote_backup_id" \
  -H "authorization: Bearer $credential" \
  -o "$data_dir/downloaded-backup.aruencpkg"
cmp "$backup_package" "$data_dir/downloaded-backup.aruencpkg"

curl -fsS "http://127.0.0.1:$port/aru/v1/backups/settings" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.schema!=="aru.selfhost.backup-settings.v1"||p.retentionMode!=="keep-all"||p.revision!==1)process.exit(1);
        if(p.keepLatestCount!==null||p.lastAppliedAt===null||p.lastDeletedCount!==0)process.exit(2)
      });'
curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/backups/settings" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.backup-settings.v1","retentionMode":"keep-latest","keepLatestCount":1,"expectedRevision":1}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.retentionMode!=="keep-latest"||p.keepLatestCount!==1||p.revision!==2)process.exit(1)
      });'
stale_backup_settings_status="$(curl -sS -o "$data_dir/stale-backup-settings.json" -w '%{http_code}' \
  -X PUT "http://127.0.0.1:$port/aru/v1/backups/settings" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.backup-settings.v1","retentionMode":"keep-all","keepLatestCount":null,"expectedRevision":1}')"
test "$stale_backup_settings_status" = "409"
grep -Fq 'backup.revision_conflict' "$data_dir/stale-backup-settings.json"

second_backup_package="$data_dir/streaming-backup-2.aruencpkg"
node - "$second_backup_package" <<'NODE'
const fs = require("node:fs");
const output = process.argv[2];
const ciphertext = Buffer.from("streamed-ciphertext-2");
const header = {
  algorithm: "AES-256-GCM-CHUNKED", chunkByteCount: 1048576, chunkCount: 1,
  format: "aru-native-encrypted-package", kdf: "PBKDF2-HMAC-SHA256", kdfIterations: 120000,
  metadata: {
    archiveFormat: "polaris-native-archive", archiveVersion: 1, binaryBytes: 0, binaryCount: 0,
    createdAt: 1800, featureFlags: ["sqlite-canonical"], hasSecretBundle: false,
    hashAlgorithm: "sha256", objectCounts: { messages: 2 }, plaintextByteCount: ciphertext.length,
    sourceName: "HTTP Smoke 2", sourcePlatform: "ios-native", warningCount: 0,
  },
  noncePrefixHex: "0011223344556677", saltHex: "00112233445566778899aabbccddeeff", version: 2,
};
const encodedHeader = Buffer.from(JSON.stringify(header));
const prefix = Buffer.alloc(12); prefix.write("ARUEPKG2", 0, "ascii"); prefix.writeUInt32BE(encodedHeader.length, 8);
const length = Buffer.alloc(4); length.writeUInt32BE(ciphertext.length, 0);
fs.writeFileSync(output, Buffer.concat([prefix, encodedHeader, length, ciphertext, Buffer.alloc(16, 0x5a)]));
NODE
second_backup_sha="$(shasum -a 256 "$second_backup_package" | awk '{print $1}')"
second_backup_upload="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/backups" \
  -H "authorization: Bearer $credential" \
  -H 'content-type: application/vnd.aru.encrypted-backup' \
  -H 'x-aru-node-id: smoke-node' \
  -H 'x-aru-server-id: smoke-server' \
  -H 'x-aru-vault-package-id: smoke-package-2' \
  -H "x-aru-vault-package-sha256: $second_backup_sha" \
  --data-binary "@$second_backup_package")"
second_remote_backup_id="$(printf '%s' "$second_backup_upload" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).remotePackageId??""));')"
test -n "$second_remote_backup_id"
curl -fsS "http://127.0.0.1:$port/aru/v1/backups" -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b).packages??[];
        if(p.length!==1||p[0]?.metadata?.packageId!=="smoke-package-2")process.exit(1)
      });'
retained_old_status="$(curl -sS -o "$data_dir/retained-old.json" -w '%{http_code}' \
  "http://127.0.0.1:$port/aru/v1/backups/$remote_backup_id" \
  -H "authorization: Bearer $credential")"
test "$retained_old_status" = "404"

plugin_supervisor_smoke_before_restart "http://127.0.0.1:$port" "$credential" "$data_dir"

curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/policy" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.schema!=="aru.selfhost.workspace-job-policy.v1"||p.defaultMaximumRuntimeSeconds!==86400)process.exit(1)
      });'

curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/jobs/policy" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-job-policy.v1","defaultMaximumRuntimeSeconds":1,"updatedAt":0}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.defaultMaximumRuntimeSeconds!==1||p.updatedAt<=0)process.exit(1)
      });'

escape_probe="$data_dir/state/escape.aruencpkg"
printf 'must-survive' > "$escape_probe"
escape_response="$data_dir/escape-response.json"
escape_status="$(curl --path-as-is -sS -o "$escape_response" -w '%{http_code}' \
  -X DELETE "http://127.0.0.1:$port/aru/v1/backups/..%2Fescape" \
  -H "authorization: Bearer $credential")"
test "$escape_status" = "400"
test "$(cat "$escape_probe")" = "must-survive"
grep -Fq 'package.id_invalid' "$escape_response"

if curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/mcp" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"unauthorized","method":"initialize","params":{}}' \
  >/dev/null 2>&1; then
  echo "MCP gateway accepted an unauthenticated request" >&2
  exit 1
fi

mcp_headers="$data_dir/mcp-headers"
mcp_initialize="$(curl -fsS -D "$mcp_headers" -X POST "http://127.0.0.1:$port/aru/v1/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $credential" \
  --data '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')"
mcp_session="$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/{gsub("\\r",""); print $2}' "$mcp_headers" | tail -1)"
test -n "$mcp_session"
grep -qi '^connection: close' "$mcp_headers"
printf '%s' "$mcp_initialize" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const r=JSON.parse(b);if(r.result?.capabilities?.tools===undefined)process.exit(1)
  });'

curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  -H "mcp-session-id: $mcp_session" \
  --data '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' >/dev/null

mcp_call_tool() {
  local tool_name="$1"
  local arguments_json="{}"
  [[ $# -lt 2 ]] || arguments_json="$2"
  node -e '
    const args=JSON.parse(process.argv[2]);
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:process.argv[1],method:"tools/call",params:{name:process.argv[1],arguments:args}}));
  ' "$tool_name" "$arguments_json" \
    | curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/mcp" \
        -H 'content-type: application/json' \
        -H "authorization: Bearer $credential" \
        -H "mcp-session-id: $mcp_session" \
        --data-binary @-
}

mcp_tools="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  -H "mcp-session-id: $mcp_session" \
  --data '{"jsonrpc":"2.0","id":"tools","method":"tools/list","params":{}}')"
printf '%s' "$mcp_tools" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const r=JSON.parse(b);const tools=r.result?.tools??[];const names=tools.map(t=>t.name);
    const expected=[
      "aru_node_status","aru_node_settings","aru_node_rename","aru_backup_inventory","aru_backup_settings","aru_backup_settings_update","aru_backup_delete","aru_paired_devices",
      "aru_node_workspace_inventory","aru_node_workspace_files","aru_node_workspace_read_text",
      "aru_node_workspace_write_text","aru_node_workspace_create_directory",
      "aru_node_workspace_move","aru_node_workspace_delete",
      "aru_job_inventory","aru_job_status","aru_job_events","aru_job_cancel","aru_job_retry",
      "aru_artifact_inventory","aru_artifact_delete",
      "aru_plugin_inventory","aru_plugin_workshop_guide","aru_plugin_source_validate",
      "aru_plugin_source_save_draft","aru_plugin_source_apply","aru_plugin_draft_inventory",
      "aru_plugin_status","aru_plugin_install","aru_plugin_enable",
      "aru_plugin_disable","aru_plugin_upgrade","aru_plugin_rollback","aru_plugin_uninstall",
      "aru_collaborator_surface_inventory","aru_collaborator_surface_read",
      "aru_collaborator_surface_publish","aru_collaborator_surface_publish_project",
      "aru_collaborator_surface_runtime","aru_collaborator_surface_events",
      "aru_collaborator_surface_rollback"
    ];
    if(expected.some(name=>!names.includes(name))||names.length!==expected.length)process.exit(1);
    if(tools.find(t=>t.name==="aru_job_cancel")?.annotations?.destructiveHint!==true)process.exit(2);
    if(tools.find(t=>t.name==="aru_plugin_inventory")?.annotations?.readOnlyHint!==true)process.exit(3);
    if(tools.find(t=>t.name==="aru_backup_delete")?.annotations?.destructiveHint!==true)process.exit(4);
    if(tools.find(t=>t.name==="aru_backup_settings")?.annotations?.readOnlyHint!==true)process.exit(11);
    if(tools.find(t=>t.name==="aru_node_workspace_inventory")?.annotations?.readOnlyHint!==true)process.exit(5);
    if(tools.find(t=>t.name==="aru_node_workspace_write_text")?.annotations?.destructiveHint!==true)process.exit(6);
    if(tools.find(t=>t.name==="aru_node_settings")?.annotations?.readOnlyHint!==true)process.exit(10);
    const workshop=tools.find(t=>t.name==="aru_plugin_source_validate")?.inputSchema;
    if(workshop?.properties?.permissions!==undefined||workshop?.properties?.resources!==undefined)process.exit(7);
    if(JSON.stringify(workshop?.properties?.capabilities?.items?.enum)!==JSON.stringify(["persistent-storage","network-outbound"]))process.exit(9);
    if(JSON.stringify(workshop?.required)!==JSON.stringify(["pluginId","displayName","version","sourceCode"]))process.exit(8);
  });'

mcp_call_tool "aru_node_settings" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const s=r.result?.structuredContent;
        if(r.result?.isError!==false||s?.displayName!=="Renamed Smoke Node"||s?.revision!==2)process.exit(1)
      });'
mcp_call_tool "aru_node_rename" '{"displayName":"MCP Renamed Smoke Node","expectedRevision":2}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const s=r.result?.structuredContent;
        if(r.result?.isError!==false||s?.displayName!=="MCP Renamed Smoke Node"||s?.revision!==3)process.exit(1)
      });'
mcp_call_tool "aru_backup_settings" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const s=r.result?.structuredContent;
        if(r.result?.isError!==false||s?.retentionMode!=="keep-latest"||s?.revision!==2)process.exit(1)
      });'
mcp_call_tool "aru_backup_settings_update" '{"retentionMode":"keep-all","keepLatestCount":null,"expectedRevision":2}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const s=r.result?.structuredContent;
        if(r.result?.isError!==false||s?.retentionMode!=="keep-all"||s?.revision!==3)process.exit(1)
      });'

mcp_call_tool "aru_node_workspace_inventory" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const w=r.result?.structuredContent?.workspaces??[];
        if(r.result?.isError!==false||w.length!==2||w[0]?.ownership!=="host-managed"||w[0]?.isDefault!==true)process.exit(1);
        if(w[1]?.displayName!=="Smoke Workspace"||w[1]?.ownership!=="user-granted")process.exit(2)
      });'
mcp_call_tool "aru_node_workspace_create_directory" "{\"workspaceId\":\"$managed_workspace_id\",\"path\":\"From MCP\"}" >/dev/null
test -d "$data_dir/managed-workspace/From MCP"
mcp_call_tool "aru_node_workspace_read_text" "{\"workspaceId\":\"$workspace_id\",\"path\":\"sub/note.txt\"}" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==false||r.result?.structuredContent?.content!=="hello")process.exit(1)
      });'
mcp_call_tool "aru_node_workspace_write_text" "{\"workspaceId\":\"$workspace_id\",\"path\":\"sub/mcp.txt\",\"content\":\"model text\"}" >/dev/null
test "$(cat "$authorized_root/sub/mcp.txt")" = "model text"

mcp_call_tool "aru_plugin_workshop_guide" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const g=r.result?.structuredContent;
        if(r.result?.isError!==false||g?.schema!=="aru.selfhost.plugin-workshop-guide.v1"||!g.example?.includes("callTool")||g.requestDefaults?.authority!=="zero")process.exit(1)
      });'

minimal_source_plugin_args="$(node -e '
  const source = `export const tools = [{
    name: "ping", title: "Ping", description: "Return pong.",
    inputSchema: { type: "object", properties: {} },
  }];
  export async function callTool() { return { pong: true }; }`;
  process.stdout.write(JSON.stringify({
    pluginId: "workshop.minimal", displayName: "Workshop Minimal", version: "1.0.0",
    sourceCode: source,
  }));
')"
mcp_call_tool "aru_plugin_source_validate" "$minimal_source_plugin_args" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const v=r.result?.structuredContent;
        if(r.result?.isError!==false||v?.tools?.[0]?.name!=="ping")process.exit(1)
      });'
mcp_call_tool "aru_plugin_source_save_draft" "$minimal_source_plugin_args" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const d=r.result?.structuredContent;
        if(r.result?.isError!==false||d?.pluginId!=="workshop.minimal"||d?.sourceCode!==undefined||d?.target!=="create")process.exit(1)
      });'
mcp_call_tool "aru_plugin_draft_inventory" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const d=r.result?.structuredContent?.drafts?.[0];
        if(r.result?.isError!==false||d?.pluginId!=="workshop.minimal"||d?.tools?.[0]?.name!=="ping")process.exit(1)
      });'
curl -fsS "http://127.0.0.1:$port/aru/v1/plugin-workshop/drafts/workshop.minimal" \
  -H "authorization: Bearer $credential" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const d=JSON.parse(b);if(!d.sourceCode?.includes("callTool")||d.digest?.startsWith("sha256:")!==true)process.exit(1)})'
curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/plugin-workshop/drafts/workshop.minimal/apply" \
  -H "authorization: Bearer $credential" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.plugin?.health!=="running"||r.plugin?.desiredState!=="enabled")process.exit(1)})'
curl -fsS -X DELETE "http://127.0.0.1:$port/aru/v1/plugins/workshop.minimal?deleteData=true" \
  -H "authorization: Bearer $credential" >/dev/null

source_plugin_args="$(node -e '
  const source = `import { readFileSync } from "node:fs";
  import { spawnSync } from "node:child_process";
  export const tools = [{
    name: "echo_text", title: "Echo text", description: "Return the supplied text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  }, {
    name: "probe_host", title: "Probe host", description: "Security smoke probe for forbidden host reads.",
    inputSchema: { type: "object", properties: {} },
  }, {
    name: "probe_child", title: "Probe child", description: "Security smoke probe for forbidden child processes.",
    inputSchema: { type: "object", properties: {} },
  }, {
    name: "probe_environment", title: "Probe environment", description: "Security smoke probe for inherited host environment.",
    inputSchema: { type: "object", properties: {} },
  }];
  export async function callTool(name, args) {
    if (name === "echo_text") return { echoed: args.text };
    if (name === "probe_host") return { value: readFileSync("/etc/passwd", "utf8") };
    if (name === "probe_child") return { status: spawnSync("true").status };
    if (name === "probe_environment") return { leaked: process.env.ARU_SMOKE_SECRET ?? null };
    throw new Error("unknown tool");
  }`;
  process.stdout.write(JSON.stringify({
    pluginId: "workshop.echo", displayName: "Workshop Echo", version: "1.0.0",
    sourceCode: source,
  }));
')"
mcp_call_tool "aru_plugin_source_validate" "$source_plugin_args" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const v=r.result?.structuredContent;
        if(r.result?.isError!==false||!/^sha256:[0-9a-f]{64}$/.test(v?.digest??"")||v?.tools?.[0]?.name!=="echo_text")process.exit(1)
      });'
curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/plugin-workshop/validate" \
  -H 'content-type: application/json' -H "authorization: Bearer $credential" \
  --data "$source_plugin_args" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.tools?.[0]?.name!=="echo_text")process.exit(1)})'
curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/plugin-workshop/apply" \
  -H 'content-type: application/json' -H "authorization: Bearer $credential" \
  --data "$source_plugin_args" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const p=r.plugin;
        if(p?.manifest?.packageMode!=="source-node"||p?.desiredState!=="enabled"||p?.health!=="running")process.exit(1)
      });'
curl -fsS "http://127.0.0.1:$port/aru/v1/plugins/workshop.echo/source" \
  -H "authorization: Bearer $credential" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const s=JSON.parse(b);if(s.pluginId!=="workshop.echo"||!s.sourceCode?.includes("echo_text")||s.tools?.length!==4)process.exit(1)})'

dynamic_tools="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/mcp" \
  -H 'content-type: application/json' -H "authorization: Bearer $credential" \
  -H "mcp-session-id: $mcp_session" \
  --data '{"jsonrpc":"2.0","id":"dynamic-tools","method":"tools/list","params":{}}')"
printf '%s' "$dynamic_tools" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const t=JSON.parse(b).result?.tools?.find(x=>x.name==="plugin__workshop_echo__echo_text");
    if(!t||t.annotations?.destructiveHint!==true||t.annotations?.openWorldHint!==true)process.exit(1)
  });'
mcp_call_tool "plugin__workshop_echo__echo_text" '{"text":"hello"}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==false||r.result?.structuredContent?.echoed!=="hello")process.exit(1)
      });'
mcp_call_tool "plugin__workshop_echo__probe_host" '{}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==true||r.result?.structuredContent?.code!=="plugin.code_error")process.exit(1)
      });'
mcp_call_tool "plugin__workshop_echo__probe_child" '{}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==true||r.result?.structuredContent?.code!=="plugin.code_error")process.exit(1)
      });'
mcp_call_tool "plugin__workshop_echo__probe_environment" '{}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==false||r.result?.structuredContent?.leaked!==null)process.exit(1)
      });'

source_counter_args="$(node -e '
  const source = `import { readFileSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  export const tools = [{
    name: "increment", title: "Increment", description: "Increment isolated persistent state.",
    inputSchema: { type: "object", properties: {} },
  }];
  export async function callTool(name, args, context) {
    if (name !== "increment") throw new Error("unknown tool");
    const file = join(context.dataDirectory, "count.txt");
    let count = 0;
    try { count = Number(readFileSync(file, "utf8")); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    count += 1;
    writeFileSync(file, String(count));
    return { count };
  }`;
  process.stdout.write(JSON.stringify({
    pluginId: "workshop.counter", displayName: "Workshop Counter", version: "1.0.0",
    sourceCode: source,
    capabilities: ["persistent-storage"],
  }));
')"
mcp_call_tool "aru_plugin_source_apply" "$source_counter_args" >/dev/null
mcp_call_tool "plugin__workshop_counter__increment" '{}' \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.result?.structuredContent?.count!==1)process.exit(1)})'
mcp_call_tool "plugin__workshop_counter__increment" '{}' \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.result?.structuredContent?.count!==2)process.exit(1)})'

mcp_call="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/mcp" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  -H "mcp-session-id: $mcp_session" \
  --data '{"jsonrpc":"2.0","id":"call","method":"tools/call","params":{"name":"aru_node_status","arguments":{}}}')"
printf '%s' "$mcp_call" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const r=JSON.parse(b);if(!r.result?.structuredContent?.serverId||r.result?.isError!==false)process.exit(1)
  });'
if printf '%s' "$mcp_call" | grep -Fq "$credential"; then
  echo "credential leaked into MCP response" >&2
  exit 1
fi

mcp_call_tool "aru_backup_delete" '{"remotePackageId":"missing-backup"}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==true||r.result?.structuredContent?.code!=="package.unknown")process.exit(1)
      });'

mcp_call_tool "aru_plugin_inventory" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const plugins=r.result?.structuredContent?.plugins??[];
        if(r.result?.isError!==false||!plugins.some(p=>p.pluginId==="memory.example"&&p.health==="running"))process.exit(1)
      });'

mcp_call_tool "aru_plugin_status" '{}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==true||r.result?.structuredContent?.code!=="mcp.argument_missing")process.exit(1)
      });'

mcp_call_tool "aru_plugin_disable" '{"pluginId":"memory.example"}' \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.result?.structuredContent?.health!=="disabled")process.exit(1)})'
mcp_call_tool "aru_plugin_enable" '{"pluginId":"memory.example"}' \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.result?.structuredContent?.health!=="running")process.exit(1)})'

plugin_v1_mcp_args="$(plugin_supervisor_request "$PLUGIN_SUPERVISOR_MANIFEST_V1" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);delete r.schema;process.stdout.write(JSON.stringify(r))})')"
mcp_call_tool "aru_plugin_install" "$plugin_v1_mcp_args" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==true||r.result?.structuredContent?.code!=="plugin.already_installed")process.exit(1)
      });'

plugin_v2_mcp_args="$(plugin_supervisor_request "$PLUGIN_SUPERVISOR_MANIFEST_V2" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);delete r.schema;r.pluginId="memory.example";process.stdout.write(JSON.stringify(r))})')"
mcp_call_tool "aru_plugin_upgrade" "$plugin_v2_mcp_args" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==false||r.result?.structuredContent?.manifest?.version!=="2.0.0")process.exit(1)
      });'
mcp_call_tool "aru_plugin_rollback" '{"pluginId":"memory.example"}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==false||r.result?.structuredContent?.manifest?.version!=="1.0.0")process.exit(1)
      });'

submitted_job="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/jobs" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-run.v1","runId":"smoke-run","projectId":"smoke-project","runtime":"node","entryPath":"main.js","code":null,"inputJSON":"{}","files":[{"path":"main.js","content":"console.log(1)","language":"javascript"}]}')"
job_id="$(printf '%s' "$submitted_job" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const j=JSON.parse(b);if(j.schema!=="aru.selfhost.workspace-job.v1"||j.state!=="queued")process.exit(1);process.stdout.write(j.jobId)
  });')"

result=""
for _ in {1..100}; do
  job="$(curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/$job_id" \
    -H "authorization: Bearer $credential")"
  state="$(printf '%s' "$job" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).state))')"
  if [[ "$state" == "succeeded" ]]; then
    result="$(printf '%s' "$job" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(b).result)))')"
    break
  fi
  [[ "$state" != "failed" && "$state" != "cancelled" ]] || exit 1
  sleep 0.05
done
test -n "$result"

curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/$job_id/events" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const e=JSON.parse(b);const kinds=e.events?.map(v=>v.kind)??[];
        if(e.schema!=="aru.selfhost.workspace-job-events.v1"||!kinds.includes("queued")||!kinds.includes("running")||!kinds.includes("succeeded"))process.exit(1)
      });'

curl -fsS "http://127.0.0.1:$port/aru/v1/jobs" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const i=JSON.parse(b);if(i.schema!=="aru.selfhost.workspace-job-inventory.v1"||i.jobs?.length!==1||i.jobs[0]?.result!==null)process.exit(1)
      });'

mcp_call_tool "aru_job_inventory" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const jobs=r.result?.structuredContent?.jobs??[];
        if(r.result?.isError!==false||!jobs.some(j=>j.jobId===process.argv[1]&&j.result===null))process.exit(1)
      });' "$job_id"
mcp_call_tool "aru_job_status" "{\"jobId\":\"$job_id\"}" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const j=r.result?.structuredContent;
        if(r.result?.isError!==false||j?.jobId!==process.argv[1]||j?.result?.runId!=="smoke-run"||"input" in j)process.exit(1)
      });' "$job_id"
mcp_call_tool "aru_job_events" "{\"jobId\":\"$job_id\"}" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const kinds=r.result?.structuredContent?.events?.map(e=>e.kind)??[];
        if(r.result?.isError!==false||!kinds.includes("queued")||!kinds.includes("succeeded"))process.exit(1)
      });'

printf '%s' "$result" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const r=JSON.parse(b);
    if(r.schema!=="aru.selfhost.workspace-result.v1")process.exit(1);
    if(r.runId!=="smoke-run"||r.exitCode!==0)process.exit(2);
    if(r.files?.[0]?.path!=="main.js")process.exit(3);
    if(r.artifacts?.length!==1||r.artifacts[0]?.filename!=="output.png")process.exit(4);
    if(!/^[0-9a-f]{64}$/.test(r.artifacts[0]?.sha256??""))process.exit(5);
  });'

if printf '%s' "$result" | grep -Fq "$credential"; then
  echo "credential leaked into workspace response" >&2
  exit 1
fi

temporary_code_job="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/jobs" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-run.v1","runId":"temporary-code-run","projectId":"smoke-project","runtime":"node","entryPath":null,"code":"console.log(1)","inputJSON":"{}","files":[]}')"
temporary_code_job_id="$(printf '%s' "$temporary_code_job" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).jobId??""))')"
for _ in {1..100}; do
  temporary_code_snapshot="$(curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/$temporary_code_job_id" \
    -H "authorization: Bearer $credential")"
  temporary_code_state="$(printf '%s' "$temporary_code_snapshot" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).state??""))')"
  [[ "$temporary_code_state" != "succeeded" ]] || break
  [[ "$temporary_code_state" != "failed" && "$temporary_code_state" != "cancelled" && "$temporary_code_state" != "timed_out" ]] || exit 1
  sleep 0.05
done
test "$temporary_code_state" = "succeeded"
printf '%s' "$temporary_code_snapshot" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const j=JSON.parse(b);if(j.result?.files?.some(file=>file.path.startsWith(".aru-runtime-")))process.exit(1)
  });'

reserved_path_status="$(curl -sS -o "$data_dir/reserved-path.json" -w '%{http_code}' \
  -X POST "http://127.0.0.1:$port/aru/v1/jobs" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-run.v1","runId":"reserved-path-run","projectId":"smoke-project","runtime":"node","entryPath":".aru-runtime-user.mjs","code":null,"inputJSON":"{}","files":[{"path":".aru-runtime-user.mjs","content":"console.log(1)","language":"javascript"}]}')"
test "$reserved_path_status" = "400"
grep -Fq 'workspace.path_invalid' "$data_dir/reserved-path.json"

timed_job="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/jobs" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-run.v1","runId":"timed-run","projectId":"smoke-project","runtime":"node","entryPath":"main.js","code":null,"inputJSON":"{}","files":[{"path":"main.js","content":"console.log(1)","language":"javascript"},{"path":"slow.flag","content":"yes","language":"text"}]}')"
timed_job_id="$(printf '%s' "$timed_job" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).jobId))')"
for _ in {1..160}; do
  timed_snapshot="$(curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/$timed_job_id" \
    -H "authorization: Bearer $credential")"
  timed_state="$(printf '%s' "$timed_snapshot" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).state))')"
  [[ "$timed_state" != "timed_out" ]] || break
  sleep 0.05
done
test "$timed_state" = "timed_out"
printf '%s' "$timed_snapshot" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const j=JSON.parse(b);
    if(j.maximumRuntimeSeconds!==1||j.budgetSource!=="node_default")process.exit(1);
    if(j.deadlineAt!==j.startedAt+1000||j.failureCode!=="workspace.execution_timed_out")process.exit(2);
    if(j.result?.exitCode!==124)process.exit(3)
  });'

curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/jobs/policy" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-job-policy.v1","defaultMaximumRuntimeSeconds":null,"updatedAt":0}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.defaultMaximumRuntimeSeconds!==null||p.updatedAt<=0)process.exit(1)
      });'

unlimited_job="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/jobs" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-run.v1","runId":"unlimited-run","projectId":"smoke-project","runtime":"node","entryPath":"main.js","code":null,"inputJSON":"{}","files":[{"path":"main.js","content":"console.log(1)","language":"javascript"}]}')"
unlimited_job_id="$(printf '%s' "$unlimited_job" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const j=JSON.parse(b);
    if(j.maximumRuntimeSeconds!==null||j.budgetSource!=="node_unlimited"||j.deadlineAt!==null)process.exit(1);
    process.stdout.write(j.jobId)
  });')"
for _ in {1..100}; do
  unlimited_snapshot="$(curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/$unlimited_job_id" \
    -H "authorization: Bearer $credential")"
  unlimited_state="$(printf '%s' "$unlimited_snapshot" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).state))')"
  [[ "$unlimited_state" != "succeeded" ]] || break
  [[ "$unlimited_state" != "failed" && "$unlimited_state" != "cancelled" && "$unlimited_state" != "timed_out" ]] || exit 1
  sleep 0.05
done
test "$unlimited_state" = "succeeded"
printf '%s' "$unlimited_snapshot" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const j=JSON.parse(b);
    if(j.maximumRuntimeSeconds!==null||j.budgetSource!=="node_unlimited"||j.deadlineAt!==null)process.exit(1)
  });'

curl -fsS -X PUT "http://127.0.0.1:$port/aru/v1/jobs/policy" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-job-policy.v1","defaultMaximumRuntimeSeconds":86400,"updatedAt":0}' \
  >/dev/null

slow_job="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/jobs" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-run.v1","runId":"slow-run","projectId":"smoke-project","runtime":"node","entryPath":"main.js","code":null,"inputJSON":"{}","files":[{"path":"main.js","content":"console.log(1)","language":"javascript"},{"path":"slow.flag","content":"yes","language":"text"}]}')"
slow_job_id="$(printf '%s' "$slow_job" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).jobId))')"
for _ in {1..100}; do
  slow_state="$(curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/$slow_job_id" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).state))')"
  [[ "$slow_state" != "running" ]] || break
  sleep 0.05
done
test "$slow_state" = "running"
mcp_call_tool "aru_job_cancel" "{\"jobId\":\"$slow_job_id\"}" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const j=r.result?.structuredContent;
        if(r.result?.isError!==false||j?.state!=="cancelled"||j?.completedAt===null)process.exit(1)
      });'

failed_job="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/jobs" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"schema":"aru.selfhost.workspace-run.v1","runId":"failed-run","projectId":"smoke-project","runtime":"node","entryPath":"main.js","code":null,"inputJSON":"{}","files":[{"path":"main.js","content":"process.exit(7)","language":"javascript"},{"path":"fail.flag","content":"yes","language":"text"}]}')"
failed_job_id="$(printf '%s' "$failed_job" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).jobId))')"
for _ in {1..100}; do
  failed_state="$(curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/$failed_job_id" \
    -H "authorization: Bearer $credential" \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).state))')"
  [[ "$failed_state" != "failed" ]] || break
  sleep 0.05
done
test "$failed_state" = "failed"
retry_job="$(mcp_call_tool "aru_job_retry" "{\"jobId\":\"$failed_job_id\"}")"
printf '%s' "$retry_job" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const r=JSON.parse(b);const j=r.result?.structuredContent;
    if(r.result?.isError!==false||j?.state!=="queued"||j?.predecessorJobId!==process.argv[1]||j?.jobId===process.argv[1])process.exit(1)
  });' "$failed_job_id"

artifact_id="$(printf '%s' "$result" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const r=JSON.parse(b);process.stdout.write(r.artifacts[0].artifactId)
  });')"
artifact_sha256="$(printf '%s' "$result" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const r=JSON.parse(b);process.stdout.write(r.artifacts[0].sha256)
  });')"

if curl -fsS "http://127.0.0.1:$port/aru/v1/artifacts" >/dev/null 2>&1; then
  echo "artifact inventory accepted an unauthenticated request" >&2
  exit 1
fi

inventory="$(curl -fsS "http://127.0.0.1:$port/aru/v1/artifacts" \
  -H "authorization: Bearer $credential")"
printf '%s' "$inventory" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const r=JSON.parse(b);if(!r.artifacts?.some(a=>a.artifactId===process.argv[1]))process.exit(1)
  });' "$artifact_id"

mcp_call_tool "aru_artifact_inventory" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);const artifacts=r.result?.structuredContent?.artifacts??[];
        if(r.result?.isError!==false||!artifacts.some(a=>a.artifactId===process.argv[1]))process.exit(1)
      });' "$artifact_id"

artifact_file="$data_dir/downloaded-artifact"
artifact_headers="$data_dir/artifact-headers"
curl -fsS -D "$artifact_headers" "http://127.0.0.1:$port/aru/v1/artifacts/$artifact_id" \
  -H "authorization: Bearer $credential" \
  -o "$artifact_file"
test "$(shasum -a 256 "$artifact_file" | awk '{print $1}')" = "$artifact_sha256"
grep -Eiq "^x-aru-artifact-sha256: $artifact_sha256" "$artifact_headers"

mcp_call_tool "aru_artifact_delete" "{\"artifactId\":\"$artifact_id\"}" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.result?.isError!==false||r.result?.structuredContent?.deleted!==true)process.exit(1)
      });'
curl -fsS "http://127.0.0.1:$port/aru/v1/artifacts" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const r=JSON.parse(b);if(r.artifacts?.some(a=>a.artifactId===process.argv[1]))process.exit(1)
      });' "$artifact_id"

kill "$pid"
wait "$pid" >/dev/null 2>&1 || true
pid=""
node - "$data_dir/state/state.json" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = process.argv[2];
const state = JSON.parse(fs.readFileSync(path, "utf8"));
const restartStartedAt = Date.now() - 1;
state.devices.push({
  deviceId: "dev_revocation_probe",
  label: "Revocation Probe",
  credentialSHA256: crypto.createHash("sha256").update("revocation-probe-secret").digest("hex"),
  issuedAt: Date.now(),
  revokedAt: null,
});
state.jobs.push({
  schema: "aru.selfhost.workspace-job.v1",
  jobId: "job_restart_probe",
  runId: "restart-run",
  projectId: "smoke-project",
  runtime: "node",
  state: "running",
  predecessorJobId: null,
  queuedAt: Date.now() - 2,
  startedAt: restartStartedAt,
  completedAt: null,
  exitCode: null,
  failureCode: null,
  failureMessage: null,
  result: null,
  maximumRuntimeSeconds: 86400,
  budgetSource: "node_default",
  deadlineAt: restartStartedAt + 86400 * 1000,
  input: { schema: "aru.selfhost.workspace-run.v1", runId: "restart-run", projectId: "smoke-project", runtime: "node", entryPath: "main.js", code: null, inputJSON: "{}", files: [{ path: "main.js", content: "", language: "javascript" }] },
  inputHash: "restart-probe",
  createdByDeviceId: "restart-probe",
  cancelledByDeviceId: null,
  events: [{ sequence: 1, kind: "running", at: Date.now() - 1, message: "probe" }]
});
state.jobs.push({
  schema: "aru.selfhost.workspace-job.v1",
  jobId: "job_restart_expired",
  runId: "restart-expired-run",
  projectId: "smoke-project",
  runtime: "node",
  state: "running",
  predecessorJobId: null,
  queuedAt: Date.now() - 3000,
  startedAt: Date.now() - 2000,
  completedAt: null,
  exitCode: null,
  failureCode: null,
  failureMessage: null,
  result: null,
  maximumRuntimeSeconds: 1,
  budgetSource: "node_default",
  deadlineAt: Date.now() - 1000,
  input: { schema: "aru.selfhost.workspace-run.v1", runId: "restart-expired-run", projectId: "smoke-project", runtime: "node", entryPath: "main.js", code: null, inputJSON: "{}", files: [{ path: "main.js", content: "", language: "javascript" }] },
  inputHash: "restart-expired-probe",
  createdByDeviceId: "restart-probe",
  cancelledByDeviceId: null,
  events: [{ sequence: 1, kind: "running", at: Date.now() - 2000, message: "probe" }]
});
state.jobs.push({
  schema: "aru.selfhost.workspace-job.v1",
  jobId: "job_restart_queued",
  runId: "restart-queued-run",
  projectId: "smoke-project",
  runtime: "node",
  state: "queued",
  predecessorJobId: null,
  queuedAt: Date.now() - 60000,
  startedAt: null,
  completedAt: null,
  exitCode: null,
  failureCode: null,
  failureMessage: null,
  result: null,
  maximumRuntimeSeconds: 86400,
  budgetSource: "node_default",
  deadlineAt: null,
  input: { schema: "aru.selfhost.workspace-run.v1", runId: "restart-queued-run", projectId: "smoke-project", runtime: "node", entryPath: "main.js", code: null, inputJSON: "{}", files: [{ path: "main.js", content: "", language: "javascript" }] },
  inputHash: "restart-queued-probe",
  createdByDeviceId: "restart-probe",
  cancelledByDeviceId: null,
  events: [{ sequence: 1, kind: "queued", at: Date.now() - 60000, message: "probe" }]
});
fs.writeFileSync(path, JSON.stringify(state, null, 2));
NODE

ARU_SELFHOST_CONFIG_FILE="$config_file" "$SELFHOST_DIR/run-node.sh" >>"$log_file" 2>&1 &
pid=$!
for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:$port/.well-known/aru.json" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
plugin_supervisor_smoke_after_restart "http://127.0.0.1:$port" "$credential"
curl -fsS "http://127.0.0.1:$port/aru/v1/backups/settings" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.retentionMode!=="keep-all"||p.revision!==3)process.exit(1)
      });'
curl -fsS "http://127.0.0.1:$port/.well-known/aru.json" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);if(p.displayName!=="MCP Renamed Smoke Node")process.exit(1)
      });'
curl -fsS "http://127.0.0.1:$port/aru/v1/devices" \
  -H 'authorization: Bearer revocation-probe-secret' >/dev/null
curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/devices/revoke" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $credential" \
  --data '{"deviceId":"dev_revocation_probe"}' \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.schema!=="aru.selfhost.device-revocation.v1"||p.deviceId!=="dev_revocation_probe")process.exit(1)
      });'
revoked_probe_status="$(curl -sS -o "$data_dir/revoked-probe.json" -w '%{http_code}' \
  "http://127.0.0.1:$port/aru/v1/devices" \
  -H 'authorization: Bearer revocation-probe-secret')"
test "$revoked_probe_status" = "403"
grep -Fq 'credential.revoked' "$data_dir/revoked-probe.json"
curl -fsS "http://127.0.0.1:$port/aru/v1/hosted-collaborators/$hosted_collaborator_id" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);
        if(p.displayName!=="Computer Aru Renamed"||p.driverId!=="claude-code"||p.revision!==2)process.exit(1);
        if(p.toolAccess?.mode!=="selected"||p.toolAccess?.toolNames?.length!==2)process.exit(2);
      });'
curl -fsS "http://127.0.0.1:$port/aru/v1/plugins/workshop.echo" \
  -H "authorization: Bearer $credential" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const p=JSON.parse(b);if(p.desiredState!=="enabled"||p.health!=="running")process.exit(1)})'
for _ in {1..100}; do
  restart_snapshot="$(curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/job_restart_probe" \
    -H "authorization: Bearer $credential")"
  restart_state="$(printf '%s' "$restart_snapshot" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).state))')"
  [[ "$restart_state" != "succeeded" ]] || break
  sleep 0.05
done
test "$restart_state" = "succeeded"
printf '%s' "$restart_snapshot" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const j=JSON.parse(b);
    if(j.maximumRuntimeSeconds!==86400||j.deadlineAt!==j.startedAt+86400000)process.exit(1)
  });'

for _ in {1..100}; do
  queued_restart_snapshot="$(curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/job_restart_queued" \
    -H "authorization: Bearer $credential")"
  queued_restart_state="$(printf '%s' "$queued_restart_snapshot" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(b).state))')"
  [[ "$queued_restart_state" != "succeeded" ]] || break
  sleep 0.05
done
test "$queued_restart_state" = "succeeded"
printf '%s' "$queued_restart_snapshot" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const j=JSON.parse(b);
    if(j.startedAt===null||j.deadlineAt!==j.startedAt+86400000)process.exit(1)
  });'

curl -fsS "http://127.0.0.1:$port/aru/v1/jobs/job_restart_expired" \
  -H "authorization: Bearer $credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const j=JSON.parse(b);
        if(j.state!=="timed_out"||j.failureCode!=="workspace.execution_timed_out"||j.completedAt===null)process.exit(1)
      });'

curl -fsS -X DELETE "http://127.0.0.1:$port/aru/v1/plugins/workshop.echo?deleteData=true" \
  -H "authorization: Bearer $credential" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.pluginId!=="workshop.echo"||r.dataDeleted!==true)process.exit(1)})'
curl -fsS -X DELETE "http://127.0.0.1:$port/aru/v1/plugins/workshop.counter?deleteData=true" \
  -H "authorization: Bearer $credential" \
  | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);if(r.pluginId!=="workshop.counter"||r.dataDeleted!==true)process.exit(1)})'
plugin_supervisor_smoke_uninstall "http://127.0.0.1:$port" "$credential"

kill "$pid"
wait "$pid" >/dev/null 2>&1 || true
pid=""
ARU_SELFHOST_CONFIG_FILE="$config_file" "$SELFHOST_DIR/run-node.sh" >>"$log_file" 2>&1 &
pid=$!
for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:$port/.well-known/aru.json" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
replacement_pairing_url="$(grep -E '^aru://pair\?' "$log_file" | tail -1)"
replacement_pairing_token="$(node -e 'process.stdout.write(new URL(process.argv[1]).searchParams.get("pairingToken") ?? "")' "$replacement_pairing_url")"
replacement_grant="$(curl -fsS -X POST "http://127.0.0.1:$port/aru/v1/pair" \
  -H 'content-type: application/json' \
  --data "{\"pairingToken\":\"$replacement_pairing_token\",\"deviceLabel\":\"installer-smoke-replacement\",\"deviceRole\":\"host-console\"}")"
replacement_credential="$(printf '%s' "$replacement_grant" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const g=JSON.parse(b);if(!g.credentialSecret)process.exit(1);process.stdout.write(g.credentialSecret)
  });')"
replaced_console_status="$(curl -sS -o "$data_dir/replaced-console.json" -w '%{http_code}' \
  "http://127.0.0.1:$port/aru/v1/devices" \
  -H "authorization: Bearer $credential")"
test "$replaced_console_status" = "403"
grep -Fq 'credential.revoked' "$data_dir/replaced-console.json"
curl -fsS "http://127.0.0.1:$port/aru/v1/devices" \
  -H "authorization: Bearer $replacement_credential" \
  | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
        const p=JSON.parse(b);const active=p.devices.filter(d=>d.revokedAt===null);
        if(active.length!==1||active[0].label!=="installer-smoke-replacement"||active[0].isCurrent!==true)process.exit(1)
      });'

echo "ARU_SELFHOST_HTTP_SMOKE_OK"
