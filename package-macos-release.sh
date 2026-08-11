#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${1:-$PWD/aru-selfhost-macos.tar.gz}"
VERSION="${2:-${ARU_HOST_VERSION:-0.29.2-dev}}"
[[ "$OUTPUT" == /* ]] || OUTPUT="$PWD/$OUTPUT"

mkdir -p "$(dirname "$OUTPUT")"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
"$SCRIPT_DIR/bundle-host-core.sh" "$temp/payload" "$VERSION"
payload_files=()
for path in "$temp/payload"/*; do
  payload_files+=("$(basename "$path")")
done
tar -czf "$OUTPUT" -C "$temp/payload" "${payload_files[@]}"
(cd "$(dirname "$OUTPUT")" && shasum -a 256 "$(basename "$OUTPUT")") > "${OUTPUT}.sha256"
echo "$OUTPUT"
echo "${OUTPUT}.sha256"
