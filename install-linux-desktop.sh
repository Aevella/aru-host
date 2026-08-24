#!/usr/bin/env bash
set -Eeuo pipefail

readonly PRODUCT="Aru Host for Linux"
readonly REPO_RAW_DEFAULT="https://raw.githubusercontent.com/Aevella/aru-host"
readonly CORE_FILES=(
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

INSTANCE="home"
BASE_ROOT="${ARU_LINUX_BASE_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/aru-host}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
BASE_URL=""
DISPLAY_NAME="$(hostname -s 2>/dev/null || printf Linux) Aru"
PORT="8787"
SOURCE_DIR=""
SOURCE_REF="main"
BUNDLE_URL=""
RELEASE_VERSION=""
SKIP_DEPENDENCIES="false"
SKIP_START="false"
UNINSTALL="false"
PURGE_DATA="false"
INSTALL_ROOT=""

usage() {
  cat <<'EOF'
Install or upgrade Aru Host as a current-user Linux desktop service.

Options:
  --instance NAME          Independent instance id (default: home).
  --base-url URL           LAN origin advertised to paired devices.
  --display-name NAME      Name shown to Aru clients.
  --port PORT              Listen port (default: 8787).
  --source-dir DIR         Install from a local Host Core payload.
  --source-ref REF         Download from Aevella/aru-host (default: main).
  --bundle-url URL         Install a hash-verified Linux desktop bundle.
  --release-version VER    Record the enclosing desktop release version.
  --base-root DIR          Override the user-owned installation root.
  --skip-dependencies      Require an existing Node.js 22+ runtime.
  --skip-start             Install files without starting systemd --user.
  --uninstall              Remove program/config; preserve durable data.
  --purge-data             With --uninstall, remove this instance's data.
  --root DIR               Test-only fake home; skips dependencies/systemd.
  --help                   Show this help.
EOF
}

die() { echo "$PRODUCT installer: $*" >&2; exit 1; }
log() { echo "[$PRODUCT] $*"; }
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
    --base-url) BASE_URL="${2:?missing value for --base-url}"; shift 2 ;;
    --display-name) DISPLAY_NAME="${2:?missing value for --display-name}"; shift 2 ;;
    --port) PORT="${2:?missing value for --port}"; shift 2 ;;
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

