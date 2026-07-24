#!/usr/bin/env bash
set -Eeuo pipefail

SELFHOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(mktemp -d)"
artifacts="$(mktemp -d)"
installed_pid=""
cleanup() {
  [[ -z "$installed_pid" ]] || kill "$installed_pid" >/dev/null 2>&1 || true
  [[ -z "$installed_pid" ]] || wait "$installed_pid" >/dev/null 2>&1 || true
  rm -rf "$root" "$artifacts"
}
trap cleanup EXIT

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

for file in install.sh run-node.sh aru-selfhostctl package-release.sh; do
  bash -n "$SELFHOST_DIR/$file"
done

bash "$SELFHOST_DIR/install.sh" \
  --root "$root" \
  --source-dir "$SELFHOST_DIR" \
  --base-url "http://100.64.0.10:8787" \
  --transport-kind tailscale \
  --display-name "AA Test Node" \
  --node-image "mirror.example/node@sha256:node" \
  --python-image "mirror.example/python@sha256:python" \
  --shell-image "mirror.example/alpine@sha256:shell"

test -x "$root/usr/local/bin/aru-selfhost"
test -x "$root/opt/aru-selfhost/current/server.mjs"
test -f "$root/opt/aru-selfhost/current/plugin-supervisor.mjs"
test -f "$root/opt/aru-selfhost/current/plugin-workshop.mjs"
test -f "$root/opt/aru-selfhost/current/collaborator-host.mjs"
test -f "$root/opt/aru-selfhost/current/collaborator-surface-bundles.mjs"
test -f "$root/opt/aru-selfhost/current/collaborator-surfaces.mjs"
test -f "$root/opt/aru-selfhost/current/collaborator-conversations.mjs"
test -f "$root/opt/aru-selfhost/current/collaborator-initiative.mjs"
test -f "$root/opt/aru-selfhost/current/collaborator-projects.mjs"
test -f "$root/opt/aru-selfhost/current/apns-push.mjs"
test -f "$root/opt/aru-selfhost/current/codex-app-server-driver.mjs"
test -f "$root/opt/aru-selfhost/current/collaborator-cognition.mjs"
test -f "$root/opt/aru-selfhost/current/direct-api-driver.mjs"
test -f "$root/opt/aru-selfhost/current/provider-profiles.mjs"
test -f "$root/opt/aru-selfhost/current/provider-secret-store.mjs"
test -f "$root/opt/aru-selfhost/current/backup-settings.mjs"
test -f "$root/opt/aru-selfhost/current/conversation-turn-relay.mjs"
test -f "$root/opt/aru-selfhost/current/node-control.mjs"
test -f "$root/opt/aru-selfhost/current/node-workspaces.mjs"
test -f "$root/opt/aru-selfhost/current/source-plugin-runtime.mjs"
test -f "$root/opt/aru-selfhost/current/source-plugin-runner.mjs"
test -x "$root/opt/aru-selfhost/current/run-node.sh"
test -f "$root/etc/systemd/system/aru-selfhost.service"
test -f "$root/etc/aru-selfhost/node.env"
test -f "$root/etc/aru-selfhost/install.env"
test -f "$root/etc/aru-selfhost/containers.conf"
test "$(file_mode "$root/etc/aru-selfhost/node.env")" = "640"
test "$(file_mode "$root/etc/aru-selfhost/install.env")" = "600"
test "$(file_mode "$root/etc/aru-selfhost/containers.conf")" = "644"
grep -Fq 'cgroup_manager = "cgroupfs"' "$root/etc/aru-selfhost/containers.conf"
grep -Fq 'CONTAINERS_CONF=/etc/aru-selfhost/containers.conf' "$root/etc/systemd/system/aru-selfhost.service"
grep -Fq '/usr/libexec/podman:/usr/libexec/catatonit' "$root/etc/systemd/system/aru-selfhost.service"
grep -Fq 'ARU_BASE_URL=http://100.64.0.10:8787' "$root/etc/aru-selfhost/node.env"
grep -Fq 'ARU_LISTEN_HOST=0.0.0.0' "$root/etc/aru-selfhost/node.env"
grep -Fq 'ARU_TRANSPORT_KIND=tailscale' "$root/etc/aru-selfhost/node.env"
grep -Fq 'ARU_INSTALL_PROFILE=full' "$root/etc/aru-selfhost/install.env"
grep -Fq 'ARU_NODE_IMAGE=mirror.example/node@sha256:node' "$root/etc/aru-selfhost/node.env"
grep -Fq 'ARU_INSTALL_PYTHON_IMAGE=mirror.example/python@sha256:python' "$root/etc/aru-selfhost/install.env"
grep -Fq 'AA\ Test\ Node' "$root/etc/aru-selfhost/node.env"

