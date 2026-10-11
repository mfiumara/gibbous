# Gibbous for Android

A thin native shell (Kotlin + Android WebView) around the Gibbous web app served by your computer, the Android
counterpart of `ios/`. The UI is the web app, loaded live from your server over Tailscale, so web changes need no app
update. Native code only does what the web can't do well: sign-in, keyboard insets, notifications (FCM), the share
sheet, haptics, Custom Tabs for external links, file uploads/downloads and a "Can't reach your computer" screen.

## The shell contract

Shared by `android/` (native), `web/src/mobileBridge.ts` (page) and `server/fcm.ts` (push). Same names and body
shapes as the iPhone shell (`ios/README.md`); only the transport differs.

### Identity

- Package / applicationId `dev.gibbous.android`, minSdk 26, compileSdk/targetSdk 36, Kotlin, Gradle (wrapper
  committed). `versionName` "1.0.0", `versionCode` 1 (bump `versionCode` for every Play upload; the page reads it as
  `build`).

### Document start

Injected with `WebViewCompat.addDocumentStartJavaScript(web, script, setOf(<server origin>))` (androidx.webkit):

```js
window.__gibbousShell = { platform: 'android', version: '<versionName>', build: '<versionCode>' };
// and data-shell="android" on <html> as soon as it exists
```

### Page → native

One `WebViewCompat.addWebMessageListener(web, "gibbousAndroid", setOf(<server origin>), listener)` object. The page
posts a JSON string:

```js
window.gibbousAndroid.postMessage(JSON.stringify({ name: 'gibbousNotify', body: { title, body, url, tag } }))
```

Native ignores messages that aren't from the main frame or whose `sourceOrigin` isn't the server's origin.
`name` / `body` are exactly the iOS handlers:

| name | body | native |
|---|---|---|
| `gibbousNotify` | `{title, body, url?, tag?}` | local notification; skipped when FCM is registered (FCM delivers it) |
| `gibbousBadge` | `{count}` | remembered; used as `setNumber()` on the next notifications |
| `gibbousHaptic` | `{style}` light/medium/heavy/soft/rigid/selection/success/warning/error | `performHapticFeedback` |
| `gibbousShare` | `{url?, text?, title?, filename?}` | same-origin url → downloaded with the WebView's cookies, shared as a file (FileProvider); else text/url share |
| `gibbousOpen` | `{url}` | http(s) → Custom Tab; other schemes → `ACTION_VIEW` |
| `gibbousPush` | `{}` | ask POST_NOTIFICATIONS (13+), get the FCM token → `pushToken` / `pushError` |
| `gibbousRoute` | `{route}` | remembered (`#/…`, same regex as iOS `Server.isRoute`), restored on cold launch |
| `gibbousServer` | `{}` | back to the connect screen |

Debug builds also accept `gibbousDebug` (logged to logcat tag `GibbousShell`).

### Native → page

`web.evaluateJavascript("window.gibbousNative?.(<json>); void 0")` with:

- `{type: 'resume'}`: the app came back to the foreground.
- `{type: 'open', url}`: a notification was tapped (`url` is `#/t/…` or `/#/t/…`).
- `{type: 'pushToken', token, env: 'fcm'}`: the FCM registration token.
- `{type: 'pushError', message}`.

### Push (server)

- Device registration: `POST /api/push/fcm {token}` → `{ok: true, configured: boolean}`;
  `DELETE /api/push/fcm {token}` → `{ok, removed}`; `GET /api/push/fcm` → `{configured, devices}`.
  Tokens: `/^[A-Za-z0-9_:\-]{20,4096}$/`. Stored in `state.push.fcm: {token, at}[]`.
  `publicState().fcm = {configured, devices}`; `POST /api/push/test` also reports `fcm`.
- Config: `GIBBOUS_HOME/fcm.json` = the Firebase service-account JSON as downloaded (`project_id`, `client_email`,
  `private_key`, `token_uri`). Re-read on mtime change. Absent/invalid → FCM silently off.
- Auth: RS256 JWT (`iss` client_email, `scope` `https://www.googleapis.com/auth/firebase.messaging`, `aud`
  token_uri) exchanged at `token_uri` for an access token (cached until 5 min before expiry), then
  `POST https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`.
- Messages are data-only, high priority, so the app always builds the notification itself (thread tap target, skip
  the thread on screen, badge number):
  - alert: `{message: {token, data: {type: 'notify', title, body, url, tag, kind, badge}, android: {priority: 'HIGH', ttl: '3600s'}}}`
  - badge-only: `{message: {token, data: {type: 'badge', badge}, android: {priority: 'HIGH', ttl: '3600s'}}}`
  - every `data` value is a string (FCM requirement).
- `notify()` fans out to FCM with the same per-kind settings as APNs and the same badge count (`badgeSource`);
  `badgeChanged()` sends badge-only messages to FCM devices too. Tokens are dropped on 404 / `UNREGISTERED` and
  403 `SENDER_ID_MISMATCH`.

### Native behaviour

- Edge-to-edge with a dark `#16181d` window, WebView and system bars (light icons), never a white flash. The content
  view is padded by the system-bar/cutout insets and, at the bottom, by `max(navigation bar, IME)`: the WebView (and
  the page's `innerHeight`) shrinks when the keyboard opens, like iOS. The page sees zero safe-area insets.
- System back: `web.canGoBack()` → `goBack()`, else leave the app.
- Same-origin navigation stays in the WebView; `/api/media` and `/api/image` opened as pages, and
  `Content-Disposition: attachment` downloads, are saved/shared natively instead. Other http(s) → Custom Tab.
- `onShowFileChooser` → system picker (`fileChooserParams.createIntent()`, multiple when allowed).
- Signed out (401/421 on the main frame, or `fetch('/api/image')` answering 401 after a load) → connect screen with
  a message. Server unreachable → "Can't reach your computer" with Retry / Change server; retries on network change,
  on resume and every 10 s.
- `gibbous://connect?link=<urlencoded sign-in link>` signs in (asks first in release builds).
- Connect screen: Scan sign-in code (QR) / Paste sign-in link (masked field + paste button); accepts
  `https://host[:port]/login?token=…`, or `http://` only for 127.0.0.1/localhost/::1/*.local. Remembers the origin
  (never the token: the sign-in is one load of `/login?token=…`, which sets the cookie in the WebView's
  CookieManager).
