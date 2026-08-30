#!/usr/bin/env bash
set -Eeuo pipefail

SELFHOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(mktemp -d)"
artifacts="$(mktemp -d)"
cleanup() {
  rm -rf "$root" "$artifacts"
}
trap cleanup EXIT

for file in install-macos.sh aru-selfhostctl-macos bundle-host-core.sh package-macos-release.sh package-macos-distribution.sh run-node.sh macos-console/build-app.sh macos-console/build-local-app.sh; do
  bash -n "$SELFHOST_DIR/$file"
done
node --check "$SELFHOST_DIR/aru-selfhost-stub.mjs"
node --check "$SELFHOST_DIR/collaborator-host.mjs"
node --check "$SELFHOST_DIR/mobile-collaborator-replicas.mjs"
node --check "$SELFHOST_DIR/collaborator-surfaces.mjs"
node --check "$SELFHOST_DIR/collaborator-surface-bundles.mjs"
node --check "$SELFHOST_DIR/collaborator-conversations.mjs"
node --check "$SELFHOST_DIR/collaborator-conversation-attachments.mjs"
node --check "$SELFHOST_DIR/collaborator-initiative.mjs"
node --check "$SELFHOST_DIR/collaborator-projects.mjs"
node --check "$SELFHOST_DIR/apns-push.mjs"
node --check "$SELFHOST_DIR/codex-app-server-driver.mjs"
node --check "$SELFHOST_DIR/collaborator-cognition.mjs"
node --check "$SELFHOST_DIR/direct-api-driver.mjs"
node --check "$SELFHOST_DIR/provider-profiles.mjs"
node --check "$SELFHOST_DIR/provider-secret-store.mjs"
node --check "$SELFHOST_DIR/backup-settings.mjs"
node --check "$SELFHOST_DIR/conversation-turn-relay.mjs"
node --check "$SELFHOST_DIR/node-control.mjs"
node --check "$SELFHOST_DIR/node-workspaces.mjs"

install_instance() {
  local instance="$1" port="$2"
  bash "$SELFHOST_DIR/install-macos.sh" \
    --root "$root" \
    --source-dir "$SELFHOST_DIR" \
    --instance "$instance" \
    --port "$port" \
    --base-url "http://aru-$instance.local:$port" \
    --transport-kind lan \
    --release-version 0.28.0-test \
    --display-name "Example $instance Mac"
}

install_instance alpha 18787
alpha="$root/Library/Application Support/Aru Self-Hosted/instances/alpha"
test -x "$alpha/current/server.mjs"
test -f "$alpha/current/collaborator-host.mjs"
test -f "$alpha/current/mobile-collaborator-replicas.mjs"
test -f "$alpha/current/collaborator-surfaces.mjs"
test -f "$alpha/current/collaborator-surface-bundles.mjs"
test -f "$alpha/current/collaborator-conversations.mjs"
test -f "$alpha/current/collaborator-conversation-attachments.mjs"
test -f "$alpha/current/collaborator-initiative.mjs"
test -f "$alpha/current/collaborator-projects.mjs"
test -f "$alpha/current/apns-push.mjs"
test -f "$alpha/current/codex-app-server-driver.mjs"
test -f "$alpha/current/collaborator-cognition.mjs"
test -f "$alpha/current/direct-api-driver.mjs"
test -f "$alpha/current/provider-profiles.mjs"
test -f "$alpha/current/provider-secret-store.mjs"
test -f "$alpha/current/backup-settings.mjs"
test -f "$alpha/current/conversation-turn-relay.mjs"
test -f "$alpha/current/node-control.mjs"
test -f "$alpha/current/node-workspaces.mjs"
test -x "$alpha/current/run-node.sh"
test -x "$alpha/current/install-macos.sh"
test -x "$alpha/current/aru-selfhost"
grep -Fq 'installer="$ARU_INSTALL_SOURCE_DIR/install-macos.sh"' "$alpha/current/aru-selfhost"
grep -Fq 'launchctl print "$(launch_domain)/$LAUNCH_LABEL"' "$alpha/current/install-macos.sh"
grep -Fq 'for attempt in {1..120}; do' "$alpha/current/install-macos.sh"
test -x "$root/Library/Application Support/Aru Self-Hosted/bin/aru-selfhost"
test -f "$alpha/config/node.env"
test -f "$alpha/config/install.env"
test -f "$root/Library/LaunchAgents/cn.aelion.aru-selfhost.alpha.plist"
grep -Fq 'ARU_NODE_KIND=home-mac' "$alpha/config/node.env"
grep -Fq 'ARU_CONTAINER_RUNTIME=none' "$alpha/config/node.env"
grep -Fq "ARU_MANAGED_WORKSPACE_ROOT=$root/Aru\\ Workspaces/alpha" "$alpha/config/node.env"
grep -Fq 'ARU_PORT=18787' "$alpha/config/node.env"
grep -Fq 'aru-alpha.local:18787' "$alpha/config/node.env"
grep -Fq 'ARU_INSTALL_SOURCE_DIR=' "$alpha/config/install.env"
grep -Fq 'ARU_INSTALL_RELEASE_VERSION=0.28.0-test' "$alpha/config/install.env"
plutil -lint "$root/Library/LaunchAgents/cn.aelion.aru-selfhost.alpha.plist" >/dev/null
"$root/Library/Application Support/Aru Self-Hosted/bin/aru-selfhost" \
  --base-root "$root/Library/Application Support/Aru Self-Hosted" \
  --instance alpha help >/dev/null

