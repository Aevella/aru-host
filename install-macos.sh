#!/usr/bin/env bash
set -Eeuo pipefail

readonly PRODUCT="Aru self-hosted for macOS"
readonly REPO_RAW_DEFAULT="https://raw.githubusercontent.com/Aevella/aru-host"

INSTANCE="default"
BASE_ROOT="${ARU_MACOS_BASE_ROOT:-$HOME/Library/Application Support/Aru Self-Hosted}"
BASE_URL=""
TRANSPORT_KIND="lan"
DISPLAY_NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s) Aru"
PORT=""
SOURCE_DIR=""
SOURCE_REF="main"
BUNDLE_URL=""
RELEASE_VERSION=""
SKIP_DEPENDENCIES="false"
SKIP_START="false"
UNINSTALL="false"
PURGE_DATA="false"
INSTALL_ROOT=""
EXPLICIT_PORT="false"
EXPLICIT_BASE_URL="false"

usage() {
  cat <<'EOF'
Install or upgrade an Aru capability node as a user LaunchAgent.

One-click LAN node:
  curl -fsSL https://raw.githubusercontent.com/Aevella/aru-host/main/install-macos.sh | bash

Multiple independent nodes on one Mac:
  install-macos.sh --instance studio --port 8788 --display-name "Studio Mac"

Options:
  --instance NAME          Independent instance id (default: default).
  --base-url URL           Canonical LAN/Tailscale origin. Defaults to this-mac.local:PORT.
  --transport-kind KIND    lan or tailscale (default: lan).
  --display-name NAME      Name shown to Aru clients.
  --port PORT              Listen port. Fresh installs choose the first free port from 8787.
  --source-dir DIR         Install payload from a local Host source directory.
  --source-ref REF         Download payload from this Aevella/aru-host ref (default: main).
  --bundle-url URL         Install a hash-verified macOS release tarball.
  --release-version VER    Record the enclosing signed Host release version.
  --base-root DIR          Override the user-owned installation root.
  --skip-dependencies      Require an existing Node.js 22+ runtime.
  --skip-start             Install files without loading the LaunchAgent.
  --uninstall              Remove this instance program/config; preserve data by default.
  --purge-data             With --uninstall, remove only this instance's durable data.
  --root DIR               Test-only fake home; skips dependencies and launchd.
  --help                   Show this help.
EOF
}

die() {
  echo "$PRODUCT installer: $*" >&2
  exit 1
}

log() {
  echo "[$PRODUCT] $*"
}

download() {
  curl --fail --silent --show-error --location \
    --retry 4 --retry-delay 2 --retry-all-errors "$@"
}

for arg in "$@"; do
  [[ "$arg" == "--help" ]] && { usage; exit 0; }
done

while (($#)); do
  case "$1" in
    --instance) INSTANCE="${2:?missing value for --instance}"; shift 2 ;;
    --base-url) BASE_URL="${2:?missing value for --base-url}"; EXPLICIT_BASE_URL="true"; shift 2 ;;
    --transport-kind) TRANSPORT_KIND="${2:?missing value for --transport-kind}"; shift 2 ;;
    --display-name) DISPLAY_NAME="${2:?missing value for --display-name}"; shift 2 ;;
    --port) PORT="${2:?missing value for --port}"; EXPLICIT_PORT="true"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?missing value for --source-dir}"; shift 2 ;;
    --source-ref) SOURCE_REF="${2:?missing value for --source-ref}"; shift 2 ;;
    --bundle-url) BUNDLE_URL="${2:?missing value for --bundle-url}"; shift 2 ;;
    --release-version) RELEASE_VERSION="${2:?missing value for --release-version}"; shift 2 ;;
    --base-root) BASE_ROOT="${2:?missing value for --base-root}"; shift 2 ;;
    --skip-dependencies) SKIP_DEPENDENCIES="true"; shift ;;
    --skip-start) SKIP_START="true"; shift ;;
    --uninstall) UNINSTALL="true"; shift ;;
    --purge-data) PURGE_DATA="true"; shift ;;
    --root) INSTALL_ROOT="${2:?missing value for --root}"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] \
  || die "instance must use 1-32 lowercase letters, digits, or hyphens"
