#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION=""
ARCH=""
OUTPUT_DIR="$ROOT/desktop-console/dist-release"

usage() {
  cat <<'EOF'
Usage: package-windows-desktop.sh --version X.Y.Z --arch x64|arm64 [--output-dir DIR]

Builds one Windows NSIS per-user installer, verifies the unpacked app layout
and embedded Host Core, and writes matching SHA-256 and JSON release receipts.
Code signing is a separate explicit step: set the electron-builder
CSC_LINK/CSC_KEY_PASSWORD (or Azure Trusted Signing) environment before a
stable release build. Unsigned output is a development or preview artifact.
EOF
}
die() { echo "package-windows-desktop: $*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --version) VERSION="${2:?missing version}"; shift 2 ;;
    --arch) ARCH="${2:?missing architecture}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:?missing output directory}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must be X.Y.Z"
[[ "$ARCH" == "x64" || "$ARCH" == "arm64" ]] || die "--arch must be x64 or arm64"

package_version="$(node -p 'require(process.argv[1]).version' "$ROOT/desktop-console/package.json")"
[[ "$package_version" == "$VERSION" ]] || die "package version $package_version does not match release $VERSION"

node "$ROOT/bundle-windows-desktop-host-core.mjs" "$ROOT/desktop-console/.host-core" "$VERSION"

(
  cd "$ROOT/desktop-console"
  npm run dist:win -- "--$ARCH"
)

artifact="aru-host-windows-$VERSION-$ARCH.exe"
source_exe="$ROOT/desktop-console/dist/$artifact"
[[ -f "$source_exe" ]] || die "builder did not produce the $ARCH Windows installer"
bash "$ROOT/tests/windows-desktop-package-smoke.sh" "$ROOT/desktop-console" "$VERSION" "$ARCH"

mkdir -p "$OUTPUT_DIR"
destination="$OUTPUT_DIR/$artifact"
install -m 0644 "$source_exe" "$destination"

if command -v sha256sum >/dev/null 2>&1; then
  digest="$(sha256sum "$destination" | awk '{print $1}')"
else
  digest="$(shasum -a 256 "$destination" | awk '{print $1}')"
fi
printf '%s  %s\n' "$digest" "$artifact" > "$destination.sha256"

bytes="$(wc -c < "$destination" | tr -d ' ')"
node -e '
  const fs = require("node:fs");
  const [path, version, arch, artifact, digest, bytes] = process.argv.slice(1);
  fs.writeFileSync(path, JSON.stringify({
    schema: "aru.host.windows-distribution.v1",
    version,
    architecture: arch,
    channel: "preview",
    signing: "unsigned",
    artifact,
    sha256: digest,
    bytes: Number(bytes),
    hostCoreVersion: version,
  }, null, 2) + "\n");
' "$OUTPUT_DIR/aru-host-windows-$VERSION-$ARCH.json" "$VERSION" "$ARCH" "$artifact" "$digest" "$bytes"

printf '%s\n' "$destination" "$destination.sha256" "$OUTPUT_DIR/aru-host-windows-$VERSION-$ARCH.json"
