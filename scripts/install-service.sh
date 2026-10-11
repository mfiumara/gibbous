#!/bin/sh
# Run Gibbous at login and keep it running: launchd on macOS, a systemd --user service on Linux (incl. WSL with
# systemd enabled). Re-run after moving the repo. Windows: scripts/install-service.ps1. Uninstall: scripts/uninstall.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H="${GIBBOUS_HOME:-$HOME/.gibbous}"
[ -d "$HOME/.phoebe" ] && [ ! -f "$H/state.json" ] && rm -rf "$H" && mv "$HOME/.phoebe" "$H" # pre-rename data
mkdir -p "$H"
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null)

wait_login() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$H/login-url" ] && break; sleep 1; done
  echo "Gibbous is running. Log in on this computer with:"
  cat "$H/login-url"
}

case "$(uname -s)" in
Darwin)
  PLIST="$HOME/Library/LaunchAgents/dev.gibbous.server.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.gibbous.server</string>
  <!-- login shell so node, git, gh, hermes and tailscale resolve exactly as in your terminal -->
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>exec node --disable-warning=ExperimentalWarning server/main.ts</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$H/gibbous.log</string>
  <key>StandardErrorPath</key><string>$H/gibbous.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/dev.gibbous.server" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  sleep 3; wait_login
  ;;
Linux)
  if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
    echo "No systemd user session here (on WSL: set systemd=true under [boot] in /etc/wsl.conf, then wsl --shutdown)."
    echo "Run it by hand instead:  cd \"$ROOT\" && node server/main.ts"
    exit 1
  fi
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  # A login shell, so node (nvm, fnm…), git, gh, hermes and tailscale resolve as in your terminal.
  LOGIN_SHELL="${SHELL:-/bin/bash}"; [ -x "$LOGIN_SHELL" ] || LOGIN_SHELL=/bin/sh
  cat > "$UNIT_DIR/gibbous.service" <<UNIT
[Unit]
Description=Gibbous (web cockpit for Hermes)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$LOGIN_SHELL -lc 'exec node --disable-warning=ExperimentalWarning server/main.ts'
Restart=always
RestartSec=5
# hermes serve is started detached: keep it running when Gibbous restarts or stops.
KillMode=process
StandardOutput=append:$H/gibbous.log
StandardError=append:$H/gibbous.log

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable gibbous.service >/dev/null 2>&1
  systemctl --user restart gibbous.service
  # Keep running while you're logged out (and start at boot), where allowed.
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || echo "(tip: sudo loginctl enable-linger $(id -un) keeps Gibbous running while you're logged out)"
  sleep 2; wait_login
  ;;
*)
  echo "Unsupported system $(uname -s). On Windows run: powershell -ExecutionPolicy Bypass -File scripts\\install-service.ps1"
  exit 1
  ;;
esac
