#!/usr/bin/env bash
set -Eeuo pipefail

DEB_PATH="${1:?usage: linux-desktop-package-smoke.sh <package.deb> <version>}"
EXPECTED_VERSION="${2:?usage: linux-desktop-package-smoke.sh <package.deb> <version>}"
[[ -f "$DEB_PATH" ]] || { echo "package not found: $DEB_PATH" >&2; exit 1; }
DEB_PATH="$(cd "$(dirname "$DEB_PATH")" && pwd)/$(basename "$DEB_PATH")"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$work/control" "$work/data"

if command -v dpkg-deb >/dev/null 2>&1; then
  dpkg-deb --control "$DEB_PATH" "$work/control"
  dpkg-deb --extract "$DEB_PATH" "$work/data"
else
  command -v ar >/dev/null 2>&1 || { echo "ar or dpkg-deb is required" >&2; exit 1; }
  (
    cd "$work"
    ar -x "$DEB_PATH"
    control_archive="$(printf '%s\n' control.tar.* | head -1)"
    data_archive="$(printf '%s\n' data.tar.* | head -1)"
    tar -xf "$control_archive" -C control
    tar -xf "$data_archive" -C data
  )
fi

control="$work/control/control"
desktop="$work/data/usr/share/applications/cn.aelion.aru.host-console.linux.desktop"
app_root="$work/data/opt/Aru Host"
host_core="$app_root/resources/HostCore"

grep -q '^Package: aru-host$' "$control"
grep -q "^Version: $EXPECTED_VERSION$" "$control"
grep -q '^License: Apache-2.0$' "$control"
grep -q '^Depends: .*libasound2t64 | libasound2' "$control"
grep -q '^Depends: .*libatspi2.0-0t64 | libatspi2.0-0' "$control"
grep -q '^Depends: .*libgtk-3-0t64 | libgtk-3-0' "$control"
grep -q '^Depends: .*libsecret-tools' "$control"
grep -q '^Depends: .*systemd' "$control"
[[ -x "$app_root/aru-host" ]]
[[ -f "$desktop" ]]
grep -q '^Name=Aru Host$' "$desktop"
grep -q '^StartupWMClass=cn.aelion.aru.host-console.linux$' "$desktop"

for file in \
  aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs \
  collaborator-host.mjs mobile-collaborator-replicas.mjs collaborator-cognition.mjs collaborator-surfaces.mjs \
  collaborator-surface-bundles.mjs collaborator-conversations.mjs \
  collaborator-conversation-attachments.mjs \
  collaborator-initiative.mjs collaborator-projects.mjs apns-push.mjs \
  codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs \
  provider-secret-store.mjs node-control.mjs node-workspaces.mjs \
  plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs \
  source-plugin-runner.mjs run-node.sh install-linux-desktop.sh \
  aru-selfhostctl-linux; do
  [[ -f "$host_core/$file" ]] || { echo "embedded Host Core missing $file" >&2; exit 1; }
done

node -e '
  const fs = require("node:fs");
  const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (release.schema !== "aru.host.release.v1" || release.version !== process.argv[2]) process.exit(1);
' "$host_core/release.json" "$EXPECTED_VERSION"

echo "ARU_LINUX_DESKTOP_PACKAGE_SMOKE_OK"
