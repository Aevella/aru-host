#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="$SCRIPT_DIR/.build-local"
APP_NAME="Aru Host Console"
APP="$BUILD_ROOT/$APP_NAME.app"

swift build \
  --package-path "$SCRIPT_DIR" \
  --scratch-path "$BUILD_ROOT/swift" \
  -c release

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
install -m 0755 "$BUILD_ROOT/swift/release/AruHostConsole" "$APP/Contents/MacOS/AruHostConsole"

resource_bundle="$BUILD_ROOT/swift/release/AruHostConsole_AruHostConsole.bundle"
if [[ -d "$resource_bundle" ]]; then
  cp -R "$resource_bundle" "$APP/Contents/Resources/"
fi

apply_plist="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDevelopmentRegion string zh-Hans' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Aru Host' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string AruHostConsole' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string cn.aelion.aru.host-console' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleInfoDictionaryVersion string 6.0' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleName string Aru Host' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleShortVersionString string 0.3.1' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleVersion string 6' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :LSMinimumSystemVersion string 26.0' "$apply_plist"
/usr/libexec/PlistBuddy -c 'Add :NSHighResolutionCapable bool true' "$apply_plist"

signing_candidates="${ARU_HOST_CONSOLE_SIGNING_IDENTITY:-}"
if [[ -z "$signing_candidates" ]]; then
  signing_candidates="$(security find-identity -v -p codesigning \
    | awk '/"Apple Development:|"Developer ID Application:/{print $2}')"
fi
if [[ -z "$signing_candidates" ]]; then
  echo "Aru Host Console needs a stable Apple Development or Developer ID signing identity." >&2
  echo "Ad-hoc signing is intentionally rejected because every rebuild would lose Keychain identity." >&2
  exit 1
fi
signed=false
for signing_identity in $signing_candidates; do
  if codesign --force --sign "$signing_identity" "$APP"; then
    signed=true
    break
  fi
done
if [[ "$signed" != true ]]; then
  echo "Aru Host Console could not use any available stable signing identity." >&2
  exit 1
fi
codesign --verify --strict --verbose=2 "$APP"
designated_requirement="$(codesign -d -r- "$APP" 2>&1)"
if [[ "$designated_requirement" == *'cdhash H'* ]]; then
  echo "Aru Host Console received an unstable cdhash-only designated requirement." >&2
  exit 1
fi
printf '%s\n' "$APP"