if install_instance beta 18787 >/dev/null 2>&1; then
  echo "second instance reused an installer-owned port" >&2
  exit 1
fi
install_instance beta 18788
beta="$root/Library/Application Support/Aru Self-Hosted/instances/beta"
test -x "$beta/current/server.mjs"
test -x "$beta/current/aru-selfhost"
test -f "$beta/config/node.env"
grep -Fq 'ARU_PORT=18788' "$beta/config/node.env"
test "$alpha/data" != "$beta/data"

first_alpha_release="$(readlink "$alpha/current")"
install_instance alpha 18787 >/dev/null
second_alpha_release="$(readlink "$alpha/current")"
test "$first_alpha_release" != "$second_alpha_release"
test "$(readlink "$alpha/previous")" = "$first_alpha_release"
test -x "$beta/current/server.mjs"

mkdir -p "$alpha/data"
touch "$alpha/data/preserve-me"
bash "$SELFHOST_DIR/install-macos.sh" --root "$root" --instance alpha --uninstall
test -f "$alpha/data/preserve-me"
test ! -e "$alpha/current"
test -x "$beta/current/server.mjs"

install_instance alpha 18787 >/dev/null
test -f "$alpha/data/preserve-me"
bash "$SELFHOST_DIR/install-macos.sh" --root "$root" --instance alpha --uninstall --purge-data
test ! -e "$alpha/data"
test -x "$beta/current/server.mjs"

bash "$SELFHOST_DIR/package-macos-release.sh" "$artifacts/aru-selfhost-macos.tar.gz" 0.28.0-test >/dev/null
test -s "$artifacts/aru-selfhost-macos.tar.gz"
test -s "$artifacts/aru-selfhost-macos.tar.gz.sha256"
for file in aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs mobile-collaborator-replicas.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-surface-bundles.mjs collaborator-conversations.mjs collaborator-conversation-attachments.mjs collaborator-initiative.mjs collaborator-projects.mjs apns-push.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs run-node.sh install-macos.sh aru-selfhostctl-macos; do
  tar -tzf "$artifacts/aru-selfhost-macos.tar.gz" | grep -Fqx "$file"
done
tar -xOf "$artifacts/aru-selfhost-macos.tar.gz" release.json \
  | grep -Fq '"version":"0.28.0-test"'

echo "ARU_SELFHOST_MACOS_INSTALLER_SMOKE_OK"
