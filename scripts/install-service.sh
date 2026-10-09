#!/bin/sh
# Run Gibbous at login and keep it running (launchd). Re-run after moving the repo.
# Uninstall: scripts/uninstall.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/dev.gibbous.server.plist"
[ -d "$HOME/.phoebe" ] && [ ! -f "$HOME/.gibbous/state.json" ] && rm -rf "$HOME/.gibbous" && mv "$HOME/.phoebe" "$HOME/.gibbous" # pre-rename data
mkdir -p "$HOME/.gibbous" "$HOME/Library/LaunchAgents"
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null)
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
  <key>StandardOutPath</key><string>$HOME/.gibbous/gibbous.log</string>
  <key>StandardErrorPath</key><string>$HOME/.gibbous/gibbous.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/dev.gibbous.server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
echo "Gibbous is running. Log in on this Mac with:"
cat "$HOME/.gibbous/login-url"
