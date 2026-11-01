#!/usr/bin/env bash
# Run only on a disposable Ubuntu VM as root. Creates an isolated test account
# and system units; removes both on exit. No existing Host installation is used.
set -Eeuo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run on a disposable Ubuntu VM with sudo'; exit 1; }
source_root=$(cd "$(dirname "$0")/.." && pwd)
node_binary=${1:?Pass the Node 22+ executable}
account=aru-cgroup-proof
unit=aru-cgroup-proof.service
root=$(mktemp -d /var/tmp/aru-cgroup-proof.XXXXXX)
cleanup() {
  systemctl stop "$unit" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$unit"
  systemctl daemon-reload
  loginctl disable-linger "$account" >/dev/null 2>&1 || true
  userdel -r "$account" >/dev/null 2>&1 || true
  rm -rf "$root"
}
! id "$account" >/dev/null 2>&1 || { echo 'Fixture account already exists'; exit 1; }
useradd --create-home --shell /bin/bash "$account"
trap cleanup EXIT
loginctl enable-linger "$account"
mkdir -p "$root/source"
cp -R "$source_root/src" "$root/source/"
cp "$source_root"/*.mjs "$root/source/"
chmod -R a+rX "$root"
cat > "$root/containers.conf" <<'CONF'
[engine]
cgroup_manager = "cgroupfs"
runtime = "runc"
CONF
chmod 644 "$root/containers.conf"
# Pull through the user manager, independent of either system-unit scenario.
uid=$(id -u "$account")
for image in docker.io/library/node:22-alpine docker.io/library/python:3.13-alpine docker.io/library/alpine:3.22; do
  runuser -u "$account" -- env HOME="/home/$account" XDG_RUNTIME_DIR="/run/user/$uid" CONTAINERS_CONF="$root/containers.conf" podman pull "$image"
done
cat > "$root/source/proof.mjs" <<'JS'
import assert from 'node:assert/strict';
import { createContainerReadiness } from './src/server/container-readiness.mjs';
const readiness = createContainerReadiness({containerRuntime:'/usr/bin/podman',
  containerMemory:'1g', containerCPUs:'2', runtimeImages:{node:'docker.io/library/node:22-alpine', python:'docker.io/library/python:3.13-alpine', shell:'docker.io/library/alpine:3.22'}});
await readiness.check();
console.log('ROOTLESS_READINESS', JSON.stringify(readiness.diagnostics()));
assert.equal(readiness.ready(), true);
assert.equal(readiness.resourceLimits(), process.env.EXPECT_LIMITS === 'true');
JS
chmod a+r "$root/source/proof.mjs"
for delegated in yes no; do
  expected=false; [[ $delegated == yes ]] && expected=true
  cat > "/etc/systemd/system/$unit" <<UNIT
[Unit]
Description=Disposable Aru rootless cgroup acceptance
[Service]
Type=oneshot
User=$account
Group=$account
Environment=HOME=/home/$account
Environment=XDG_RUNTIME_DIR=/run/aru-cgroup-proof
Environment=CONTAINERS_CONF=$root/containers.conf
Environment=EXPECT_LIMITS=$expected
RuntimeDirectory=aru-cgroup-proof
RuntimeDirectoryMode=0700
UMask=0077
Delegate=$delegated
ProtectSystem=full
ProtectHome=false
ExecStart=$node_binary $root/source/proof.mjs
TimeoutStartSec=180
RemainAfterExit=yes
UNIT
  systemctl daemon-reload
  echo "=== Ubuntu system service Delegate=$delegated ==="
  if ! systemctl start "$unit"; then journalctl -u "$unit" --no-pager -n 100; exit 1; fi
  systemctl show "$unit" -p User -p Delegate -p ControlGroup -p Result
  cg=$(systemctl show "$unit" -p ControlGroup --value)
  stat -c '%U:%G %a %n' "/sys/fs/cgroup$cg"
  cat "/sys/fs/cgroup$cg/cgroup.controllers" "/sys/fs/cgroup$cg/cgroup.subtree_control"
  journalctl -u "$unit" --no-pager -n 25
  systemctl stop "$unit"
done
podman --version
runc --version
systemd --version | head -1
