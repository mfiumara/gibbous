#!/bin/sh
# Xcode build phase of the GibbousMac target: embed the bundled server (scripts/bundle-server.mjs) and sign every
# binary in it for the hardened runtime. Only when GIBBOUS_SERVER_BUNDLE points at a staged gibbous-server/ (set by
# scripts/release-mac.sh for the Developer ID DMG); the sandboxed TestFlight/App Store builds never set it and stay
# a window onto a server you run yourself.
set -e
[ -n "$GIBBOUS_SERVER_BUNDLE" ] || exit 0
SRC="$GIBBOUS_SERVER_BUNDLE"
[ -x "$SRC/node/node" ] || { echo "error: $SRC is not a gibbous-server bundle (node scripts/bundle-server.mjs)" >&2; exit 1; }
[ "$ENABLE_APP_SANDBOX" = "YES" ] && { echo "error: the bundled server can't run in the App Sandbox (Developer ID build only)" >&2; exit 1; }
DESKTOP="$SRCROOT/../desktop"
CONTENTS="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH"
DST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/gibbous-server"
rm -rf "$DST"
ditto "$SRC" "$DST"
mkdir -p "$CONTENTS/Library/LaunchAgents"
cp "$DESKTOP/dev.gibbous.desktop.server.plist" "$CONTENTS/Library/LaunchAgents/"

ID="${EXPANDED_CODE_SIGN_IDENTITY:--}"
TS=--timestamp; [ "$ID" = "-" ] && TS=--timestamp=none
# Inside-out: the addons and helpers, then node with its entitlements. The app's own signature (after this phase)
# seals them; the developer-id export re-signs each with the Developer ID certificate.
find "$DST" -type f \( -name '*.node' -o -name spawn-helper \) -print0 | xargs -0 -n1 codesign --force --sign "$ID" --options runtime $TS
codesign --force --sign "$ID" --options runtime $TS --entitlements "$DESKTOP/Node.entitlements" "$DST/node/node"
echo "Embedded the Gibbous server ($(du -sh "$DST" | cut -f1)) signed by $ID"