installed_port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
ARU_FAKE_RUNTIME_STATE_DIR="$artifacts/installed-runtime" \
  node "$root/opt/aru-selfhost/current/server.mjs" \
    --listen-host 127.0.0.1 \
    --port "$installed_port" \
    --data-dir "$artifacts/installed-state" \
    --base-url "http://127.0.0.1:$installed_port" \
    --container-runtime "$SELFHOST_DIR/tests/fake-container-runtime.sh" \
    >"$artifacts/installed-server.log" 2>&1 &
installed_pid=$!
for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:$installed_port/.well-known/aru.json" \
    2>/dev/null | grep -Fq '"plugin-supervisor"'; then
    break
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$installed_port/.well-known/aru.json" \
  | grep -Fq '"plugin-supervisor"'
kill "$installed_pid"
wait "$installed_pid" >/dev/null 2>&1 || true
installed_pid=""

first_release="$(readlink "$root/opt/aru-selfhost/current")"
bash "$SELFHOST_DIR/install.sh" \
  --root "$root" \
  --source-dir "$SELFHOST_DIR" \
  --base-url "http://100.64.0.10:8787" \
  --transport-kind tailscale \
  --display-name "AA Test Node" \
  --node-image "mirror.example/node@sha256:node" \
  --python-image "mirror.example/python@sha256:python" \
  --shell-image "mirror.example/alpine@sha256:shell" >/dev/null
second_release="$(readlink "$root/opt/aru-selfhost/current")"
test "$first_release" != "$second_release"
test "$(readlink "$root/opt/aru-selfhost/previous")" = "$first_release"

mkdir -p "$root/var/lib/aru-selfhost/data"
touch "$root/var/lib/aru-selfhost/data/preserve-me"
bash "$SELFHOST_DIR/install.sh" --root "$root" --uninstall
test -f "$root/var/lib/aru-selfhost/data/preserve-me"
test ! -e "$root/opt/aru-selfhost"

bash "$SELFHOST_DIR/package-release.sh" "$artifacts/aru-selfhost-linux.tar.gz" >/dev/null
test -s "$artifacts/aru-selfhost-linux.tar.gz"
test -s "$artifacts/aru-selfhost-linux.tar.gz.sha256"
archive_entries="$artifacts/linux-archive-entries.txt"
tar -tzf "$artifacts/aru-selfhost-linux.tar.gz" > "$archive_entries"
for file in install.sh aru-selfhost-stub.mjs collaborator-host.mjs collaborator-surface-bundles.mjs collaborator-surfaces.mjs collaborator-conversations.mjs codex-app-server-driver.mjs collaborator-cognition.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs backup-settings.mjs conversation-turn-relay.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs; do
  grep -Fqx "$file" "$archive_entries"
done

cp "$artifacts/aru-selfhost-linux.tar.gz" "$artifacts/tampered.tar.gz"
cp "$artifacts/aru-selfhost-linux.tar.gz.sha256" "$artifacts/tampered.tar.gz.sha256"
printf 'tamper' >> "$artifacts/tampered.tar.gz"
if bash "$SELFHOST_DIR/install.sh" \
  --root "$root" \
  --bundle-url "file://$artifacts/tampered.tar.gz" \
  --domain "aru.example.com" >/dev/null 2>&1; then
  echo "tampered bundle was accepted" >&2
  exit 1
fi

if bash "$SELFHOST_DIR/install.sh" \
  --root "$root" \
  --source-dir "$SELFHOST_DIR" \
  --base-url "http://100.64.0.10:8787" \
  --profile placeholder >/dev/null 2>&1; then
  echo "placeholder capability profile was accepted" >&2
  exit 1
fi

if bash "$SELFHOST_DIR/install.sh" \
  --root "$root" \
  --source-dir "$SELFHOST_DIR" \
  --base-url "http://100.64.0.10:8787" \
  --node-image "--tls-verify=false" >/dev/null 2>&1; then
  echo "option-shaped runtime image was accepted" >&2
  exit 1
fi

bash "$SELFHOST_DIR/install.sh" \
  --root "$root" \
  --bundle-url "file://$artifacts/aru-selfhost-linux.tar.gz" \
  --domain "aru.example.com" \
  --display-name "AA Public Node"
test -x "$root/opt/aru-selfhost/current/server.mjs"
test -f "$root/opt/aru-selfhost/current/plugin-supervisor.mjs"
grep -Fq 'ARU_BASE_URL=https://aru.example.com' "$root/etc/aru-selfhost/node.env"
grep -Fq 'ARU_LISTEN_HOST=127.0.0.1' "$root/etc/aru-selfhost/node.env"
grep -Fq 'aru.example.com {' "$root/etc/caddy/conf.d/aru-selfhost.caddy"
grep -Fqx 'import /etc/caddy/conf.d/*.caddy' "$root/etc/caddy/Caddyfile"

bash "$SELFHOST_DIR/install.sh" --root "$root" --uninstall --purge-data
test ! -e "$root/var/lib/aru-selfhost"

echo "ARU_SELFHOST_INSTALLER_SMOKE_OK"
