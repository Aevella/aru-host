#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION=""
ARCH=""
OUTPUT_DIR="$ROOT/linux-console/dist-release"

usage() {
  cat <<'EOF'
Usage: package-linux-desktop.sh --version X.Y.Z --arch x64|arm64 [--output-dir DIR]

Builds one Debian/Ubuntu desktop package, verifies its embedded Host Core and
package metadata, and writes matching SHA-256 and JSON release receipts.
EOF
}
die() { echo "package-linux-desktop: $*" >&2; exit 1; }

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

package_version="$(node -p 'require(process.argv[1]).version' "$ROOT/linux-console/package.json")"
[[ "$package_version" == "$VERSION" ]] || die "package version $package_version does not match release $VERSION"

"$ROOT/bundle-linux-desktop-host-core.sh" "$ROOT/linux-console/.host-core" "$VERSION"

(
  cd "$ROOT/linux-console"
  npm run dist:deb -- "--$ARCH"
)

artifact="aru-host-linux-$VERSION-$ARCH.deb"
builder_arch="$ARCH"
[[ "$ARCH" != "x64" ]] || builder_arch="amd64"
source_deb="$ROOT/linux-console/dist/aru-host-linux-$VERSION-$builder_arch.deb"
[[ -f "$source_deb" ]] || die "builder did not produce the $ARCH Debian package"
bash "$ROOT/tests/linux-desktop-package-smoke.sh" "$source_deb" "$VERSION"

mkdir -p "$OUTPUT_DIR"
destination="$OUTPUT_DIR/$artifact"
install -m 0644 "$source_deb" "$destination"

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
    schema: "aru.host.linux-distribution.v1",
    version,
    architecture: arch,
    artifact,
    sha256: digest,
    bytes: Number(bytes),
    hostCoreVersion: version,
  }, null, 2) + "\n");
' "$OUTPUT_DIR/aru-host-linux-$VERSION-$ARCH.json" "$VERSION" "$ARCH" "$artifact" "$digest" "$bytes"

printf '%s\n' "$destination" "$destination.sha256" "$OUTPUT_DIR/aru-host-linux-$VERSION-$ARCH.json"
