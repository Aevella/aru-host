#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/build-app.sh" \
  --version "${ARU_HOST_VERSION:-0.29.0-dev}" \
  --build "${ARU_HOST_BUILD_NUMBER:-1}" \
  --output "$SCRIPT_DIR/.build-local/Aru Host Console.app"