[[ "$DISPLAY_NAME" != *$'\n'* && -n "$DISPLAY_NAME" ]] || die "display name must be one line"
[[ "$TRANSPORT_KIND" == "lan" || "$TRANSPORT_KIND" == "tailscale" ]] \
  || die "transport kind must be lan or tailscale"
[[ "$SOURCE_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "source ref contains unsupported characters"
[[ -z "$RELEASE_VERSION" || "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]] \
  || die "release version must be a semantic version"
[[ -z "$SOURCE_DIR" || -z "$BUNDLE_URL" ]] || die "choose --source-dir or --bundle-url, not both"

if [[ -n "$INSTALL_ROOT" ]]; then
  [[ "$INSTALL_ROOT" == /* ]] || die "--root must be an absolute path"
  BASE_ROOT="$INSTALL_ROOT/Library/Application Support/Aru Self-Hosted"
  SKIP_DEPENDENCIES="true"
  SKIP_START="true"
elif [[ "$(uname -s)" != "Darwin" ]]; then
  die "production installation requires macOS"
fi

INSTANCE_ROOT="$BASE_ROOT/instances/$INSTANCE"
CONFIG_DIR="$INSTANCE_ROOT/config"
INSTALL_ENV="$CONFIG_DIR/install.env"
NODE_ENV="$CONFIG_DIR/node.env"
DATA_DIR="$INSTANCE_ROOT/data"
LOG_DIR="$INSTANCE_ROOT/logs"
RELEASES_DIR="$INSTANCE_ROOT/releases"
CURRENT_LINK="$INSTANCE_ROOT/current"
PREVIOUS_LINK="$INSTANCE_ROOT/previous"
CONTROL_PATH="$BASE_ROOT/bin/aru-selfhost"
LAUNCH_LABEL="cn.aelion.aru-selfhost.$INSTANCE"
HOME_ROOT="${INSTALL_ROOT:-$HOME}"
LAUNCH_AGENT="$HOME_ROOT/Library/LaunchAgents/$LAUNCH_LABEL.plist"
if [[ "$INSTANCE" == "default" || "$INSTANCE" == "home" ]]; then
  MANAGED_WORKSPACE_ROOT="$HOME_ROOT/Aru Workspace"
else
  MANAGED_WORKSPACE_ROOT="$HOME_ROOT/Aru Workspaces/$INSTANCE"
fi

launch_domain() {
  printf 'gui/%s' "$(id -u)"
}

stop_instance() {
  [[ -n "$INSTALL_ROOT" ]] && return 0
  launchctl bootout "$(launch_domain)/$LAUNCH_LABEL" >/dev/null 2>&1 || true
  local attempt
  for attempt in {1..120}; do
    if ! launchctl print "$(launch_domain)/$LAUNCH_LABEL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  die "timed out waiting for the previous LaunchAgent process to stop"
}

uninstall_instance() {
  stop_instance
  rm -f "$LAUNCH_AGENT"
  rm -rf "$RELEASES_DIR" "$CONFIG_DIR" "$LOG_DIR"
  rm -f "$CURRENT_LINK" "$PREVIOUS_LINK"
  if [[ "$PURGE_DATA" == "true" ]]; then
    rm -rf "$DATA_DIR"
    rmdir "$INSTANCE_ROOT" >/dev/null 2>&1 || true
    log "instance $INSTANCE program and durable data removed"
  else
    mkdir -p "$DATA_DIR"
    chmod 0700 "$DATA_DIR"
    log "instance $INSTANCE program removed; durable data preserved at $DATA_DIR"
  fi
}

if [[ "$UNINSTALL" == "true" ]]; then
  uninstall_instance
  exit 0
fi
[[ "$PURGE_DATA" == "false" ]] || die "--purge-data is valid only with --uninstall"

existing_port=""
if [[ -r "$INSTALL_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$INSTALL_ENV"
  existing_port="${ARU_INSTALL_PORT:-}"
  [[ "$EXPLICIT_PORT" == "true" ]] || PORT="$existing_port"
  [[ "$EXPLICIT_BASE_URL" == "true" ]] || BASE_URL="${ARU_INSTALL_BASE_URL:-}"
fi

port_is_reserved_by_instance() {
  local candidate="$1" record record_instance record_port
  for record in "$BASE_ROOT"/instances/*/config/install.env; do
    [[ -f "$record" || -L "$record" ]] || continue
    record_instance="$(basename "$(dirname "$(dirname "$record")")")"
    [[ "$record_instance" == "$INSTANCE" ]] && continue
    record_port="$(bash -c 'source "$1"; printf "%s" "${ARU_INSTALL_PORT:-}"' _ "$record")"
    [[ "$record_port" != "$candidate" ]] || return 0
  done
  return 1
}

port_has_listener() {
  local candidate="$1"
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -iTCP:"$candidate" -sTCP:LISTEN -t 2>/dev/null | grep -q .
}

choose_port() {
  local candidate=8787
  while ((candidate <= 65535)); do
    if ! port_is_reserved_by_instance "$candidate" && ! port_has_listener "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
    candidate=$((candidate + 1))
  done
  die "no free TCP port remains"
}

if [[ -z "$PORT" ]]; then
  PORT="$(choose_port)"
fi
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) \
  || die "port must be between 1 and 65535"
if port_is_reserved_by_instance "$PORT"; then
  die "port $PORT already belongs to another Aru instance"
fi
if [[ "$PORT" != "$existing_port" ]] && port_has_listener "$PORT"; then
  die "port $PORT is already used by another process"
fi

if [[ -z "$BASE_URL" ]]; then
  local_host="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
  [[ -n "$local_host" ]] || die "could not determine this Mac's local hostname"
  BASE_URL="http://$local_host.local:$PORT"
fi
[[ "$BASE_URL" =~ ^https?://[^[:space:]/]+(:[0-9]+)?$ ]] \
  || die "--base-url must be an origin without a path"

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

managed_node_binary() {
  local runtime_link="$BASE_ROOT/runtime/current-node"
  if [[ -x "$runtime_link/bin/node" ]]; then
    printf '%s' "$runtime_link/bin/node"
  fi
  return 0
}

resolve_node_binary() {
  local candidate major
  candidate="$(command -v node 2>/dev/null || true)"
  [[ -n "$candidate" ]] || candidate="$(managed_node_binary)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    major="$($candidate --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 22)); then
      printf '%s' "$candidate"
      return
    fi
  fi
  [[ "$SKIP_DEPENDENCIES" != "true" ]] || die "Node.js 22 or newer is required"
  install_managed_node >&2
  managed_node_binary
}

install_managed_node() {
  local machine node_arch checksums filename expected temp actual extracted version_root
  machine="$(uname -m)"
  case "$machine" in
    arm64) node_arch="arm64" ;;
    x86_64) node_arch="x64" ;;
    *) die "unsupported Mac architecture: $machine" ;;
  esac
  log "installing a user-owned Node.js 22 runtime"
  temp="$(mktemp -d)"
  checksums="$temp/SHASUMS256.txt"
  download https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$checksums"
  filename="$(awk -v suffix="darwin-$node_arch.tar.gz" '$2 ~ suffix "$" {print $2; exit}' "$checksums")"
  [[ -n "$filename" ]] || { rm -rf "$temp"; die "Node.js release manifest lacks $node_arch macOS archive"; }
  expected="$(awk -v name="$filename" '$2 == name {print $1}' "$checksums")"
  download "https://nodejs.org/dist/latest-v22.x/$filename" -o "$temp/$filename"
  actual="$(sha256_file "$temp/$filename")"
  [[ "$actual" == "$expected" ]] || { rm -rf "$temp"; die "Node.js archive SHA-256 mismatch"; }
  mkdir -p "$BASE_ROOT/runtime"
  tar -xzf "$temp/$filename" -C "$temp"
  extracted="${filename%.tar.gz}"
  version_root="$BASE_ROOT/runtime/$extracted"
  rm -rf "$version_root"
  mv "$temp/$extracted" "$version_root"
  ln -sfn "$version_root" "$BASE_ROOT/runtime/current-node"
  rm -rf "$temp"
}

NODE_BINARY="$(resolve_node_binary)"

detect_usable_container_runtime() {
  if command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    printf podman
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    printf docker
  else
    printf none
  fi
}
CONTAINER_RUNTIME="$(detect_usable_container_runtime)"

SOURCE_TMP=""
ROLLBACK_TMP=""
cleanup() {
  [[ -z "$SOURCE_TMP" ]] || rm -rf "$SOURCE_TMP"
  [[ -z "$ROLLBACK_TMP" ]] || rm -rf "$ROLLBACK_TMP"
}
trap cleanup EXIT

fetch_source_payload() {
  if [[ -n "$SOURCE_DIR" ]]; then
    SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
    return
  fi
  SOURCE_TMP="$(mktemp -d)"
  if [[ -n "$BUNDLE_URL" ]]; then
    log "downloading hash-verified macOS release bundle"
    download "$BUNDLE_URL" -o "$SOURCE_TMP/bundle.tar.gz"
    download "${BUNDLE_URL}.sha256" -o "$SOURCE_TMP/bundle.tar.gz.sha256"
    local expected actual entries expected_entries expected_entries_with_release
    expected="$(awk '{print $1}' "$SOURCE_TMP/bundle.tar.gz.sha256")"
    actual="$(sha256_file "$SOURCE_TMP/bundle.tar.gz")"
    [[ "$expected" == "$actual" ]] || die "release bundle SHA-256 mismatch"
    entries="$(tar -tzf "$SOURCE_TMP/bundle.tar.gz" | LC_ALL=C sort)"
    expected_entries="$(printf '%s\n' aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs mobile-collaborator-replicas.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-surface-bundles.mjs collaborator-conversations.mjs collaborator-initiative.mjs collaborator-projects.mjs apns-push.mjs wake-bridge.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs \
      source-plugin-runtime.mjs source-plugin-runner.mjs \
      run-node.sh install-macos.sh aru-selfhostctl-macos | LC_ALL=C sort)"
    expected_entries_with_release="$(printf '%s\n' "$expected_entries" release.json | LC_ALL=C sort)"
    [[ "$entries" == "$expected_entries" || "$entries" == "$expected_entries_with_release" ]] \
      || die "release bundle contains an unexpected file set"
    mkdir -p "$SOURCE_TMP/payload"
    tar -xzf "$SOURCE_TMP/bundle.tar.gz" -C "$SOURCE_TMP/payload"
    SOURCE_DIR="$SOURCE_TMP/payload"
    return
  fi
  local raw="$REPO_RAW_DEFAULT/$SOURCE_REF" file
  log "downloading macOS node payload from Aevella/aru-host@$SOURCE_REF"
  for file in aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs mobile-collaborator-replicas.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-surface-bundles.mjs collaborator-conversations.mjs collaborator-initiative.mjs collaborator-projects.mjs apns-push.mjs wake-bridge.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs run-node.sh install-macos.sh aru-selfhostctl-macos; do
    download "$raw/$file" -o "$SOURCE_TMP/$file"
  done
  SOURCE_DIR="$SOURCE_TMP"
}

SOURCE_INPUT_DIR="$SOURCE_DIR"
fetch_source_payload
if [[ -z "$RELEASE_VERSION" && -f "$SOURCE_DIR/release.json" ]]; then
  RELEASE_VERSION="$($NODE_BINARY -e '
    const fs = require("node:fs");
    const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (release.schema !== "aru.host.release.v1" || typeof release.version !== "string") process.exit(2);
    process.stdout.write(release.version);
  ' "$SOURCE_DIR/release.json")" || die "payload release metadata is invalid"
  [[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]] \
    || die "payload release version must be a semantic version"
fi
for file in aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs mobile-collaborator-replicas.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-surface-bundles.mjs collaborator-conversations.mjs collaborator-initiative.mjs collaborator-projects.mjs apns-push.mjs wake-bridge.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs run-node.sh install-macos.sh aru-selfhostctl-macos; do
  [[ -f "$SOURCE_DIR/$file" ]] || die "payload is missing $file"
done

release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_ref="$(printf '%s' "$SOURCE_REF" | tr '/ ' '--' | tr -cd 'A-Za-z0-9._-')"
if [[ -n "$RELEASE_VERSION" ]]; then
  release_ref="host-$RELEASE_VERSION"
fi
release_id="${release_ref:-bundle}-$release_stamp"
suffix=1
while [[ -e "$RELEASES_DIR/$release_id" ]]; do
  release_id="${release_ref:-bundle}-$release_stamp-$suffix"
  suffix=$((suffix + 1))
done

mkdir -p "$RELEASES_DIR/$release_id" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR" \
  "$BASE_ROOT/bin" "$(dirname "$LAUNCH_AGENT")"
chmod 0700 "$INSTANCE_ROOT" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"
install -m 0755 "$SOURCE_DIR/aru-selfhost-stub.mjs" "$RELEASES_DIR/$release_id/server.mjs"
install -m 0644 "$SOURCE_DIR/backup-settings.mjs" "$RELEASES_DIR/$release_id/backup-settings.mjs"
install -m 0644 "$SOURCE_DIR/conversation-turn-relay.mjs" "$RELEASES_DIR/$release_id/conversation-turn-relay.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-host.mjs" "$RELEASES_DIR/$release_id/collaborator-host.mjs"
install -m 0644 "$SOURCE_DIR/mobile-collaborator-replicas.mjs" "$RELEASES_DIR/$release_id/mobile-collaborator-replicas.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-cognition.mjs" "$RELEASES_DIR/$release_id/collaborator-cognition.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-surfaces.mjs" "$RELEASES_DIR/$release_id/collaborator-surfaces.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-surface-bundles.mjs" "$RELEASES_DIR/$release_id/collaborator-surface-bundles.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-conversations.mjs" "$RELEASES_DIR/$release_id/collaborator-conversations.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-initiative.mjs" "$RELEASES_DIR/$release_id/collaborator-initiative.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-projects.mjs" "$RELEASES_DIR/$release_id/collaborator-projects.mjs"
install -m 0644 "$SOURCE_DIR/apns-push.mjs" "$RELEASES_DIR/$release_id/apns-push.mjs"
install -m 0644 "$SOURCE_DIR/wake-bridge.mjs" "$RELEASES_DIR/$release_id/wake-bridge.mjs"
install -m 0644 "$SOURCE_DIR/codex-app-server-driver.mjs" "$RELEASES_DIR/$release_id/codex-app-server-driver.mjs"
install -m 0644 "$SOURCE_DIR/direct-api-driver.mjs" "$RELEASES_DIR/$release_id/direct-api-driver.mjs"
install -m 0644 "$SOURCE_DIR/provider-profiles.mjs" "$RELEASES_DIR/$release_id/provider-profiles.mjs"
install -m 0644 "$SOURCE_DIR/provider-secret-store.mjs" "$RELEASES_DIR/$release_id/provider-secret-store.mjs"
install -m 0644 "$SOURCE_DIR/node-control.mjs" "$RELEASES_DIR/$release_id/node-control.mjs"
install -m 0644 "$SOURCE_DIR/node-workspaces.mjs" "$RELEASES_DIR/$release_id/node-workspaces.mjs"
install -m 0644 "$SOURCE_DIR/plugin-supervisor.mjs" "$RELEASES_DIR/$release_id/plugin-supervisor.mjs"
install -m 0644 "$SOURCE_DIR/plugin-workshop.mjs" "$RELEASES_DIR/$release_id/plugin-workshop.mjs"
install -m 0644 "$SOURCE_DIR/source-plugin-runtime.mjs" "$RELEASES_DIR/$release_id/source-plugin-runtime.mjs"
install -m 0644 "$SOURCE_DIR/source-plugin-runner.mjs" "$RELEASES_DIR/$release_id/source-plugin-runner.mjs"
install -m 0755 "$SOURCE_DIR/run-node.sh" "$RELEASES_DIR/$release_id/run-node.sh"
install -m 0755 "$SOURCE_DIR/install-macos.sh" "$RELEASES_DIR/$release_id/install-macos.sh"
install -m 0755 "$SOURCE_DIR/aru-selfhostctl-macos" "$RELEASES_DIR/$release_id/aru-selfhost"

old_release="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
old_previous="$(readlink "$PREVIOUS_LINK" 2>/dev/null || true)"
ROLLBACK_TMP="$(mktemp -d "$INSTANCE_ROOT/.install-rollback.XXXXXX")"
had_node_env=false
had_install_env=false
had_launch_agent=false
if [[ -f "$NODE_ENV" ]]; then
  cp -p "$NODE_ENV" "$ROLLBACK_TMP/node.env"
  had_node_env=true
fi
if [[ -f "$INSTALL_ENV" ]]; then
  cp -p "$INSTALL_ENV" "$ROLLBACK_TMP/install.env"
  had_install_env=true
fi
if [[ -f "$LAUNCH_AGENT" ]]; then
  cp -p "$LAUNCH_AGENT" "$ROLLBACK_TMP/launch-agent.plist"
  had_launch_agent=true
fi
stop_instance
if [[ -n "$old_release" ]]; then
  ln -sfn "$old_release" "$PREVIOUS_LINK"
fi
ln -sfn "releases/$release_id" "$CURRENT_LINK"

write_env() {
  local destination="$1"
  shift
  : > "$destination"
  chmod 0600 "$destination"
  local name
  for name in "$@"; do
    printf '%s=%q\n' "$name" "${!name}" >> "$destination"
  done
}

ARU_SERVER_ENTRY="$CURRENT_LINK/server.mjs"
ARU_NODE_BINARY="$NODE_BINARY"
ARU_LISTEN_HOST="0.0.0.0"
ARU_PORT="$PORT"
ARU_DATA_DIR="$DATA_DIR"
ARU_MANAGED_WORKSPACE_ROOT="$MANAGED_WORKSPACE_ROOT"
ARU_BASE_URL="$BASE_URL"
ARU_TRANSPORT_KIND="$TRANSPORT_KIND"
ARU_DISPLAY_NAME="$DISPLAY_NAME"
ARU_NODE_KIND="home-mac"
ARU_CONTAINER_RUNTIME="$CONTAINER_RUNTIME"
ARU_MAX_PACKAGE_MB="2048"
ARU_MAX_WORKSPACE_MB="512"
ARU_MAX_WORKSPACE_OUTPUT_MB="32"
ARU_CONTAINER_MEMORY="1g"
ARU_CONTAINER_CPUS="2"
ARU_NODE_IMAGE="node:22-alpine"
ARU_PYTHON_IMAGE="python:3.13-alpine"
ARU_SHELL_IMAGE="alpine:3.22"
write_env "$NODE_ENV" ARU_SERVER_ENTRY ARU_NODE_BINARY ARU_LISTEN_HOST ARU_PORT \
  ARU_DATA_DIR ARU_MANAGED_WORKSPACE_ROOT ARU_BASE_URL ARU_TRANSPORT_KIND ARU_DISPLAY_NAME ARU_NODE_KIND \
  ARU_CONTAINER_RUNTIME ARU_MAX_PACKAGE_MB ARU_MAX_WORKSPACE_MB \
  ARU_MAX_WORKSPACE_OUTPUT_MB ARU_CONTAINER_MEMORY ARU_CONTAINER_CPUS \
  ARU_NODE_IMAGE ARU_PYTHON_IMAGE ARU_SHELL_IMAGE

ARU_INSTALL_INSTANCE="$INSTANCE"
ARU_INSTALL_BASE_ROOT="$BASE_ROOT"
ARU_INSTALL_BASE_URL="$BASE_URL"
ARU_INSTALL_TRANSPORT_KIND="$TRANSPORT_KIND"
ARU_INSTALL_DISPLAY_NAME="$DISPLAY_NAME"
ARU_INSTALL_PORT="$PORT"
ARU_INSTALL_SOURCE_REF="$SOURCE_REF"
ARU_INSTALL_BUNDLE_URL="$BUNDLE_URL"
ARU_INSTALL_RELEASE_VERSION="$RELEASE_VERSION"
ARU_INSTALL_SOURCE_DIR=""
if [[ -n "$SOURCE_INPUT_DIR" ]]; then
  ARU_INSTALL_SOURCE_DIR="$SOURCE_DIR"
fi
write_env "$INSTALL_ENV" ARU_INSTALL_INSTANCE ARU_INSTALL_BASE_ROOT \
  ARU_INSTALL_BASE_URL ARU_INSTALL_TRANSPORT_KIND ARU_INSTALL_DISPLAY_NAME \
  ARU_INSTALL_PORT ARU_INSTALL_SOURCE_REF ARU_INSTALL_BUNDLE_URL \
  ARU_INSTALL_RELEASE_VERSION ARU_INSTALL_SOURCE_DIR

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

cat > "$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_escape "$LAUNCH_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "$CURRENT_LINK/run-node.sh")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARU_SELFHOST_CONFIG_FILE</key><string>$(xml_escape "$NODE_ENV")</string>
  </dict>
  <key>WorkingDirectory</key><string>$(xml_escape "$DATA_DIR")</string>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_DIR/stdout.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_DIR/stderr.log")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
</dict>
</plist>
EOF
chmod 0600 "$LAUNCH_AGENT"
plutil -lint "$LAUNCH_AGENT" >/dev/null

cat > "$CONTROL_PATH" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
base_root="${ARU_MACOS_BASE_ROOT:-$HOME/Library/Application Support/Aru Self-Hosted}"
instance="default"
args=("$@")
while (($#)); do
  case "$1" in
    --instance) instance="${2:?missing value for --instance}"; shift 2 ;;
    --base-root) base_root="${2:?missing value for --base-root}"; shift 2 ;;
    *) break ;;
  esac