[[ "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "invalid instance"
[[ "$DISPLAY_NAME" != *$'\n'* && -n "$DISPLAY_NAME" ]] || die "display name must be one line"
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || die "invalid port"
[[ "$SOURCE_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid source ref"
[[ -z "$SOURCE_DIR" || -z "$BUNDLE_URL" ]] || die "choose source-dir or bundle-url"
[[ -z "$RELEASE_VERSION" || "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]] \
  || die "invalid release version"

HOME_ROOT="$HOME"
if [[ -n "$INSTALL_ROOT" ]]; then
  [[ "$INSTALL_ROOT" == /* ]] || die "--root must be absolute"
  HOME_ROOT="$INSTALL_ROOT/home"
  BASE_ROOT="$INSTALL_ROOT/data/aru-host"
  CONFIG_HOME="$INSTALL_ROOT/config"
  SKIP_DEPENDENCIES="true"
  SKIP_START="true"
elif [[ "$(uname -s)" != "Linux" ]]; then
  die "production installation requires Linux"
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
UNIT_NAME="aru-host-$INSTANCE.service"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
CONTROL_LINK="$HOME_ROOT/.local/bin/aru-selfhost"
MANAGED_WORKSPACE_ROOT="$HOME_ROOT/Aru Workspace"

stop_service() {
  [[ "$SKIP_START" == "true" ]] && return 0
  systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
}

if [[ "$UNINSTALL" == "true" ]]; then
  stop_service
  control_target="$(readlink "$CONTROL_LINK" 2>/dev/null || true)"
  rm -f "$UNIT_PATH"
  [[ "$SKIP_START" == "true" ]] || systemctl --user daemon-reload
  rm -rf "$RELEASES_DIR" "$CONFIG_DIR" "$LOG_DIR"
  rm -f "$CURRENT_LINK" "$PREVIOUS_LINK"
  [[ "$control_target" != "$CURRENT_LINK/aru-selfhostctl-linux" ]] || rm -f "$CONTROL_LINK"
  if [[ "$PURGE_DATA" == "true" ]]; then
    rm -rf "$DATA_DIR"
    rmdir "$INSTANCE_ROOT" >/dev/null 2>&1 || true
    log "instance $INSTANCE program and durable data removed"
  else
    mkdir -p "$DATA_DIR"
    chmod 0700 "$DATA_DIR"
    log "instance $INSTANCE program removed; durable data preserved at $DATA_DIR"
  fi
  exit 0
fi
[[ "$PURGE_DATA" == "false" ]] || die "--purge-data requires --uninstall"

if [[ -r "$INSTALL_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$INSTALL_ENV"
  [[ "$PORT" != "8787" || -z "${ARU_INSTALL_PORT:-}" ]] || PORT="$ARU_INSTALL_PORT"
  [[ -n "$BASE_URL" ]] || BASE_URL="${ARU_INSTALL_BASE_URL:-}"
fi

port_has_listener() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | grep -q .
  else
    return 1
  fi
}
if [[ -z "$INSTALL_ROOT" && ! -r "$INSTALL_ENV" ]] && port_has_listener "$PORT"; then
  die "port $PORT is already in use"
fi

if [[ -z "$BASE_URL" ]]; then
  lan_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')"
  [[ -n "$lan_ip" ]] || lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -n "$lan_ip" ]]; then
    BASE_URL="http://$lan_ip:$PORT"
  else
    BASE_URL="http://$(hostname -s).local:$PORT"
  fi
fi
[[ "$BASE_URL" =~ ^https?://[^[:space:]/]+(:[0-9]+)?$ ]] || die "base URL must be an origin"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

managed_node_binary() {
  local path="$BASE_ROOT/runtime/current-node/bin/node"
  [[ -x "$path" ]] && printf '%s' "$path"
}

install_managed_node() {
  local architecture node_arch temp checksums filename expected actual extracted version_root
  architecture="$(uname -m)"
  case "$architecture" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) die "unsupported Linux architecture: $architecture" ;;
  esac
  temp="$(mktemp -d)"
  checksums="$temp/SHASUMS256.txt"
  download https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$checksums"
  filename="$(awk -v suffix="linux-$node_arch.tar.gz" '$2 ~ suffix "$" {print $2; exit}' "$checksums")"
  [[ -n "$filename" ]] || { rm -rf "$temp"; die "Node.js manifest lacks $node_arch Linux"; }
  expected="$(awk -v name="$filename" '$2 == name {print $1}' "$checksums")"
  download "https://nodejs.org/dist/latest-v22.x/$filename" -o "$temp/$filename"
  actual="$(sha256_file "$temp/$filename")"
  [[ "$actual" == "$expected" ]] || { rm -rf "$temp"; die "Node.js SHA-256 mismatch"; }
  tar -xzf "$temp/$filename" -C "$temp"
  extracted="${filename%.tar.gz}"
  version_root="$BASE_ROOT/runtime/$extracted"
  mkdir -p "$BASE_ROOT/runtime"
  rm -rf "$version_root"
  mv "$temp/$extracted" "$version_root"
  ln -sfn "$version_root" "$BASE_ROOT/runtime/current-node"
  rm -rf "$temp"
}

resolve_node_binary() {
  local candidate major
  candidate="$(command -v node 2>/dev/null || true)"
  [[ -n "$candidate" ]] || candidate="$(managed_node_binary)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    major="$($candidate --version | sed -E 's/^v([0-9]+).*/\1/')"
    [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 22)) && { printf '%s' "$candidate"; return; }
  fi
  [[ "$SKIP_DEPENDENCIES" != "true" ]] || die "Node.js 22 or newer is required"
  log "installing a user-owned Node.js 22 runtime" >&2
  install_managed_node
  managed_node_binary
}
NODE_BINARY="$(resolve_node_binary)"

detect_container_runtime() {
  if command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then printf podman
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then printf docker
  else printf none; fi
}
CONTAINER_RUNTIME="$(detect_container_runtime)"

SOURCE_TMP=""
ROLLBACK_TMP=""
cleanup() {
  [[ -z "$SOURCE_TMP" ]] || rm -rf "$SOURCE_TMP"
  [[ -z "$ROLLBACK_TMP" ]] || rm -rf "$ROLLBACK_TMP"
}
trap cleanup EXIT

fetch_payload() {
  if [[ -n "$SOURCE_DIR" ]]; then SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"; return; fi
  SOURCE_TMP="$(mktemp -d)"
  if [[ -n "$BUNDLE_URL" ]]; then
    download "$BUNDLE_URL" -o "$SOURCE_TMP/bundle.tar.gz"
    download "${BUNDLE_URL}.sha256" -o "$SOURCE_TMP/bundle.tar.gz.sha256"
    expected="$(awk '{print $1}' "$SOURCE_TMP/bundle.tar.gz.sha256")"
    [[ "$(sha256_file "$SOURCE_TMP/bundle.tar.gz")" == "$expected" ]] || die "bundle SHA-256 mismatch"
    mkdir -p "$SOURCE_TMP/payload"
    tar -xzf "$SOURCE_TMP/bundle.tar.gz" -C "$SOURCE_TMP/payload"
    SOURCE_DIR="$SOURCE_TMP/payload"
    return
  fi
  raw="$REPO_RAW_DEFAULT/$SOURCE_REF"
  for file in "${CORE_FILES[@]}"; do download "$raw/$file" -o "$SOURCE_TMP/$file"; done
  download "$raw/release.json" -o "$SOURCE_TMP/release.json" || true
  SOURCE_DIR="$SOURCE_TMP"
}

SOURCE_INPUT_DIR="$SOURCE_DIR"
fetch_payload
for file in "${CORE_FILES[@]}"; do [[ -f "$SOURCE_DIR/$file" ]] || die "payload missing $file"; done
if [[ -z "$RELEASE_VERSION" && -f "$SOURCE_DIR/release.json" ]]; then
  RELEASE_VERSION="$($NODE_BINARY -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1]));if(r.schema!=="aru.host.release.v1")process.exit(2);process.stdout.write(r.version)' "$SOURCE_DIR/release.json")" \
    || die "invalid release metadata"
fi

release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_ref="${RELEASE_VERSION:+host-$RELEASE_VERSION}"
[[ -n "$release_ref" ]] || release_ref="$(printf '%s' "$SOURCE_REF" | tr '/ ' '--' | tr -cd 'A-Za-z0-9._-')"
release_id="$release_ref-$release_stamp"
mkdir -p "$RELEASES_DIR/$release_id" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR" "$UNIT_DIR" "$(dirname "$CONTROL_LINK")"
chmod 0700 "$INSTANCE_ROOT" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"
for file in "${CORE_FILES[@]}"; do install -m 0644 "$SOURCE_DIR/$file" "$RELEASES_DIR/$release_id/$file"; done
mv "$RELEASES_DIR/$release_id/aru-selfhost-stub.mjs" "$RELEASES_DIR/$release_id/server.mjs"
chmod 0755 "$RELEASES_DIR/$release_id/server.mjs" "$RELEASES_DIR/$release_id/run-node.sh" \
  "$RELEASES_DIR/$release_id/install-linux-desktop.sh" "$RELEASES_DIR/$release_id/aru-selfhostctl-linux"
[[ -f "$SOURCE_DIR/release.json" ]] && install -m 0644 "$SOURCE_DIR/release.json" "$RELEASES_DIR/$release_id/release.json"

old_release="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
old_previous="$(readlink "$PREVIOUS_LINK" 2>/dev/null || true)"
ROLLBACK_TMP="$(mktemp -d "$INSTANCE_ROOT/.rollback.XXXXXX")"
for path in "$NODE_ENV" "$INSTALL_ENV" "$UNIT_PATH"; do [[ -f "$path" ]] && cp -p "$path" "$ROLLBACK_TMP/$(basename "$path")"; done
stop_service
[[ -z "$old_release" ]] || ln -sfn "$old_release" "$PREVIOUS_LINK"
ln -sfn "releases/$release_id" "$CURRENT_LINK"

write_env() {
  local destination="$1"; shift
  : > "$destination"; chmod 0600 "$destination"
  local name
  for name in "$@"; do printf '%s=%q\n' "$name" "${!name}" >> "$destination"; done
}

ARU_SERVER_ENTRY="$CURRENT_LINK/server.mjs"
ARU_NODE_BINARY="$NODE_BINARY"
ARU_LISTEN_HOST="0.0.0.0"
ARU_PORT="$PORT"
ARU_DATA_DIR="$DATA_DIR"
ARU_MANAGED_WORKSPACE_ROOT="$MANAGED_WORKSPACE_ROOT"
ARU_BASE_URL="$BASE_URL"
ARU_TRANSPORT_KIND="lan"
ARU_DISPLAY_NAME="$DISPLAY_NAME"
ARU_NODE_KIND="home-linux"
ARU_CONTAINER_RUNTIME="$CONTAINER_RUNTIME"
ARU_MAX_PACKAGE_MB="2048"
ARU_MAX_WORKSPACE_MB="512"
ARU_MAX_WORKSPACE_OUTPUT_MB="32"
ARU_CONTAINER_MEMORY="1g"
ARU_CONTAINER_CPUS="2"
ARU_NODE_IMAGE="node:22-alpine"
ARU_PYTHON_IMAGE="python:3.13-alpine"
ARU_SHELL_IMAGE="alpine:3.22"
write_env "$NODE_ENV" ARU_SERVER_ENTRY ARU_NODE_BINARY ARU_LISTEN_HOST ARU_PORT ARU_DATA_DIR \
  ARU_MANAGED_WORKSPACE_ROOT ARU_BASE_URL ARU_TRANSPORT_KIND ARU_DISPLAY_NAME ARU_NODE_KIND \
  ARU_CONTAINER_RUNTIME ARU_MAX_PACKAGE_MB ARU_MAX_WORKSPACE_MB ARU_MAX_WORKSPACE_OUTPUT_MB \
  ARU_CONTAINER_MEMORY ARU_CONTAINER_CPUS ARU_NODE_IMAGE ARU_PYTHON_IMAGE ARU_SHELL_IMAGE

ARU_INSTALL_INSTANCE="$INSTANCE"
ARU_INSTALL_BASE_ROOT="$BASE_ROOT"
ARU_INSTALL_BASE_URL="$BASE_URL"
ARU_INSTALL_DISPLAY_NAME="$DISPLAY_NAME"
ARU_INSTALL_PORT="$PORT"
ARU_INSTALL_SOURCE_REF="$SOURCE_REF"
ARU_INSTALL_BUNDLE_URL="$BUNDLE_URL"
ARU_INSTALL_RELEASE_VERSION="$RELEASE_VERSION"
ARU_INSTALL_SOURCE_DIR=""
[[ -z "$SOURCE_INPUT_DIR" ]] || ARU_INSTALL_SOURCE_DIR="$SOURCE_DIR"
write_env "$INSTALL_ENV" ARU_INSTALL_INSTANCE ARU_INSTALL_BASE_ROOT ARU_INSTALL_BASE_URL \
  ARU_INSTALL_DISPLAY_NAME ARU_INSTALL_PORT ARU_INSTALL_SOURCE_REF ARU_INSTALL_BUNDLE_URL \
  ARU_INSTALL_RELEASE_VERSION ARU_INSTALL_SOURCE_DIR

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Aru Host ($INSTANCE)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="ARU_SELFHOST_CONFIG_FILE=$NODE_ENV"
ExecStart=/bin/bash "$CURRENT_LINK/run-node.sh"
WorkingDirectory="$DATA_DIR"
Restart=always
RestartSec=3
UMask=0077
StandardOutput=append:$LOG_DIR/stdout.log
StandardError=append:$LOG_DIR/stderr.log

[Install]
WantedBy=default.target
EOF
chmod 0600 "$UNIT_PATH"
ln -sfn "$CURRENT_LINK/aru-selfhostctl-linux" "$CONTROL_LINK"

start_service() {
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
  for _ in {1..60}; do
    curl -fsS "http://127.0.0.1:$PORT/.well-known/aru.json" >/dev/null 2>&1 && return
    sleep 0.25
  done
  return 1
}

if [[ "$SKIP_START" != "true" ]] && ! start_service; then
  stop_service
  [[ -f "$ROLLBACK_TMP/node.env" ]] && cp -p "$ROLLBACK_TMP/node.env" "$NODE_ENV"
  [[ -f "$ROLLBACK_TMP/install.env" ]] && cp -p "$ROLLBACK_TMP/install.env" "$INSTALL_ENV"
  [[ -f "$ROLLBACK_TMP/$UNIT_NAME" ]] && cp -p "$ROLLBACK_TMP/$UNIT_NAME" "$UNIT_PATH"
  if [[ -n "$old_release" ]]; then ln -sfn "$old_release" "$CURRENT_LINK"; start_service || true
  else rm -f "$CURRENT_LINK"; fi
  if [[ -n "$old_previous" ]]; then ln -sfn "$old_previous" "$PREVIOUS_LINK"; else rm -f "$PREVIOUS_LINK"; fi
  rm -rf "$RELEASES_DIR/$release_id"
  die "new release failed health check; previous release restored"
fi

rm -rf "$ROLLBACK_TMP"; ROLLBACK_TMP=""
log "installed instance $INSTANCE release $release_id"
log "canonical URL: $BASE_URL"
[[ "$CONTAINER_RUNTIME" != "none" ]] || log "workspace jobs and OCI plugins are unavailable; source plugins remain available"
[[ "$SKIP_START" == "true" ]] || log "Host keeps running through systemd --user after the Console closes"
