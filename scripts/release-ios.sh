#!/bin/sh
# Archive the iPhone app and upload it to App Store Connect (it then shows up in TestFlight; submitting it for
# App Review is a separate, manual step in App Store Connect).
#
#   scripts/release-ios.sh
#
# Needs: Xcode, xcodegen, and the App Store Connect API key in ~/.appstoreconnect (gibbous.json {keyId, issuerId} +
# private_keys/AuthKey_<keyId>.p8), an "Apple Distribution" certificate in the login keychain, and an App Store
# provisioning profile for dev.gibbous.ios that includes it (default name "Gibbous App Store 1.0", override with
# IOS_PROFILE). The API key can create both (the key's role has no access to cloud-managed signing).
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
AUTH="-allowProvisioningUpdates -authenticationKeyPath $KEY -authenticationKeyID $KEY_ID -authenticationKeyIssuerID $ISSUER"

WORK="$ROOT/dist/ios-$VERSION-$BUILD"
rm -rf "$WORK" && mkdir -p "$WORK"
cd "$ROOT/ios" && xcodegen generate --quiet

echo "Archiving Gibbous $VERSION ($BUILD)…"
# shellcheck disable=SC2086
xcodebuild -project Gibbous.xcodeproj -scheme Gibbous -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$WORK/Gibbous.xcarchive" -quiet $AUTH archive CURRENT_PROJECT_VERSION="$BUILD"

cat > "$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${DESTINATION:-upload}</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>dev.gibbous.ios</key><string>${IOS_PROFILE:-Gibbous App Store 1.0}</string></dict>
  <key>teamID</key><string>$TEAM</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
EOF
echo "Exporting and uploading…"
# shellcheck disable=SC2086
xcodebuild -exportArchive -archivePath "$WORK/Gibbous.xcarchive" -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -exportPath "$WORK/export" -quiet $AUTH
echo "Uploaded Gibbous $VERSION ($BUILD). It appears in App Store Connect → TestFlight after processing (~10–30 min)."