done
controller="$base_root/instances/$instance/current/aru-selfhost"
[[ -x "$controller" ]] || { echo "aru-selfhost: instance $instance is not installed" >&2; exit 1; }
exec "$controller" "${args[@]}"
EOF
chmod 0755 "$CONTROL_PATH"

default_base_root="$HOME/Library/Application Support/Aru Self-Hosted"
if [[ -z "$INSTALL_ROOT" && "$BASE_ROOT" == "$default_base_root" ]]; then
  mkdir -p "$HOME/.local/bin"
  if [[ -e "$HOME/.local/bin/aru-selfhost" && ! -L "$HOME/.local/bin/aru-selfhost" ]]; then
    die "$HOME/.local/bin/aru-selfhost exists and is not an installer-managed symlink"
  fi
  ln -sfn "$CONTROL_PATH" "$HOME/.local/bin/aru-selfhost"
fi

start_instance() {
  launchctl bootstrap "$(launch_domain)" "$LAUNCH_AGENT"
  launchctl enable "$(launch_domain)/$LAUNCH_LABEL"
  launchctl kickstart -k "$(launch_domain)/$LAUNCH_LABEL"
  local attempt
  for attempt in {1..120}; do
    if curl -fsS "http://127.0.0.1:$PORT/.well-known/aru.json" >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  return 1
}

