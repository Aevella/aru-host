#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONFIG_FILE="${ARU_SELFHOST_CONFIG_FILE:-/etc/aru-selfhost/node.env}"

if [[ ! -r "$CONFIG_FILE" ]]; then
  echo "Aru self-hosted config is not readable: $CONFIG_FILE" >&2
  exit 78
fi

# node.env is written by install.sh with shell-escaped values and is root-owned.
# shellcheck disable=SC1090
source "$CONFIG_FILE"

required=(
  ARU_SERVER_ENTRY
  ARU_LISTEN_HOST
  ARU_PORT
  ARU_DATA_DIR
  ARU_BASE_URL
  ARU_TRANSPORT_KIND
  ARU_DISPLAY_NAME
  ARU_NODE_KIND
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Aru self-hosted config is missing $name" >&2
    exit 78
  fi
done

export ARU_PROVIDER_SECRET_ROOT="${ARU_PROVIDER_SECRET_ROOT:-}"

args=(
  "$ARU_SERVER_ENTRY"
  --listen-host "$ARU_LISTEN_HOST"
  --port "$ARU_PORT"
  --data-dir "$ARU_DATA_DIR"
  --base-url "$ARU_BASE_URL"
  --wake-relay-url "${ARU_WAKE_RELAY_URL:-https://wake.aelion.cn}"
  --transport-kind "$ARU_TRANSPORT_KIND"
  --display-name "$ARU_DISPLAY_NAME"
  --node-kind "$ARU_NODE_KIND"
  --max-package-mb "${ARU_MAX_PACKAGE_MB:-2048}"
  --max-workspace-mb "${ARU_MAX_WORKSPACE_MB:-512}"
  --max-workspace-output-mb "${ARU_MAX_WORKSPACE_OUTPUT_MB:-32}"
  --plugin-call-timeout-seconds "${ARU_PLUGIN_CALL_TIMEOUT_SECONDS:-3600}"
  --container-memory "${ARU_CONTAINER_MEMORY:-1g}"
  --container-cpus "${ARU_CONTAINER_CPUS:-2}"
  --node-image "${ARU_NODE_IMAGE:-node:22-alpine}"
  --python-image "${ARU_PYTHON_IMAGE:-python:3.13-alpine}"
  --shell-image "${ARU_SHELL_IMAGE:-alpine:3.22}"
)

if [[ -n "${ARU_LOCAL_OPERATOR_CREDENTIAL_SHA256:-}" ]]; then
  args+=(--local-operator-credential-sha256 "$ARU_LOCAL_OPERATOR_CREDENTIAL_SHA256")
fi

# Production systemd decrypts the machine-bound vault key into a private
# runtime credential directory. Test-root installs may point at a fixture key.
if [[ -n "${ARU_PROVIDER_SECRET_CREDENTIAL_ID:-}" && -n "${CREDENTIALS_DIRECTORY:-}" ]]; then
  ARU_PROVIDER_SECRET_KEY_FILE="$CREDENTIALS_DIRECTORY/$ARU_PROVIDER_SECRET_CREDENTIAL_ID"
fi
# The provider secret owner reads only these two non-secret locations. The
# service never receives the root-only local operator bearer credential.
if [[ -n "${ARU_PROVIDER_SECRET_KEY_FILE:-}" && -n "${ARU_PROVIDER_SECRET_ROOT:-}" ]]; then
  [[ -r "$ARU_PROVIDER_SECRET_KEY_FILE" ]] || {
    echo "Aru self-hosted provider vault credential is unavailable" >&2
    exit 78
  }
  export ARU_PROVIDER_SECRET_KEY_FILE ARU_PROVIDER_SECRET_ROOT
fi

if [[ -n "${ARU_MANAGED_WORKSPACE_ROOT:-}" ]]; then
  args+=(--managed-workspace-root "$ARU_MANAGED_WORKSPACE_ROOT")
fi

if [[ -n "${ARU_CONTAINER_RUNTIME:-}" ]]; then
  args+=(--container-runtime "$ARU_CONTAINER_RUNTIME")
fi

if [[ "$(uname -s)" == Darwin ]]; then
  args+=(--launchd-supervised)
fi

exec "${ARU_NODE_BINARY:-/usr/bin/node}" "${args[@]}"
