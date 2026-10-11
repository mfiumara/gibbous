# Gibbous for Windows and Linux

A Tauri v2 window around your Gibbous server, the counterpart of the Swift Mac app in `desktop/`. It loads the
server's web app; nothing of the UI is bundled except the connect screen (`ui/index.html`).

- **Signs in by itself** to the local server: reads `GIBBOUS_HOME/login-url` and `secret.json` (`GIBBOUS_HOME` or
  `~/.gibbous`, on Windows `%USERPROFILE%\.gibbous`). When nothing answers it shows *Can't reach Gibbous* and connects
  as soon as the server is up. Paste a sign-in link there (or tray → *Sign in with a link…*) to use another computer's
  Gibbous; it's remembered. `GIBBOUS_URL=http://host:port` overrides the server.
- **Carries its own server** (release builds): `resources/gibbous-server` = Node 22 + the Gibbous server + the web app
  (`scripts/bundle-server.mjs`, added by `src-tauri/tauri.server.conf.json`). When nothing answers on this computer's
  port and you haven't installed Gibbous yourself, the app starts it (same `~/.gibbous`), shows *Starting Gibbous…*,
  signs in, and stops it on Quit. Tray → *Keep Gibbous running in the background* hands it to a login service that
  runs `gibbous --serve` (systemd user unit `gibbous-app.service`; Scheduled Task *Gibbous app server*); greyed out when
  your own `gibbous.service` / *Gibbous* task exists, which the app never touches. Code: `src-tauri/src/server.rs`.
- **Notifications** as system notifications (every thread except the one on screen); a click opens the thread.
- **Tray icon**: Open, New thread, Inbox, Launch at login, Sign in with a link, Reload, Quit. Closing the window keeps
  Gibbous in the tray. **Ctrl+Alt+Space** shows/hides the window (X11 and Windows; Wayland doesn't allow global keys).
- **Badge**: the number of agents waiting on you in the window title, the tray tooltip, the GNOME/KDE launcher
  (Unity count, Linux) and a dot on the taskbar button (Windows).
- Reopens the last route, remembers the window's size and position, one instance only, links to other sites and
  editors (`vscode://` …) open outside, files save to Downloads, no page zoom, dark background (no white flash).

Page ⇄ app contract: `web/src/desktopBridge.ts` (page side) and `src-tauri/src/shell.js` (injected at document start):
`window.__gibbousShell = {platform: 'windows'|'linux', version, build}`, `data-shell` on `<html>`,
`window.gibbousDesktop.post(name, body)` with `notify`, `badge`, `open`, `download`, `reveal`, `route`; the app calls
`window.gibbousNative({type: 'resume'|'open', url})`. Server pages may only call the two app commands; the grant is
per server origin (`allow_server` in `lib.rs`), the connect-screen-only messages check the page is the app's own.

## Install

Release installers bring their own server; you only need Hermes. Builds without the bundle need a Gibbous server on
the same computer (or paste a link to one elsewhere): see the main README.

**Linux** (x86_64 and arm64)
- Debian/Ubuntu: `sudo apt install ./Gibbous_<version>_amd64.deb` (pulls `libwebkit2gtk-4.1-0`), then *Gibbous* in the app menu.
- Anything else: `chmod +x Gibbous_<version>_amd64.AppImage && ./Gibbous_<version>_amd64.AppImage`.
- The tray icon needs a StatusNotifier host (KDE, most desktops; GNOME needs the *AppIndicator* extension). Without
  one, closing the window still hides it: launch Gibbous again to bring it back.

**Windows 10/11**: run `Gibbous_<version>_x64-setup.exe` (per-user install, no admin; installs WebView2 if missing)
or the `.msi`. The installers aren't code-signed yet, so SmartScreen asks once (*More info → Run anyway*).

## Build

```sh
cd desktop-tauri && npm ci          # Tauri CLI only; not part of the pnpm workspace
npx tauri build                     # on the target OS (Linux needs libwebkit2gtk-4.1-dev libgtk-3-dev
                                    # libayatana-appindicator3-dev librsvg2-dev libxdo-dev)
(cd src-tauri && cargo test --lib)  # sign-in/link helpers
```

With the bundled server (what CI ships): stage it, then build with the extra config.

```sh
pnpm install && node scripts/bundle-server.mjs --target win32-x64 --out desktop-tauri/server-bundle   # or linux-x64…
node scripts/bundle-smoke.mjs desktop-tauri/server-bundle/gibbous-server    # boots it: fresh home, no Hermes
cd desktop-tauri && npx tauri build --config src-tauri/tauri.server.conf.json
```

Linux packages from macOS, in Docker (host arch; arm64 on Apple silicon):

```sh
docker build -t gibbous-tauri-linux desktop-tauri/docker
docker run --rm -v "$PWD:/repo:ro" -v "$PWD/desktop-tauri:/src" gibbous-tauri-linux sh /src/docker/stage-server.sh
docker run --rm -v "$PWD/desktop-tauri:/src" -v gibbous-cargo:/usr/local/cargo/registry \
  -v gibbous-tauri-target:/target -v gibbous-tauri-cache:/root/.cache gibbous-tauri-linux \
  sh /src/docker/build.sh --config src-tauri/tauri.server.conf.json     # drop --config for a window-only build
# fresh machine, no Gibbous/Hermes: the app starts its server and signs in; `gibbous --serve` boots it too
docker run --rm -v "$PWD:/repo:ro" -v "$PWD/desktop-tauri:/src" -v gibbous-tauri-target:/target -v <out>:/out \
  gibbous-tauri-linux sh /src/docker/bundled-smoke.sh
```

Windows: `.github/workflows/desktop.yml` (windows-latest + ubuntu-22.04; artifacts on every run, a draft release on a
`desktop-v*` tag). `docker/build-windows.sh` cross-builds the NSIS installer with cargo-xwin.

## Linux smoke test

`docker/smoke.sh` installs the .deb in the image and drives it headless (Xvfb, dunst, tauri-driver/WebKitWebDriver)
against a Gibbous server on the host: connect screen while unreachable → automatic sign-in → notification (via
`POST /api/push/test`) and its click → badge → external links → download → route saved and restored on relaunch →
Ctrl+Alt+Space → single instance → AppImage start. Screenshots and `results.json` go to `/out`.

```sh
H=<an isolated GIBBOUS_HOME>; GIBBOUS_HOME=$H GIBBOUS_PORT=7989 node server/main.ts &
docker run --rm -e GIBBOUS_PORT=7989 -e MEDIA_PATH=<a file under your home> -v "$PWD/desktop-tauri:/src" \
  -v gibbous-tauri-target:/target -v $H:/gibhome:ro -v <out dir>:/out gibbous-tauri-linux sh /src/docker/smoke.sh
```

`GIBBOUS_DEBUG=1` logs hotkey decisions. Without a window manager the hotkey check can race on focus; rerun it.
