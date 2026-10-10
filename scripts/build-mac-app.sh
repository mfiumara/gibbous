#!/bin/sh
# Build Gibbous.app (native window around the local server) into ~/Applications, or the path given as $1.
# Local ad-hoc build: unsandboxed, bundle id dev.gibbous.desktop. The sandboxed TestFlight build (bundle id
# dev.gibbous.ios) is the GibbousMac target in ios/project.yml; see ios/README.md.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$HOME/Applications/Gibbous.app}"
TMP="$(mktemp -d)"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -parse-as-library -o "$APP/Contents/MacOS/Gibbous" "$ROOT/desktop/Gibbous.swift"

# App icon: the 1024px rendered moon tile (scripts/icon/), every size macOS asks for.
ICONSET="$TMP/Gibbous.iconset"; mkdir -p "$ICONSET"
SRC="$ROOT/desktop/AppIcon-1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Gibbous.icns"

cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Gibbous</string>
  <key>CFBundleDisplayName</key><string>Gibbous</string>
  <key>CFBundleIdentifier</key><string>dev.gibbous.desktop</string>
  <key>CFBundleExecutable</key><string>Gibbous</string>
  <key>CFBundleIconFile</key><string>Gibbous</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(sed -n 's/^ *MARKETING_VERSION: "\(.*\)"/\1/p' "$ROOT/ios/project.yml")</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PL
codesign --force --deep -s - "$APP" 2>/dev/null
rm -rf "$TMP"
echo "Built $APP"
