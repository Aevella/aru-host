#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELFHOST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="${ARU_HOST_VERSION:-0.29.1-dev}"
BUILD_NUMBER="${ARU_HOST_BUILD_NUMBER:-1}"
OUTPUT_APP="$SCRIPT_DIR/.build-local/Aru Host Console.app"
SIGNING_IDENTITY="${ARU_HOST_CONSOLE_SIGNING_IDENTITY:-}"
UNIVERSAL="false"
DISTRIBUTION="false"

usage() {
  cat <<'EOF'
Build the native Aru Host Console app with its matching Host Core payload.

Options:
  --version VER          Semantic release version embedded in App and Host Core.
  --build NUMBER         CFBundleVersion value.
  --output APP           Destination .app path.
  --identity IDENTITY    Codesigning identity name or SHA-1.
  --universal            Build and lipo arm64 plus x86_64 executables.
  --distribution         Require Developer ID and use hardened runtime + timestamp.
  --help                 Show this help.
EOF
}

while (($#)); do
  case "$1" in
    --version) VERSION="${2:?missing value for --version}"; shift 2 ;;
    --build) BUILD_NUMBER="${2:?missing value for --build}"; shift 2 ;;
    --output) OUTPUT_APP="${2:?missing value for --output}"; shift 2 ;;
    --identity) SIGNING_IDENTITY="${2:?missing value for --identity}"; shift 2 ;;
    --universal) UNIVERSAL="true"; shift ;;
    --distribution) DISTRIBUTION="true"; shift ;;
    --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]] \
  || { echo "invalid Host version: $VERSION" >&2; exit 1; }
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] \
  || { echo "build number must be a positive integer" >&2; exit 1; }
[[ "$OUTPUT_APP" == /* ]] || OUTPUT_APP="$PWD/$OUTPUT_APP"

if [[ -z "$SIGNING_IDENTITY" ]]; then
  if [[ "$DISTRIBUTION" == "true" ]]; then
    SIGNING_IDENTITY="$(security find-identity -v -p codesigning \
      | awk '/"Developer ID Application:/{print $2; exit}')"
  else
    SIGNING_IDENTITY="$(security find-identity -v -p codesigning \
      | awk '/"Apple Development:|"Developer ID Application:/{print $2; exit}')"
  fi
fi
[[ -n "$SIGNING_IDENTITY" ]] \
  || { echo "no suitable stable codesigning identity is available" >&2; exit 1; }
if [[ "$DISTRIBUTION" == "true" ]]; then
  if [[ "$SIGNING_IDENTITY" != *"Developer ID Application:"* ]] \
     && ! security find-identity -v -p codesigning \
       | grep -F "$SIGNING_IDENTITY" \
       | grep -Fq '"Developer ID Application:'; then
    echo "distribution builds require a Developer ID Application identity" >&2
    exit 1
  fi
fi

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aru-host-console-build.XXXXXX")"
trap 'rm -rf "$BUILD_ROOT"' EXIT
SDK="$(xcrun --sdk macosx --show-sdk-path)"

build_architecture() {
  local architecture="$1" scratch="$BUILD_ROOT/$1" triple="$1-apple-macosx26.0"
  swift build \
    --package-path "$SCRIPT_DIR" \
    --scratch-path "$scratch" \
    --configuration release \
    --triple "$triple" \
    --sdk "$SDK"
  swift build \
    --package-path "$SCRIPT_DIR" \
    --scratch-path "$scratch" \
    --configuration release \
    --triple "$triple" \
    --sdk "$SDK" \
    --show-bin-path
}

arm_bin="$(build_architecture arm64 | tail -1)"
if [[ "$UNIVERSAL" == "true" ]]; then
  x86_bin="$(build_architecture x86_64 | tail -1)"
fi

rm -rf "$OUTPUT_APP"
mkdir -p "$OUTPUT_APP/Contents/MacOS" "$OUTPUT_APP/Contents/Resources"
if [[ "$UNIVERSAL" == "true" ]]; then
  lipo -create \
    "$arm_bin/AruHostConsole" \
    "$x86_bin/AruHostConsole" \
    -output "$OUTPUT_APP/Contents/MacOS/AruHostConsole"
else
  install -m 0755 "$arm_bin/AruHostConsole" "$OUTPUT_APP/Contents/MacOS/AruHostConsole"
fi
chmod 0755 "$OUTPUT_APP/Contents/MacOS/AruHostConsole"

resource_bundle="$arm_bin/AruHostConsole_AruHostConsole.bundle"
[[ -d "$resource_bundle" ]] || { echo "Console resource bundle is missing" >&2; exit 1; }
cp -R "$resource_bundle" "$OUTPUT_APP/Contents/Resources/"
"$SELFHOST_DIR/bundle-host-core.sh" "$OUTPUT_APP/Contents/Resources/HostCore" "$VERSION"

plist="$OUTPUT_APP/Contents/Info.plist"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh-Hans</string>
  <key>CFBundleDisplayName</key><string>Aru Host</string>
  <key>CFBundleExecutable</key><string>AruHostConsole</string>
  <key>CFBundleIdentifier</key><string>cn.aelion.aru.host-console</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Aru Host</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
plutil -lint "$plist" >/dev/null

sign_args=(--force --options runtime --sign "$SIGNING_IDENTITY")
if [[ "$DISTRIBUTION" == "true" ]]; then
  sign_args+=(--timestamp)
else
  sign_args+=(--timestamp=none)
fi
codesign "${sign_args[@]}" "$OUTPUT_APP"
codesign --verify --strict --verbose=2 "$OUTPUT_APP"
designated_requirement="$(codesign -d -r- "$OUTPUT_APP" 2>&1)"
[[ "$designated_requirement" != *'cdhash H'* ]] \
  || { echo "Console received an unstable cdhash-only designated requirement" >&2; exit 1; }

if [[ "$UNIVERSAL" == "true" ]]; then
  architectures="$(lipo -archs "$OUTPUT_APP/Contents/MacOS/AruHostConsole")"
  [[ "$architectures" == *arm64* && "$architectures" == *x86_64* ]] \
    || { echo "Console executable is not universal" >&2; exit 1; }
fi

printf '%s\n' "$OUTPUT_APP"
