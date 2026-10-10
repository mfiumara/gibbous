# Gibbous for iPhone

A thin native shell (UIKit + WKWebView) around the Gibbous web app served by your Mac. The UI is the web app, loaded
live from your server, so web changes need no app update. Native code only does what the web can't do well: the
keyboard layout, sign-in, notifications, the share sheet, haptics and a "can't reach your Mac" screen.

```
ios/
  project.yml            XcodeGen spec (the .xcodeproj is generated and gitignored)
  Gibbous/               app sources, Info.plist, entitlements, asset catalog
  GibbousUITests/        simulator UI tests (keyboard, notification tap, paste sign-in)
  tools/make-icons.py    regenerates the icon assets from desktop/AppIcon-1024.png
scripts/build-ios-app.sh generate the project + build Debug for the iOS Simulator, prints the .app path
```

## Build

```sh
brew install xcodegen
scripts/build-ios-app.sh            # SIM="iPhone 17 Pro" by default
```

The script uses `/Applications/Xcode.app` even when `xcode-select` points at the Command Line Tools.

## Run it on your iPhone

1. `brew install xcodegen && cd ios && xcodegen` (or run `scripts/build-ios-app.sh` once), then
   `open ios/Gibbous.xcodeproj`.
2. Select the **Gibbous** target → **Signing & Capabilities**. Signing is automatic with team `6726M85H57`; pick your
   own team there if you're not on that account (Xcode → Settings → Accounts to sign in).
   - **Free (Personal Team) account:** it can't sign the Push Notifications capability. Set **Build Settings → Code
     Signing Entitlements** to `Gibbous/Gibbous-NoPush.entitlements` (or delete the Push Notifications capability).
     Everything else works; the app shows local notifications only while it's briefly in the background.
     Free-account builds expire after 7 days: re-run from Xcode.
3. Plug the iPhone in (or pair it over Wi-Fi), unlock it, choose it as the run destination and press **Run** (⌘R).
   The first time, iOS asks you to enable **Developer Mode** (Settings → Privacy & Security) and, for a free account,
   to trust the developer profile (Settings → General → VPN & Device Management).
4. In Gibbous on the Mac open **Settings → Devices** and scan the sign-in code with **Scan sign-in code** (or copy
   the link and use **Paste sign-in link**). The phone needs Tailscale on, like the PWA.

## TestFlight

Needs a paid Apple Developer account. Product → Archive (Release), then Distribute App → App Store Connect →
Upload; add yourself as an internal tester in App Store Connect → TestFlight. An exported archive is signed with the
production `aps-environment`, and Release builds report `env: 'production'` with their push token, so the server
sends them through `api.push.apple.com`.

## Push notifications

The app registers when the page posts `gibbousPush` (Settings → Notifications) and hands the APNs token to the page,
which stores it on the server (`POST /api/push/apns`). Sending needs:

- a paid Apple Developer account (push capability) and an **APNs auth key** (.p8) from
  developer.apple.com → Certificates, IDs & Profiles → Keys;
- `GIBBOUS_HOME/apns.json` on the Mac: `{ "keyId": "…", "teamId": "6726M85H57", "bundleId": "dev.gibbous.ios",
  "keyPath": "/path/to/AuthKey_….p8" }`.

Without it APNs is simply off. Debug builds (run from Xcode) use the sandbox APNs environment, Release builds
production. A notification's `url` (`#/t/…`) opens that thread when tapped.

## The shell contract (native side)

- At document start: `window.__gibbousShell = { platform: 'ios', version, build }`, and `data-shell="ios"` on
  `<html>` as soon as it exists.
- `webkit.messageHandlers.*`: `gibbousNotify {title, body, url?, tag?}` (only while the app isn't active),
  `gibbousBadge {count}`, `gibbousHaptic {style}`, `gibbousShare {url?|text?, title?, filename?}` (same-origin files
  are downloaded with the sign-in cookie and shared as files), `gibbousOpen {url}` (Safari view), `gibbousPush {}`,
  `gibbousRoute {route}` (restored on cold launch), `gibbousServer {}` (back to the connect screen). Only the
  server's own main frame can post.
- Native → page: `window.gibbousNative?.({type: 'resume' | 'open' | 'pushToken' | 'pushError', …})`.
- The web view is pinned to the keyboard layout guide, so the page's `innerHeight` shrinks when the keyboard opens
  (874 → 471 pt on an iPhone 17 Pro, no document scroll). No bounce, zoom, back-swipe, link previews or pull to
  refresh; edge to edge under the status bar and home indicator.
- Navigation: same-origin stays in the app, other http(s) links open in a Safari view, other schemes in their app;
  `/api/media` and `/api/image` opened as pages, and attachments, go to the share sheet instead.
- Signed out (a 401 from `/login?token=…`, or the page's API answering 401) → the native connect screen.
- Server unreachable → "Can't reach your Mac" with Retry / Change server; retries on network change, on resume and
  every 10 s.
- `gibbous://connect?link=<urlencoded sign-in link>` signs in (Release builds ask first).

## Simulator checks (Debug only)

- `xcrun simctl launch <udid> dev.gibbous.ios -GibbousConnect '<sign-in link>'` signs in without camera or prompts.
- A script written to the app's `Documents/debug.js` (`xcrun simctl get_app_container <udid> dev.gibbous.ios data`)
  runs in the page; results and layout facts (innerHeight, composer position, shell flag) go to os_log:
  `xcrun simctl spawn <udid> log show --last 1m --predicate 'subsystem == "dev.gibbous.ios"'`.
- Safari → Develop → Simulator inspects the page (`isInspectable` in Debug).
- UI tests: `xcodebuild … test -only-testing:GibbousUITests/…` (keyboard, notification tap, paste sign-in).
  Software keyboard: `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false` before booting.