if [[ "$SKIP_START" != "true" ]]; then
  if ! start_instance; then
    stop_instance
    if [[ "$had_node_env" == true ]]; then
      cp -p "$ROLLBACK_TMP/node.env" "$NODE_ENV"
    else
      rm -f "$NODE_ENV"
    fi
    if [[ "$had_install_env" == true ]]; then
      cp -p "$ROLLBACK_TMP/install.env" "$INSTALL_ENV"
    else
      rm -f "$INSTALL_ENV"
    fi
    if [[ "$had_launch_agent" == true ]]; then
      cp -p "$ROLLBACK_TMP/launch-agent.plist" "$LAUNCH_AGENT"
    else
      rm -f "$LAUNCH_AGENT"
    fi
    if [[ -n "$old_release" ]]; then
      ln -sfn "$old_release" "$CURRENT_LINK"
      start_instance || true
    else
      rm -f "$CURRENT_LINK"
    fi
    if [[ -n "$old_previous" ]]; then
      ln -sfn "$old_previous" "$PREVIOUS_LINK"
    else
      rm -f "$PREVIOUS_LINK"
    fi
    rm -rf "$RELEASES_DIR/$release_id"
    die "new release failed its local manifest health check; previous release restored when available"
  fi
fi

rm -rf "$ROLLBACK_TMP"
ROLLBACK_TMP=""

log "installed instance $INSTANCE release $release_id"
log "canonical URL: $BASE_URL"
if [[ "$CONTAINER_RUNTIME" == "none" ]]; then
  log "workspace jobs and OCI plugins are disabled; the isolated source-plugin workshop remains available"
else
  log "workspace runtime: $CONTAINER_RUNTIME"
fi
if [[ "$SKIP_START" != "true" ]]; then
  if [[ "$BASE_ROOT" == "$default_base_root" ]]; then
    log "run '$HOME/.local/bin/aru-selfhost --instance $INSTANCE pairing' for a fresh 10-minute link"
  else
    log "run '$CONTROL_PATH --base-root $BASE_ROOT --instance $INSTANCE pairing' for a fresh 10-minute link"
  fi
fi
