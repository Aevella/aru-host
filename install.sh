#!/usr/bin/env bash
set -Eeuo pipefail

readonly PRODUCT="Aru self-hosted"
readonly SERVICE_NAME="aru-selfhost.service"
readonly SERVICE_USER="aru-selfhost"
readonly REPO_RAW_DEFAULT="https://raw.githubusercontent.com/Aevella/aru-host"

DOMAIN=""
BASE_URL=""
TRANSPORT_KIND=""
DISPLAY_NAME="Aru Self-Hosted"
PROFILE="full"
PORT="8787"
SOURCE_DIR=""
SOURCE_REF="main"
BUNDLE_URL=""
NODE_IMAGE="docker.io/library/node:22-alpine"
PYTHON_IMAGE="docker.io/library/python:3.13-alpine"
SHELL_IMAGE="docker.io/library/alpine:3.22"
SKIP_DEPENDENCIES="false"
SKIP_CADDY="false"
SKIP_FIREWALL="false"
SKIP_START="false"
UNINSTALL="false"
PURGE_DATA="false"
INSTALL_ROOT="${ARU_INSTALL_ROOT:-}"
PACKAGE_MANAGER=""

usage() {
  cat <<'EOF'
Install or upgrade an Aru self-hosted capability node.

Public HTTPS:
  curl -fsSL https://raw.githubusercontent.com/Aevella/aru-host/main/install.sh \
    | sudo bash -s -- --domain aru.example.com

Private LAN or Tailscale:
  sudo ./install.sh --base-url http://100.64.0.10:8787 --transport-kind tailscale

Options:
  --domain NAME             Public DNS name; installs/configures Caddy HTTPS.
  --base-url URL            Canonical URL for LAN/Tailscale or external proxy.
  --transport-kind KIND     public-https, tailscale, or lan.
  --display-name NAME       Name shown to Aru clients.
  --profile full            Persisted upgrade profile. full installs every currently
                            implemented capability bundle and adopts new ones on upgrade.
  --port PORT               Local node port (default 8787).
  --source-dir DIR          Install payload from a local aru-host checkout.
  --source-ref REF          Download payload from this Aevella/aru-host git ref (default main).
  --bundle-url URL          Install a release tarball and verify URL.sha256.
  --node-image IMAGE        Node workspace runtime image.
  --python-image IMAGE      Python workspace runtime image.
  --shell-image IMAGE       Shell workspace runtime image.
  --skip-dependencies       Do not install Node, Podman, or Caddy packages.
  --skip-caddy              Do not touch Caddy; an external proxy owns TLS.
  --skip-firewall           Do not add 80/443 rules when UFW is active.
  --skip-start              Install files without starting systemd.
  --uninstall               Remove service and program files; preserve data by default.
  --purge-data              With --uninstall, also remove /var/lib/aru-selfhost.
  --root DIR                Test-only filesystem prefix; skips dependencies and start.
  --help                    Show this help.
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

root_path() {
  printf '%s%s' "$INSTALL_ROOT" "$1"
}

for arg in "$@"; do
  [[ "$arg" == "--help" ]] && { usage; exit 0; }
done

while (($#)); do
  case "$1" in
    --domain) DOMAIN="${2:?missing value for --domain}"; shift 2 ;;
    --base-url) BASE_URL="${2:?missing value for --base-url}"; shift 2 ;;
    --transport-kind) TRANSPORT_KIND="${2:?missing value for --transport-kind}"; shift 2 ;;
    --display-name) DISPLAY_NAME="${2:?missing value for --display-name}"; shift 2 ;;
    --profile) PROFILE="${2:?missing value for --profile}"; shift 2 ;;
    --port) PORT="${2:?missing value for --port}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?missing value for --source-dir}"; shift 2 ;;
    --source-ref) SOURCE_REF="${2:?missing value for --source-ref}"; shift 2 ;;
    --bundle-url) BUNDLE_URL="${2:?missing value for --bundle-url}"; shift 2 ;;
    --node-image) NODE_IMAGE="${2:?missing value for --node-image}"; shift 2 ;;
    --python-image) PYTHON_IMAGE="${2:?missing value for --python-image}"; shift 2 ;;
    --shell-image) SHELL_IMAGE="${2:?missing value for --shell-image}"; shift 2 ;;
    --skip-dependencies) SKIP_DEPENDENCIES="true"; shift ;;
    --skip-caddy) SKIP_CADDY="true"; shift ;;
    --skip-firewall) SKIP_FIREWALL="true"; shift ;;
    --skip-start) SKIP_START="true"; shift ;;
    --uninstall) UNINSTALL="true"; shift ;;
    --purge-data) PURGE_DATA="true"; shift ;;
    --root) INSTALL_ROOT="${2:?missing value for --root}"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [[ -n "$INSTALL_ROOT" ]]; then
  [[ "$INSTALL_ROOT" == /* ]] || die "--root must be an absolute path"
  SKIP_DEPENDENCIES="true"
  SKIP_START="true"
fi

if [[ -z "$INSTALL_ROOT" && ${EUID:-$(id -u)} -ne 0 ]]; then
  die "run as root (normally through sudo)"
fi

validate_install_inputs() {
  [[ "$PROFILE" == "full" ]] || die "the only honest profile today is full; custom profiles arrive with real capability bundles"
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "port must be numeric"
  ((PORT >= 1 && PORT <= 65535)) || die "port must be between 1 and 65535"
  [[ "$DISPLAY_NAME" != *$'\n'* && -n "$DISPLAY_NAME" ]] || die "display name must be one line"
  [[ "$NODE_IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || die "node image is not a valid OCI reference"
  [[ "$PYTHON_IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || die "python image is not a valid OCI reference"
  [[ "$SHELL_IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || die "shell image is not a valid OCI reference"
  [[ "$SOURCE_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "source ref contains unsupported characters"

  if [[ -n "$DOMAIN" ]]; then
    [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ && "$DOMAIN" == *.* ]] || die "domain is invalid"
    [[ -z "$BASE_URL" ]] || die "choose --domain or --base-url, not both"
    BASE_URL="https://$DOMAIN"
    TRANSPORT_KIND="public-https"
  else
    [[ "$BASE_URL" =~ ^https?://[^[:space:]/]+(:[0-9]+)?$ ]] || die "--base-url must be an origin without a path"
    TRANSPORT_KIND="${TRANSPORT_KIND:-lan}"
    [[ "$TRANSPORT_KIND" == "lan" || "$TRANSPORT_KIND" == "tailscale" || "$TRANSPORT_KIND" == "public-https" ]] \
      || die "transport kind must be public-https, tailscale, or lan"
    if [[ "$TRANSPORT_KIND" == "public-https" && "$BASE_URL" != https://* ]]; then
      die "public-https requires an https:// base URL"
    fi
  fi
}

stop_service_if_present() {
  if [[ -z "$INSTALL_ROOT" && -x /bin/systemctl ]] && systemctl list-unit-files "$SERVICE_NAME" >/dev/null 2>&1; then
    systemctl stop "$SERVICE_NAME" || true
  fi
}

uninstall_node() {
  stop_service_if_present
  if [[ -z "$INSTALL_ROOT" && -x /bin/systemctl ]]; then
    systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  rm -f "$(root_path /etc/systemd/system/$SERVICE_NAME)"
  rm -f "$(root_path /usr/local/bin/aru-selfhost)"
  rm -rf "$(root_path /opt/aru-selfhost)"
  rm -rf "$(root_path /etc/aru-selfhost)"
  rm -f "$(root_path /etc/caddy/conf.d/aru-selfhost.caddy)"
  if [[ "$PURGE_DATA" == "true" ]]; then
    rm -rf "$(root_path /var/lib/aru-selfhost)"
    if [[ -z "$INSTALL_ROOT" ]] && id "$SERVICE_USER" >/dev/null 2>&1; then
      userdel "$SERVICE_USER" || log "service account retained because the host still reports it in use"
    fi
    log "program and durable data removed"
  else
    log "program removed; durable data preserved at /var/lib/aru-selfhost"
  fi
  if [[ -z "$INSTALL_ROOT" && -x /bin/systemctl ]]; then
    systemctl daemon-reload
    systemctl reload caddy >/dev/null 2>&1 || true
  fi
}

if [[ "$UNINSTALL" == "true" ]]; then
  uninstall_node
  exit 0
fi
[[ "$PURGE_DATA" == "false" ]] || die "--purge-data is valid only with --uninstall"
if [[ -n "$SOURCE_DIR" && -n "$BUNDLE_URL" ]]; then
  die "choose --source-dir or --bundle-url, not both"
fi

validate_install_inputs

if [[ -z "$INSTALL_ROOT" ]]; then
  [[ "$(uname -s)" == "Linux" ]] || die "production installation currently supports Linux VPS hosts"
  if command -v apt-get >/dev/null 2>&1; then
    PACKAGE_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PACKAGE_MANAGER="dnf"
  else
    die "production installer requires apt-get or dnf"
  fi
fi

install_node_runtime() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 18)); then
      return
    fi
  fi
  if [[ "$PACKAGE_MANAGER" == "apt" ]]; then
    log "installing Node.js 22 from the signed NodeSource apt repository"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
    install -d -m 0755 /etc/apt/keyrings
    download https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  else
    log "installing Node.js from the configured dnf repositories"
    dnf install -y ca-certificates curl nodejs
  fi
  command -v node >/dev/null 2>&1 || die "Node.js installation did not produce node"
}

install_capability_dependencies() {
  log "installing the current full capability profile (backup vault + rootless workspace runtime)"
  if [[ "$PACKAGE_MANAGER" == "apt" ]]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      ca-certificates curl podman uidmap slirp4netns fuse-overlayfs
  else
    dnf install -y \
      ca-certificates curl podman shadow-utils shadow-utils-subid slirp4netns fuse-overlayfs
  fi
}

install_caddy() {
  [[ -n "$DOMAIN" && "$SKIP_CADDY" != "true" ]] || return 0
  if [[ "$PACKAGE_MANAGER" == "dnf" ]]; then
    die "dnf hosts must use an existing HTTPS reverse proxy: pass --base-url, --transport-kind public-https, and --skip-caddy"
  fi
  if ! command -v caddy >/dev/null 2>&1; then
    log "installing Caddy for automatic HTTPS"
    DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    download https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    download https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
  fi
}

if [[ "$SKIP_DEPENDENCIES" != "true" ]]; then
  install_node_runtime
  install_capability_dependencies
  install_caddy
fi

ensure_service_user() {
  [[ -z "$INSTALL_ROOT" ]] || return 0
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --create-home --home-dir /var/lib/aru-selfhost --shell /usr/sbin/nologin --user-group "$SERVICE_USER"
  fi
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/aru-selfhost
  touch /etc/subuid /etc/subgid
  local start
  if ! grep -q "^${SERVICE_USER}:" /etc/subuid; then
    start="$(awk -F: 'BEGIN {m=200000} {e=$2+$3+65536; if(e>m)m=e} END {print m}' /etc/subuid)"
    usermod --add-subuids "${start}-$((start + 65535))" "$SERVICE_USER"
  fi
  if ! grep -q "^${SERVICE_USER}:" /etc/subgid; then
    start="$(awk -F: 'BEGIN {m=200000} {e=$2+$3+65536; if(e>m)m=e} END {print m}' /etc/subgid)"
    usermod --add-subgids "${start}-$((start + 65535))" "$SERVICE_USER"
  fi
}

ensure_service_user

prepare_container_config() {
  local config_file
  config_file="$(root_path /etc/aru-selfhost/containers.conf)"
  install -d -m 0755 "$(dirname "$config_file")"
  printf '%s\n' '[engine]' 'cgroup_manager = "cgroupfs"' > "$config_file"
  chmod 0644 "$config_file"
}

prepare_container_config

verify_node_runtime() {
  [[ -z "$INSTALL_ROOT" ]] || return 0
  command -v node >/dev/null 2>&1 || die "Node.js is missing"
  local major
  major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 18)) || die "Node.js 18 or newer is required"
}

verify_node_runtime

prepare_workspace_runtime() {
  [[ -z "$INSTALL_ROOT" ]] || return 0
  command -v podman >/dev/null 2>&1 || die "full profile requires Podman"
  local runtime_dir="/run/aru-selfhost"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$runtime_dir"
  local runtime_env=(
    env
    HOME=/var/lib/aru-selfhost
    XDG_RUNTIME_DIR="$runtime_dir"
    CONTAINERS_CONF=/etc/aru-selfhost/containers.conf
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/libexec/podman:/usr/libexec/catatonit
  )
  if ! (
    cd /var/lib/aru-selfhost
    runuser -u "$SERVICE_USER" -- "${runtime_env[@]}" podman info >/dev/null
  ); then
    die "rootless Podman preflight failed for $SERVICE_USER"
  fi
  local image
  for image in "$NODE_IMAGE" "$PYTHON_IMAGE" "$SHELL_IMAGE"; do
    log "preparing workspace runtime image $image"
    (
      cd /var/lib/aru-selfhost
      runuser -u "$SERVICE_USER" -- "${runtime_env[@]}" podman pull "$image" >/dev/null
    ) || die "failed to prepare workspace runtime image $image"
  done
}

prepare_workspace_runtime

SOURCE_TMP=""
cleanup() {
  [[ -z "$SOURCE_TMP" ]] || rm -rf "$SOURCE_TMP"
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fetch_source_payload() {
  if [[ -n "$SOURCE_DIR" ]]; then
    SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
    return
  fi
  SOURCE_TMP="$(mktemp -d)"
  if [[ -n "$BUNDLE_URL" ]]; then
    log "downloading hash-verified release bundle"
    download "$BUNDLE_URL" -o "$SOURCE_TMP/bundle.tar.gz"
    download "${BUNDLE_URL}.sha256" -o "$SOURCE_TMP/bundle.tar.gz.sha256"
    local expected actual
    expected="$(awk '{print $1}' "$SOURCE_TMP/bundle.tar.gz.sha256")"
    actual="$(sha256_file "$SOURCE_TMP/bundle.tar.gz")"
    [[ "$expected" == "$actual" ]] || die "release bundle SHA-256 mismatch"
    local entries expected_entries
    entries="$(tar -tzf "$SOURCE_TMP/bundle.tar.gz" | LC_ALL=C sort)"
    expected_entries="$(printf '%s\n' \
      aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-conversations.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs \
      aru-selfhost.service aru-selfhostctl install.sh run-node.sh \
      | LC_ALL=C sort)"
    [[ "$entries" == "$expected_entries" ]] || die "release bundle contains an unexpected file set"
    mkdir -p "$SOURCE_TMP/payload"
    tar -xzf "$SOURCE_TMP/bundle.tar.gz" -C "$SOURCE_TMP/payload"
    SOURCE_DIR="$SOURCE_TMP/payload"
    return
  fi
  local raw="$REPO_RAW_DEFAULT/$SOURCE_REF"
  log "downloading node payload from Aevella/aru-host@$SOURCE_REF"
  for file in aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-conversations.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs run-node.sh aru-selfhost.service aru-selfhostctl install.sh; do
    download "$raw/$file" -o "$SOURCE_TMP/$file"
  done
  SOURCE_DIR="$SOURCE_TMP"
}

fetch_source_payload
for file in aru-selfhost-stub.mjs backup-settings.mjs conversation-turn-relay.mjs collaborator-host.mjs collaborator-cognition.mjs collaborator-surfaces.mjs collaborator-conversations.mjs codex-app-server-driver.mjs direct-api-driver.mjs provider-profiles.mjs provider-secret-store.mjs node-control.mjs node-workspaces.mjs plugin-supervisor.mjs plugin-workshop.mjs source-plugin-runtime.mjs source-plugin-runner.mjs run-node.sh aru-selfhost.service aru-selfhostctl install.sh; do
  [[ -f "$SOURCE_DIR/$file" ]] || die "payload is missing $file"
done

release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
release_ref="$(printf '%s' "$SOURCE_REF" | tr '/ ' '--' | tr -cd 'A-Za-z0-9._-')"
release_base="${release_ref:-bundle}-$release_stamp"
release_id="$release_base"
release_suffix=1
while [[ -e "$(root_path /opt/aru-selfhost/releases/$release_id)" ]]; do
  release_id="${release_base}-${release_suffix}"
  release_suffix=$((release_suffix + 1))
done
release_dir="$(root_path /opt/aru-selfhost/releases/$release_id)"
mkdir -p "$release_dir"
install -m 0755 "$SOURCE_DIR/aru-selfhost-stub.mjs" "$release_dir/server.mjs"
install -m 0644 "$SOURCE_DIR/backup-settings.mjs" "$release_dir/backup-settings.mjs"
install -m 0644 "$SOURCE_DIR/conversation-turn-relay.mjs" "$release_dir/conversation-turn-relay.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-host.mjs" "$release_dir/collaborator-host.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-cognition.mjs" "$release_dir/collaborator-cognition.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-surfaces.mjs" "$release_dir/collaborator-surfaces.mjs"
install -m 0644 "$SOURCE_DIR/collaborator-conversations.mjs" "$release_dir/collaborator-conversations.mjs"
install -m 0644 "$SOURCE_DIR/codex-app-server-driver.mjs" "$release_dir/codex-app-server-driver.mjs"
install -m 0644 "$SOURCE_DIR/direct-api-driver.mjs" "$release_dir/direct-api-driver.mjs"
install -m 0644 "$SOURCE_DIR/provider-profiles.mjs" "$release_dir/provider-profiles.mjs"
install -m 0644 "$SOURCE_DIR/provider-secret-store.mjs" "$release_dir/provider-secret-store.mjs"
install -m 0644 "$SOURCE_DIR/node-control.mjs" "$release_dir/node-control.mjs"
install -m 0644 "$SOURCE_DIR/node-workspaces.mjs" "$release_dir/node-workspaces.mjs"
install -m 0644 "$SOURCE_DIR/plugin-supervisor.mjs" "$release_dir/plugin-supervisor.mjs"
install -m 0644 "$SOURCE_DIR/plugin-workshop.mjs" "$release_dir/plugin-workshop.mjs"
install -m 0644 "$SOURCE_DIR/source-plugin-runtime.mjs" "$release_dir/source-plugin-runtime.mjs"
install -m 0644 "$SOURCE_DIR/source-plugin-runner.mjs" "$release_dir/source-plugin-runner.mjs"
install -m 0755 "$SOURCE_DIR/run-node.sh" "$release_dir/run-node.sh"
install -m 0755 "$SOURCE_DIR/install.sh" "$release_dir/install.sh"
old_release="$(readlink "$(root_path /opt/aru-selfhost/current)" 2>/dev/null || true)"
if [[ -n "$old_release" ]]; then
  ln -sfn "$old_release" "$(root_path /opt/aru-selfhost/previous)"
fi
ln -sfn "releases/$release_id" "$(root_path /opt/aru-selfhost/current)"

mkdir -p \
  "$(root_path /etc/aru-selfhost)" \
  "$(root_path /etc/systemd/system)" \
  "$(root_path /usr/local/bin)" \
  "$(root_path /var/lib/aru-selfhost/tmp)"

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

ARU_SERVER_ENTRY="/opt/aru-selfhost/current/server.mjs"
ARU_NODE_BINARY="$(command -v node || printf '/usr/bin/node')"
if [[ "$TRANSPORT_KIND" == "public-https" ]]; then
  ARU_LISTEN_HOST="127.0.0.1"
else
  ARU_LISTEN_HOST="0.0.0.0"
fi
ARU_PORT="$PORT"
ARU_DATA_DIR="/var/lib/aru-selfhost/data"
ARU_BASE_URL="$BASE_URL"
ARU_TRANSPORT_KIND="$TRANSPORT_KIND"
ARU_DISPLAY_NAME="$DISPLAY_NAME"
ARU_NODE_KIND="vps"
ARU_CONTAINER_RUNTIME="podman"
ARU_MAX_PACKAGE_MB="2048"
ARU_MAX_WORKSPACE_MB="512"
ARU_MAX_WORKSPACE_OUTPUT_MB="32"
ARU_CONTAINER_MEMORY="1g"
ARU_CONTAINER_CPUS="2"
ARU_NODE_IMAGE="$NODE_IMAGE"
ARU_PYTHON_IMAGE="$PYTHON_IMAGE"
ARU_SHELL_IMAGE="$SHELL_IMAGE"
write_env "$(root_path /etc/aru-selfhost/node.env)" \
  ARU_SERVER_ENTRY ARU_NODE_BINARY ARU_LISTEN_HOST ARU_PORT ARU_DATA_DIR ARU_BASE_URL \
  ARU_TRANSPORT_KIND ARU_DISPLAY_NAME ARU_NODE_KIND ARU_CONTAINER_RUNTIME \
  ARU_MAX_PACKAGE_MB ARU_MAX_WORKSPACE_MB ARU_MAX_WORKSPACE_OUTPUT_MB \
  ARU_CONTAINER_MEMORY ARU_CONTAINER_CPUS ARU_NODE_IMAGE ARU_PYTHON_IMAGE ARU_SHELL_IMAGE
chmod 0640 "$(root_path /etc/aru-selfhost/node.env)"

ARU_INSTALL_PROFILE="$PROFILE"
ARU_INSTALL_DOMAIN="$DOMAIN"
ARU_INSTALL_BASE_URL="$BASE_URL"
ARU_INSTALL_TRANSPORT_KIND="$TRANSPORT_KIND"
ARU_INSTALL_DISPLAY_NAME="$DISPLAY_NAME"
ARU_INSTALL_PORT="$PORT"
ARU_INSTALL_SOURCE_REF="$SOURCE_REF"
ARU_INSTALL_BUNDLE_URL="$BUNDLE_URL"
ARU_INSTALL_NODE_IMAGE="$NODE_IMAGE"
ARU_INSTALL_PYTHON_IMAGE="$PYTHON_IMAGE"
ARU_INSTALL_SHELL_IMAGE="$SHELL_IMAGE"
ARU_INSTALL_SKIP_CADDY="$SKIP_CADDY"
ARU_INSTALL_SKIP_FIREWALL="$SKIP_FIREWALL"
write_env "$(root_path /etc/aru-selfhost/install.env)" \
  ARU_INSTALL_PROFILE ARU_INSTALL_DOMAIN ARU_INSTALL_BASE_URL ARU_INSTALL_TRANSPORT_KIND \
  ARU_INSTALL_DISPLAY_NAME ARU_INSTALL_PORT ARU_INSTALL_SOURCE_REF ARU_INSTALL_BUNDLE_URL \
  ARU_INSTALL_NODE_IMAGE ARU_INSTALL_PYTHON_IMAGE ARU_INSTALL_SHELL_IMAGE \
  ARU_INSTALL_SKIP_CADDY ARU_INSTALL_SKIP_FIREWALL

install -m 0644 "$SOURCE_DIR/aru-selfhost.service" "$(root_path /etc/systemd/system/$SERVICE_NAME)"
install -m 0755 "$SOURCE_DIR/aru-selfhostctl" "$(root_path /usr/local/bin/aru-selfhost)"

if [[ -z "$INSTALL_ROOT" ]]; then
  mkdir -p /var/lib/aru-selfhost/data /var/lib/aru-selfhost/tmp
  chown -R "$SERVICE_USER:$SERVICE_USER" /var/lib/aru-selfhost
  chown "root:$SERVICE_USER" /etc/aru-selfhost/node.env
  chown root:root /etc/aru-selfhost/install.env
fi

configure_caddy() {
  [[ -n "$DOMAIN" && "$SKIP_CADDY" != "true" ]] || return 0
  local caddy_dir caddy_file fragment
  caddy_dir="$(root_path /etc/caddy/conf.d)"
  caddy_file="$(root_path /etc/caddy/Caddyfile)"
  fragment="$caddy_dir/aru-selfhost.caddy"
  mkdir -p "$caddy_dir"
  cat > "$fragment" <<EOF
$DOMAIN {
    encode zstd gzip
    reverse_proxy 127.0.0.1:$PORT
}
EOF
  touch "$caddy_file"
  if ! grep -Fqx 'import /etc/caddy/conf.d/*.caddy' "$caddy_file"; then
    printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> "$caddy_file"
  fi
}

configure_caddy

configure_firewall() {
  [[ -n "$DOMAIN" && "$SKIP_FIREWALL" != "true" && -z "$INSTALL_ROOT" ]] || return 0
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -Fq 'Status: active'; then
    log "opening only HTTP/HTTPS for Caddy in active UFW"
    ufw allow 80/tcp comment 'Aru self-hosted HTTPS' >/dev/null
    ufw allow 443/tcp comment 'Aru self-hosted HTTPS' >/dev/null
  fi
}

configure_firewall

if [[ "$SKIP_START" != "true" ]]; then
  if [[ -n "$DOMAIN" && "$SKIP_CADDY" != "true" ]]; then
    if ! caddy validate --config /etc/caddy/Caddyfile; then
      if [[ -n "$old_release" ]]; then
        ln -sfn "$old_release" /opt/aru-selfhost/current
      fi
      die "Caddy configuration is invalid; restored the previous release pointer"
    fi
  fi
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  if [[ -n "$DOMAIN" && "$SKIP_CADDY" != "true" ]]; then
    systemctl enable --now caddy
    systemctl reload caddy
  fi
  sleep 1
  if ! curl -fsS "http://127.0.0.1:$PORT/.well-known/aru.json" >/dev/null; then
    if [[ -n "$old_release" ]]; then
      ln -sfn "$old_release" /opt/aru-selfhost/current
      systemctl restart "$SERVICE_NAME" || true
      die "new release failed its manifest health check and was rolled back"
    fi
    die "service started but local manifest health check failed; run /usr/local/bin/aru-selfhost doctor"
  fi
fi

log "installed release $release_id"
log "profile: $PROFILE (future upgrades add newly implemented capability bundles to this profile)"
log "canonical URL: $BASE_URL"
if [[ "$SKIP_START" != "true" ]]; then
  log "run 'sudo /usr/local/bin/aru-selfhost pairing' to issue a fresh 10-minute pairing link"
fi
