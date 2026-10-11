#!/bin/sh
# Release the Mac app as a notarized DMG: dist/Gibbous-<version>.dmg
#
#   scripts/release-mac.sh
#
# Needs: Xcode signed in to the Account Holder's Apple ID (Developer ID signing is cloud-managed through
# -allowProvisioningUpdates: no certificate in the keychain needed; a local "Developer ID Application" certificate,
# if present, also signs the DMG itself), and an App Store Connect API key for notarization in ~/.appstoreconnect (gibbous.json {keyId, issuerId} +
# private_keys/AuthKey_<keyId>.p8; same key as ios/tools/asc.mjs).
#
# The DMG app is the unsandboxed dev.gibbous.desktop build: it reads ~/.gibbous/login-url and signs in to the local
# server with no setup. It also carries its own server (Node 22 + server + web, universal; scripts/bundle-server.mjs),
# started when no Gibbous server answers. Every bundled binary is signed with the hardened runtime and notarized with
# the app. SKIP_NOTARIZE=1 stops after the signed export (no Apple upload).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -n "$DEVELOPER_DIR" ] || export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
command -v xcodegen >/dev/null || { echo "xcodegen is missing: brew install xcodegen" >&2; exit 1; }

VERSION=$(sed -n 's/^ *MARKETING_VERSION: "\(.*\)"/\1/p' "$ROOT/ios/project.yml")
BUILD="${BUILD:-$(git -C "$ROOT" rev-list --count HEAD)}"
ASC="$HOME/.appstoreconnect"
KEY_ID=$(node -p "require('$ASC/gibbous.json').keyId")
ISSUER=$(node -p "require('$ASC/gibbous.json').issuerId")
KEY="$ASC/private_keys/AuthKey_$KEY_ID.p8"
TEAM=$(sed -n 's/^ *DEVELOPMENT_TEAM: \(.*\)/\1/p' "$ROOT/ios/project.yml")

LOCAL_DEVID=$(security find-identity -v -p codesigning | grep -c "Developer ID Application" || true)

WORK="$ROOT/dist/mac-$VERSION"
rm -rf "$WORK" && mkdir -p "$WORK"
echo "Staging the bundled server…"
node "$ROOT/scripts/bundle-server.mjs" --target darwin-universal --out "$WORK/server"
cd "$ROOT/ios" && xcodegen generate --quiet

echo "Archiving Gibbous $VERSION ($BUILD)…"
xcodebuild -project Gibbous.xcodeproj -scheme GibbousMac -configuration Release \
  -archivePath "$WORK/Gibbous.xcarchive" -allowProvisioningUpdates -quiet archive \
  PRODUCT_BUNDLE_IDENTIFIER=dev.gibbous.desktop \
  CODE_SIGN_ENTITLEMENTS=../desktop/Gibbous-DeveloperID.entitlements \
  ENABLE_APP_SANDBOX=NO ENABLE_HARDENED_RUNTIME=YES \
  OTHER_CODE_SIGN_FLAGS=--timestamp CURRENT_PROJECT_VERSION="$BUILD" \
  GIBBOUS_SERVER_BUNDLE="$WORK/server/gibbous-server" ENABLE_USER_SCRIPT_SANDBOXING=NO

cat > "$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$TEAM</string>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath "$WORK/Gibbous.xcarchive" -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -exportPath "$WORK/export" -allowProvisioningUpdates -quiet
APP="$WORK/export/Gibbous.app"
codesign --verify --deep --strict "$APP"
# Every Mach-O inside must carry the Developer ID signature, hardened runtime and a timestamp, or notarization fails.
find "$APP/Contents/Resources/gibbous-server" -type f -perm -u+x -o -name '*.node' | while read -r f; do
  file -b "$f" | grep -q Mach-O || continue
  info=$(codesign -dvv "$f" 2>&1)
  echo "$info" | grep -q "Authority=Developer ID Application" && echo "$info" | grep -q "flags=.*runtime" && echo "$info" | grep -q "^Timestamp=" \
    || { echo "not signed for notarization: $f" >&2; echo "$info" >&2; exit 1; }
done
codesign -d --entitlements - "$APP/Contents/Resources/gibbous-server/node/node" 2>/dev/null | grep -q allow-jit \
  || { echo "node lost its entitlements" >&2; exit 1; }
[ -n "$SKIP_NOTARIZE" ] && { echo "Signed export: $APP (SKIP_NOTARIZE set)"; exit 0; }

echo "Building the DMG…"
STAGE="$WORK/dmg"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Gibbous.app"
ln -s /Applications "$STAGE/Applications"
DMG="$ROOT/dist/Gibbous-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -volname "Gibbous $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 "$DMG" -quiet
# The DMG needs no signature of its own (notarization covers it and the ticket is stapled); sign it when we can.
[ "$LOCAL_DEVID" -gt 0 ] && codesign --sign "Developer ID Application" --timestamp "$DMG"

echo "Notarizing (a few minutes)…"
xcrun notarytool submit "$DMG" --key "$KEY" --key-id "$KEY_ID" --issuer "$ISSUER" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type execute -v "$APP"
shasum -a 256 "$DMG"
echo "$DMG"
