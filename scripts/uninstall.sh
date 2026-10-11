#!/bin/sh
# Remove Gibbous from this computer: the login service (launchd or systemd --user), the tailnet port, its MCP entry in
# Hermes, the Hermes backend it started, and Gibbous.app. Your data in ~/.gibbous stays unless you pass --purge (that
# also deletes task worktrees). Hermes itself and your conversations are untouched. Windows: scripts/uninstall.ps1
H="${GIBBOUS_HOME:-$HOME/.gibbous}"
HERMES="${HERMES_BIN:-$(command -v hermes || echo "$HOME/.local/bin/hermes")}"
say() { printf '• %s\n' "$1"; }

case "$(uname -s)" in
Darwin)
  launchctl bootout "gui/$(id -u)/dev.gibbous.server" 2>/dev/null && say "stopped the Gibbous service"
  rm -f "$HOME/Library/LaunchAgents/dev.gibbous.server.plist"
  ;;
Linux)
  UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/gibbous.service"
  if [ -f "$UNIT" ]; then
    systemctl --user disable --now gibbous.service >/dev/null 2>&1 && say "stopped the Gibbous service"
    rm -f "$UNIT"; systemctl --user daemon-reload 2>/dev/null
  fi
  ;;
esac
command -v tailscale >/dev/null && tailscale serve --https="${GIBBOUS_TS_PORT:-8444}" off 2>/dev/null && say "closed tailnet port ${GIBBOUS_TS_PORT:-8444}"
"$HERMES" mcp remove gibbous >/dev/null 2>&1 && say "removed the gibbous MCP server from Hermes"
# The `hermes serve` Gibbous spawned (detached, so it outlived the service). Only kill it if that pid still holds its port.
PID=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$H/hermes-backend.json" 2>/dev/null)
PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$H/hermes-backend.json" 2>/dev/null)
holds_port() {
  if command -v lsof >/dev/null; then lsof -nP -p "$PID" -a -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -q "pid=$PID,"; fi
}
[ -n "$PID" ] && holds_port && kill "$PID" && say "stopped the Hermes backend (pid $PID)"
for app in "$HOME/Applications/Gibbous.app" "/Applications/Gibbous.app"; do [ -d "$app" ] && rm -rf "$app" && say "removed $app"; done

if [ "$1" = "--purge" ]; then
  rm -rf "$H" && say "deleted $H (state, secrets, logs, worktrees)"
else
  say "kept your data in $H (run with --purge to delete it)"
fi
