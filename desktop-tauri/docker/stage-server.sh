#!/bin/sh
# Stage the bundled server for Linux inside the gibbous-tauri-linux image (node-pty compiles for the container's
# arch), into desktop-tauri/server-bundle, then smoke it with no Hermes. The repo is copied without node_modules so the
# host's install (macOS binaries) is left alone.
#   docker run --rm -v "$PWD:/repo:ro" -v "$PWD/desktop-tauri:/src" gibbous-tauri-linux sh /src/docker/stage-server.sh
set -eu
TARGET="linux-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
mkdir -p /work && cd /repo
tar cf - --exclude=node_modules --exclude=./dist --exclude=./.git --exclude=./desktop-tauri/src-tauri/target \
  --exclude=./desktop-tauri/server-bundle --exclude=./ios/build . | (cd /work && tar xf -)
cd /work
command -v pnpm >/dev/null || npm i -g --no-audit --no-fund pnpm@10.28.1 >/dev/null
pnpm install --frozen-lockfile --reporter=silent
node scripts/bundle-server.mjs --target "$TARGET" --out /src/server-bundle
node scripts/bundle-smoke.mjs /src/server-bundle/gibbous-server
