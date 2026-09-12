#!/usr/bin/env bash
set -Eeuo pipefail

# Verifies the electron-builder Windows output: NSIS artifact present plus the
# unpacked app layout carrying the exact-version Host Core payload, mirroring
# linux-desktop-package-smoke.sh at the same trust boundary.
CONSOLE_DIR="${1:?usage: windows-desktop-package-smoke.sh <desktop-console-dir> <version> <x64|arm64>}"
EXPECTED_VERSION="${2:?usage: windows-desktop-package-smoke.sh <desktop-console-dir> <version> <x64|arm64>}"
ARCH="${3:?usage: windows-desktop-package-smoke.sh <desktop-console-dir> <version> <x64|arm64>}"

CONSOLE_DIR="$(cd "$CONSOLE_DIR" && pwd)"
DIST="$CONSOLE_DIR/dist"
ARTIFACT="$DIST/aru-host-windows-$EXPECTED_VERSION-$ARCH.exe"

unpacked="$DIST/win-unpacked"
[[ "$ARCH" != "arm64" ]] || unpacked="$DIST/win-arm64-unpacked"

fail() { echo "windows-desktop-package-smoke: $*" >&2; exit 1; }

[[ -f "$ARTIFACT" ]] || fail "missing installer artifact: $ARTIFACT"
[[ -s "$ARTIFACT" ]] || fail "installer artifact is empty"
[[ -d "$unpacked" ]] || fail "missing unpacked app directory: $unpacked"
[[ -f "$unpacked/Aru Host.exe" ]] || fail "missing Console executable"
[[ -f "$unpacked/resources/app.asar" ]] || fail "missing app.asar"

host_core="$unpacked/resources/HostCore"
[[ -d "$host_core" ]] || fail "missing embedded HostCore"

release_version="$(node -e '
  const release = require(process.argv[1]);
  if (release.schema !== "aru.host.release.v1") process.exit(2);
  process.stdout.write(release.version);
' "$host_core/release.json")" || fail "invalid HostCore release metadata"
[[ "$release_version" == "$EXPECTED_VERSION" ]] || fail "HostCore version $release_version does not match $EXPECTED_VERSION"

required=(
  server-or-stub aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs
  collaborator-host.mjs mobile-collaborator-replicas.mjs mobile-collaborator-identities.mjs container-runtime-setup.mjs collaborator-cognition.mjs collaborator-surfaces.mjs
  collaborator-surface-bundles.mjs collaborator-conversations.mjs collaborator-conversation-attachments.mjs
  collaborator-initiative.mjs collaborator-projects.mjs apns-push.mjs
  codex-app-server-driver.mjs
  direct-api-driver.mjs provider-profiles.mjs
  provider-secret-store.mjs node-control.mjs node-workspaces.mjs
  plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs
  source-plugin-runner.mjs run-node.ps1 install-windows.ps1
  aru-selfhostctl-windows.ps1
)
for file in "${required[@]}"; do
  [[ "$file" == "server-or-stub" ]] && continue
  [[ -f "$host_core/$file" ]] || fail "HostCore payload missing $file"
done

# The Windows payload must not smuggle in another platform's lifecycle owners.
for foreign in install-linux-desktop.sh aru-selfhostctl-linux run-node.sh install-macos.sh aru-selfhostctl-macos; do
  [[ ! -e "$host_core/$foreign" ]] || fail "HostCore payload unexpectedly contains $foreign"
done

echo "ARU_WINDOWS_DESKTOP_PACKAGE_SMOKE_OK"
