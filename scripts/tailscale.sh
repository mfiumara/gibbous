#!/bin/sh
# Expose Gibbous to your tailnet only (HTTPS, tailnet devices only — never the public internet).
# Each device signs in once with the access token (Settings → Phone has a ready-made link).
set -e
PORT="${GIBBOUS_PORT:-7878}"
TS_PORT="${GIBBOUS_TS_PORT:-8444}"
tailscale serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT"
tailscale serve status
