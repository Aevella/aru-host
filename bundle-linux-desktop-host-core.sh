#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINATION="${1:?destination required}"
VERSION="${2:?version required}"
[[ "$DESTINATION" == /* ]] || DESTINATION="$PWD/$DESTINATION"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]] || { echo "invalid version" >&2; exit 1; }

files=(
  aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs
  collaborator-host.mjs mobile-collaborator-replicas.mjs collaborator-cognition.mjs collaborator-surfaces.mjs
  collaborator-surface-bundles.mjs collaborator-conversations.mjs
  collaborator-initiative.mjs collaborator-projects.mjs apns-push.mjs wake-bridge.mjs
  codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs
  provider-secret-store.mjs node-control.mjs node-workspaces.mjs
  plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs
  source-plugin-runner.mjs run-node.sh install-linux-desktop.sh
  aru-selfhostctl-linux
)
for file in "${files[@]}"; do [[ -f "$SCRIPT_DIR/$file" ]] || { echo "missing $file" >&2; exit 1; }; done
rm -rf "$DESTINATION"
mkdir -p "$DESTINATION"
for file in "${files[@]}"; do install -m 0644 "$SCRIPT_DIR/$file" "$DESTINATION/$file"; done
chmod 0755 "$DESTINATION/aru-selfhost-stub.mjs" "$DESTINATION/run-node.sh" \
  "$DESTINATION/install-linux-desktop.sh" "$DESTINATION/aru-selfhostctl-linux"
printf '{"schema":"aru.host.release.v1","version":"%s"}\n' "$VERSION" > "$DESTINATION/release.json"
