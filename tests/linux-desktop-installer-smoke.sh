#!/usr/bin/env bash
set -Eeuo pipefail

SELFHOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

install_version() {
  "$SELFHOST_DIR/install-linux-desktop.sh" \
    --root "$TEST_ROOT" \
    --source-dir "$SELFHOST_DIR" \
    --instance home \
    --base-url http://127.0.0.1:8787 \
    --display-name "Linux Desktop Aru" \
    --release-version "$1"
}

install_version 0.28.1
instance="$TEST_ROOT/data/aru-host/instances/home"
unit="$TEST_ROOT/config/systemd/user/aru-host-home.service"
control="$TEST_ROOT/home/.local/bin/aru-selfhost"
first="$(readlink "$instance/current")"
test -n "$first"
test -x "$instance/current/server.mjs"
test -x "$instance/current/aru-selfhostctl-linux"
test -L "$control"
grep -Fq 'ARU_NODE_KIND=home-linux' "$instance/config/node.env"
grep -Fq '"home-linux"' "$instance/current/node-workspaces.mjs"
grep -Fq "$instance/current/run-node.sh" "$unit"

printf 'durable-user-state\n' > "$instance/data/preserved.txt"
install_version 0.28.2
second="$(readlink "$instance/current")"
test "$second" != "$first"
test "$(readlink "$instance/previous")" = "$first"
test "$(cat "$instance/data/preserved.txt")" = durable-user-state
grep -Fq 'ARU_INSTALL_RELEASE_VERSION=0.28.2' "$instance/config/install.env"

"$SELFHOST_DIR/install-linux-desktop.sh" \
  --root "$TEST_ROOT" \
  --instance home \
  --uninstall
test -f "$instance/data/preserved.txt"
test ! -e "$instance/current"
test ! -e "$unit"
test ! -L "$control"

install_version 0.28.3
test "$(cat "$instance/data/preserved.txt")" = durable-user-state
"$SELFHOST_DIR/install-linux-desktop.sh" \
  --root "$TEST_ROOT" \
  --instance home \
  --uninstall \
  --purge-data
test ! -e "$instance/data"

echo ARU_LINUX_DESKTOP_INSTALLER_SMOKE_OK
