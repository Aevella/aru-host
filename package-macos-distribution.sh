#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=""
BUILD_NUMBER=""
OUTPUT_DIR="$SCRIPT_DIR/dist"
SIGNING_IDENTITY="${ARU_HOST_CONSOLE_SIGNING_IDENTITY:-}"
NOTARY_PROFILE="${ARU_HOST_NOTARY_PROFILE:-}"

usage() {
  cat <<'EOF'
Build, sign, notarize, staple, and verify the universal Aru Host distribution.

Options:
  --version VER          Required semantic release version.
  --build NUMBER         Required positive CFBundleVersion.
  --output-dir DIR       Artifact directory (default: scripts/selfhost/dist).
  --identity IDENTITY    Developer ID Application identity name or SHA-1.
  --notary-profile NAME  notarytool Keychain profile.
  --help                 Show this help.
EOF
}

while (($#)); do
  case "$1" in
    --version) VERSION="${2:?missing value for --version}"; shift 2 ;;
    --build) BUILD_NUMBER="${2:?missing value for --build}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:?missing value for --output-dir}"; shift 2 ;;
    --identity) SIGNING_IDENTITY="${2:?missing value for --identity}"; shift 2 ;;
    --notary-profile) NOTARY_PROFILE="${2:?missing value for --notary-profile}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$VERSION" && -n "$BUILD_NUMBER" ]] \
  || { echo "--version and --build are required" >&2; exit 1; }
[[ -n "$NOTARY_PROFILE" ]] \
  || { echo "a notarytool Keychain profile is required" >&2; exit 1; }
[[ "$OUTPUT_DIR" == /* ]] || OUTPUT_DIR="$PWD/$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

app="$work/Aru Host.app"
"$SCRIPT_DIR/macos-console/build-app.sh" \
  --version "$VERSION" \
  --build "$BUILD_NUMBER" \
  --output "$app" \
  --identity "$SIGNING_IDENTITY" \
  --universal \
  --distribution

mkdir -p "$work/dmg"
cp -R "$app" "$work/dmg/Aru Host.app"
ln -s /Applications "$work/dmg/Applications"
dmg="$OUTPUT_DIR/aru-host-macos-$VERSION.dmg"
rm -f "$dmg" "$dmg.sha256" "$OUTPUT_DIR/aru-host-macos-$VERSION.json"
hdiutil create \
  -volname "Aru Host $VERSION" \
  -srcfolder "$work/dmg" \
  -ov \
  -format UDZO \
  "$dmg" >/dev/null
codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$dmg"

xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"

sha="$(shasum -a 256 "$dmg" | awk '{print $1}')"
printf '%s  %s\n' "$sha" "$(basename "$dmg")" > "$dmg.sha256"
cat > "$OUTPUT_DIR/aru-host-macos-$VERSION.json" <<EOF
{"schema":"aru.host.macos-release.v1","version":"$VERSION","build":"$BUILD_NUMBER","sha256":"$sha","asset":"$(basename "$dmg")"}
EOF

printf '%s\n' "$dmg" "$dmg.sha256" "$OUTPUT_DIR/aru-host-macos-$VERSION.json"
