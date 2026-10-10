#!/bin/sh
# Generate ios/Gibbous.xcodeproj (XcodeGen) and build the Gibbous iOS shell, Debug, for the iOS Simulator.
# Prints the .app path. To run it on your iPhone, open the project in Xcode instead (see ios/README.md).
#   scripts/build-ios-app.sh                 # build
#   SIM="iPhone 17 Pro" scripts/build-ios-app.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# xcode-select may point at the Command Line Tools, which have no iOS SDK.
[ -n "$DEVELOPER_DIR" ] || export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
command -v xcodegen >/dev/null || { echo "xcodegen is missing: brew install xcodegen" >&2; exit 1; }
SIM="${SIM:-iPhone 17 Pro}"
DERIVED="$ROOT/ios/build"

cd "$ROOT/ios"
xcodegen generate --quiet
xcodebuild -project Gibbous.xcodeproj -scheme Gibbous -configuration Debug \
  -destination "platform=iOS Simulator,name=$SIM" -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO build -quiet
echo "$DERIVED/Build/Products/Debug-iphonesimulator/Gibbous.app"
