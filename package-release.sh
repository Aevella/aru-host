#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${1:-$PWD/aru-selfhost-linux.tar.gz}"

case "$OUTPUT" in
  /*) ;;
  *) OUTPUT="$PWD/$OUTPUT" ;;
esac

for file in aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-conversations.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs run-node.sh aru-selfhost.service aru-selfhostctl install.sh; do
  [[ -f "$SCRIPT_DIR/$file" ]] || { echo "missing release file: $file" >&2; exit 1; }
done

mkdir -p "$(dirname "$OUTPUT")"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT

for file in aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-conversations.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs run-node.sh aru-selfhost.service aru-selfhostctl install.sh; do
  install -m 0755 "$SCRIPT_DIR/$file" "$temp/$file"
done
chmod 0644 "$temp/aru-selfhost.service" "$temp/backup-settings.mjs" "$temp/conversation-turn-relay.mjs" "$temp/collaborator-host.mjs" "$temp/collaborator-cognition.mjs" "$temp/collaborator-surfaces.mjs" "$temp/collaborator-conversations.mjs" "$temp/codex-app-server-driver.mjs" "$temp/direct-api-driver.mjs" "$temp/provider-profiles.mjs" "$temp/provider-secret-store.mjs" "$temp/node-control.mjs" "$temp/node-workspaces.mjs" "$temp/plugin-supervisor.mjs" "$temp/plugin-workshop.mjs" \
  "$temp/source-plugin-runtime.mjs" "$temp/source-plugin-runner.mjs"

tar -czf "$OUTPUT" -C "$temp" \
  aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-conversations.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs \
  run-node.sh aru-selfhost.service aru-selfhostctl install.sh

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$OUTPUT")" && sha256sum "$(basename "$OUTPUT")") > "${OUTPUT}.sha256"
else
  (cd "$(dirname "$OUTPUT")" && shasum -a 256 "$(basename "$OUTPUT")") > "${OUTPUT}.sha256"
fi

echo "$OUTPUT"
echo "${OUTPUT}.sha256"
