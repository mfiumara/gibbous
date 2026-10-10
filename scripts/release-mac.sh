#!/bin/sh
# Release the Mac app as a notarized DMG: dist/Gibbous-<version>.dmg
#
#   scripts/release-mac.sh
#
# Needs: Xcode, xcodegen, a "Developer ID Application" certificate in the login keychain (only the Apple Developer
# Account Holder can create one: Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application),
# and an App Store Connect API key for notarization in ~/.appstoreconnect (gibbous.json {keyId, issuerId} +
# private_keys/AuthKey_<keyId>.p8; same key as ios/tools/asc.mjs).
#
# The DMG app is the unsandboxed dev.gibbous.desktop build: it reads ~/.gibbous/login-url and signs in to the local
# server with no setup. It is a window onto Gibbous; the server itself is installed from the repo (README → Install).
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

security find-identity -v -p codesigning | grep -q "Developer ID Application" || {
  echo "No \"Developer ID Application\" certificate in the keychain. Create it in Xcode → Settings → Accounts →" >&2
  echo "Manage Certificates → + → Developer ID Application (Account Holder only), then run this again." >&2
  exit 1
}

WORK="$ROOT/dist/mac-$VERSION"
rm -rf "$WORK" && mkdir -p "$WORK"
cd "$ROOT/ios" && xcodegen generate --quiet

echo "Archiving Gibbous $VERSION ($BUILD)…"
xcodebuild -project Gibbous.xcodeproj -scheme GibbousMac -configuration Release \
  -archivePath "$WORK/Gibbous.xcarchive" -quiet archive \
  PRODUCT_BUNDLE_IDENTIFIER=dev.gibbous.desktop \
  CODE_SIGN_ENTITLEMENTS=../desktop/Gibbous-DeveloperID.entitlements \
  ENABLE_APP_SANDBOX=NO ENABLE_HARDENED_RUNTIME=YES \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Developer ID Application" PROVISIONING_PROFILE_SPECIFIER= \
  OTHER_CODE_SIGN_FLAGS=--timestamp CURRENT_PROJECT_VERSION="$BUILD"

cat > "$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Developer ID Application</string>
  <key>teamID</key><string>$TEAM</string>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath "$WORK/Gibbous.xcarchive" -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -exportPath "$WORK/export" -quiet
APP="$WORK/export/Gibbous.app"
codesign --verify --deep --strict "$APP"

echo "Building the DMG…"
STAGE="$WORK/dmg"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Gibbous.app"
ln -s /Applications "$STAGE/Applications"
DMG="$ROOT/dist/Gibbous-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -volname "Gibbous $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 "$DMG" -quiet
codesign --sign "Developer ID Application" --timestamp "$DMG"

echo "Notarizing (a few minutes)…"
xcrun notarytool submit "$DMG" --key "$KEY" --key-id "$KEY_ID" --issuer "$ISSUER" --wait
xcrun stapler staple "$DMG"
spctl --assess --type open --context context:primary-signature -v "$DMG"
shasum -a 256 "$DMG"
echo "$DMG"
