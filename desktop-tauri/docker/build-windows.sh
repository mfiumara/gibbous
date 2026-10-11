#!/bin/sh
# Cross-build the Windows NSIS installer from Linux with cargo-xwin (MSVC CRT/SDK downloaded by xwin; you accept
# Microsoft's license by running this). CI (.github/workflows/desktop.yml) builds the real one on windows-latest.
#   docker run --rm -v "$PWD/desktop-tauri:/src" -v gibbous-cargo:/usr/local/cargo/registry -v gibbous-tauri-target:/target \
#     -v gibbous-tauri-cache:/root/.cache gibbous-tauri-linux sh /src/docker/build-windows.sh
set -eu
export CARGO_TARGET_DIR=/target
if ! command -v makensis >/dev/null; then
  apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nsis llvm clang lld >/dev/null
fi
command -v cargo-xwin >/dev/null || cargo install cargo-xwin --locked
rustup target add x86_64-pc-windows-msvc
command -v tauri >/dev/null || npm i -g --no-audit --no-fund @tauri-apps/cli@^2.12.2 >/dev/null
cd /src
tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
ls -la /target/x86_64-pc-windows-msvc/release/bundle/nsis
