#!/bin/sh
# Headless smoke test of the built .deb/AppImage against a Gibbous server on the host (see README "Linux smoke test").
#   docker run --rm -e GIBBOUS_PORT=7989 -e MEDIA_PATH=<file under the host's home> \
#     -v "$PWD/desktop-tauri:/src" -v gibbous-tauri-target:/target -v <GIBBOUS_HOME>:/gibhome:ro -v <out>:/out \
#     gibbous-tauri-linux sh /src/docker/smoke.sh
set -eu
mkdir -p /root/.gibbous /root/Downloads /out
cp /gibhome/login-url /gibhome/secret.json /root/.gibbous/
# Links the app hands to the OS land here instead of a browser.
printf '#!/bin/sh\necho "$@" >> /tmp/opened.log\n' > /usr/local/bin/xdg-open && chmod +x /usr/local/bin/xdg-open
dpkg -i /target/release/bundle/deb/*.deb >/dev/null
Xvfb :99 -screen 0 1440x900x24 >/dev/null 2>&1 &
export DISPLAY=:99
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
sleep 1
dunst >/out/dunst.log 2>&1 &
# dunstctl history is broken in Debian's dunst 1.9: log the Notify calls instead.
dbus-monitor "interface=org.freedesktop.Notifications" > /tmp/notify.log 2>&1 &
sleep 0.5
node /src/docker/smoke.mjs
