#!/bin/sh
# Start the Gibbous server bundled with the desktop app, on the app's own Node runtime.
# Env: GIBBOUS_PORT (default 7878), GIBBOUS_HOME (default ~/.gibbous), GIBBOUS_LOG=1 appends output to
# GIBBOUS_HOME/gibbous.log (login services), GIBBOUS_KEEP_PATH=1 skips the login-shell PATH lookup.
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -n "$HOME" ] || HOME="$(cd ~ && pwd)"; export HOME
# Apps and login services start with a bare PATH; take the login shell's so hermes, git and gh resolve like in a
# terminal (Hermes is also found in ~/.local/bin without it).
if [ -z "$GIBBOUS_KEEP_PATH" ]; then
  SH="$SHELL"
  [ -x "$SH" ] || SH="$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | sed 's/^UserShell: //')"
  [ -x "$SH" ] || SH="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"
  [ -x "$SH" ] || SH=/bin/sh
  P="$("$SH" -lc 'printf %s "$PATH"' </dev/null 2>/dev/null)"
  [ -n "$P" ] && PATH="$P:$PATH"
  PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
  export PATH
fi
H="${GIBBOUS_HOME:-$HOME/.gibbous}"
# A login service doesn't know the port the app picked: keep the one the server last ran on (its login-url).
if [ -z "$GIBBOUS_PORT" ] && [ -f "$H/login-url" ]; then
  P="$(sed -n 's#^http://127\.0\.0\.1:\([0-9][0-9]*\)/.*#\1#p' "$H/login-url")"
  [ -n "$P" ] && GIBBOUS_PORT="$P" && export GIBBOUS_PORT
fi
if [ -n "$GIBBOUS_LOG" ]; then mkdir -p "$H"; exec >>"$H/gibbous.log" 2>&1; fi
exec "$DIR/node/node" --disable-warning=ExperimentalWarning "$DIR/app/server/main.ts" "$@"
