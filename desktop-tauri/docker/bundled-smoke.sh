#!/bin/sh
# Headless check of a .deb built WITH the bundled server (build.sh --config src-tauri/tauri.server.conf.json) on a
# machine with no Gibbous and no Hermes: the app starts its own server, signs in, and `gibbous --serve` works.
#   docker run --rm -v "$PWD:/repo:ro" -v "$PWD/desktop-tauri:/src" -v gibbous-tauri-target:/target -v <out>:/out \
#     gibbous-tauri-linux sh /src/docker/bundled-smoke.sh
set -eu
mkdir -p /out
printf '#!/bin/sh\necho "$@" >> /tmp/opened.log\n' > /usr/local/bin/xdg-open && chmod +x /usr/local/bin/xdg-open
dpkg -i /target/release/bundle/deb/*.deb >/dev/null
B=/usr/lib/Gibbous/gibbous-server
ls -la "$B" "$B/node" | sed 's/^/  /'
du -sh "$B" /usr/bin/gibbous | sed 's/^/  size /'
ls -la /target/release/bundle/deb/*.deb /target/release/bundle/appimage/*.AppImage | sed 's/^/  pkg /'
# The background service's entry point, exactly as the systemd unit runs it.
node /repo/scripts/bundle-smoke.mjs "$B" 7998 --exe /usr/bin/gibbous
Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
export DISPLAY=:99
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
sleep 1
node /src/docker/bundled-smoke.mjs
