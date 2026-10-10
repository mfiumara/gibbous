#!/bin/sh
# Regenerate the macOS AppIcon set (desktop/Assets.xcassets) from desktop/AppIcon-1024.png with sips.
# The Mac icon keeps its own rounded tile and transparent margin (macOS doesn't mask icons), so it's only resized.
set -e
D="$(cd "$(dirname "$0")" && pwd)"
SET="$D/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$SET"
printf '{\n  "info" : { "author" : "xcode", "version" : 1 }\n}\n' > "$D/Assets.xcassets/Contents.json"
images=""
for s in 16 32 128 256 512; do
  for k in 1 2; do
    px=$((s * k)); f="icon_${s}x${s}@${k}x.png"
    sips -z $px $px "$D/AppIcon-1024.png" --out "$SET/$f" >/dev/null
    images="$images    { \"filename\" : \"$f\", \"idiom\" : \"mac\", \"scale\" : \"${k}x\", \"size\" : \"${s}x${s}\" },
"
  done
done
printf '{\n  "images" : [\n%s  ],\n  "info" : { "author" : "xcode", "version" : 1 }\n}\n' "$(printf '%s' "$images" | sed '$ s/},$/}/')
" > "$SET/Contents.json"
echo "icons written to $SET"
