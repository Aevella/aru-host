#!/usr/bin/env bash
set -Eeuo pipefail
SELFHOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
payload="$fixture/Host Core"
node_dir="$fixture/Application Support/Node Runtime/bin"
mkdir -p "$payload" "$node_dir"
ln -s "$(command -v node)" "$node_dir/node"
for file in "$SELFHOST_DIR"/*.mjs "$SELFHOST_DIR"/*.sh "$SELFHOST_DIR/aru-selfhostctl-macos"; do
  cp "$file" "$payload/"
done
printf '%s\n' '{"schema":"aru.host.release.v1","version":"0.33.0-test"}' > "$payload/release.json"
for owner in desktop independent; do
  PATH="$node_dir:$PATH" bash "$SELFHOST_DIR/install-macos.sh" \
    --root "$fixture/Test Home" --source-dir "$payload" --port 18799 --install-owner "$owner"
  install_env="$fixture/Test Home/Library/Application Support/Aru Self-Hosted/instances/default/config/install.env"
  ( source "$install_env"; test "$ARU_INSTALL_RELEASE_VERSION" = 0.33.0-test; test "$ARU_INSTALL_OWNER" = "$owner" )
done
test ! -e "$fixture/Test Home/Library/Application Support/Aru Self-Hosted/instances/home"
echo 'macOS installer spaced Node path and release metadata: passed'
