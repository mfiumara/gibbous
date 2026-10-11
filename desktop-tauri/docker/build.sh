#!/bin/sh
# Build the Linux packages inside the gibbous-tauri-linux image (desktop-tauri/docker/Dockerfile).
#   docker run --rm -v "$PWD/desktop-tauri:/src" -v gibbous-cargo:/usr/local/cargo/registry -v gibbous-tauri-target:/target \
#     gibbous-tauri-linux sh /src/docker/build.sh
set -eu
export CARGO_TARGET_DIR=/target
command -v tauri >/dev/null || npm i -g --no-audit --no-fund @tauri-apps/cli@^2.12.2 >/dev/null
cd /src/src-tauri
cargo test --lib
cd /src
# AppImage bundling needs linuxdeploy (downloaded by the CLI); NO_STRIP: linuxdeploy's strip can't read newer ELF.
NO_STRIP=true APPIMAGE_EXTRACT_AND_RUN=1 tauri build --bundles deb,appimage "$@"
ls -la /target/release/bundle/deb /target/release/bundle/appimage
