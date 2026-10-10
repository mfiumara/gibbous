# Gibbous

A cockpit for the Hermes agent running on this Mac: parallel threads in git worktrees, each project's Hermes kanban board, live diffs, a terminal, and approvals from your phone.

## Install

```sh
pnpm install
scripts/install-service.sh     # builds the web app, runs Gibbous at login (launchd)
scripts/tailscale.sh           # optional: https://<this-mac>.<tailnet>.ts.net:8444 on your tailnet
scripts/build-mac-app.sh       # optional: ~/Applications/Gibbous.app
```

Open the login link from `~/.gibbous/login-url` once per browser, or use Gibbous.app, which signs itself in. For your phone, use Settings → Phone → *Copy phone sign-in link* and open it on the phone. The tailnet address is only reachable from your own Tailscale devices. Gibbous still requires the token, because the macOS Tailscale app can't prove identity to a local server in a way other local processes couldn't fake. To install it, use Share → Add to Home Screen, sign in once more inside the installed app, then turn on notifications in Settings.

## Using it

- **Threads** (⌘N new, ⌘K jumps anywhere, ⌘1–9 recent, `?` lists shortcuts):
  - Each thread is a real Hermes session with your usual model, tools, skills and memory, optionally in its own git worktree.
  - Reasoning, tool calls with inline diffs, and subagents stream live. You can steer or stop subagents.
  - Edit a past message to rerun from it, or rewind to a checkpoint. Find in the thread with ⌘F.
  - `/` runs slash commands and `@` completes paths. Paste or drop images and files. You can dictate, or go hands-free and have replies read aloud.
  - Export a thread as Markdown or JSON, or publish a read-only share link.
- **Panels** (`⌘\`):
  - Changes: diff, line comments, revert, commit, sync with base, PR status, and *Fix CI*.
  - Files (edit in place), Terminal (tabs for your project scripts), Preview (local dev servers).
  - Processes, Session (context breakdown, checkpoints, subagent tree), and Screen.
- **Kanban**: Gibbous has no task system of its own; it shows Hermes' kanban (`hermes kanban`), through the API the kanban dashboard plugin mounts on `hermes serve`.
  - A project's board is the Hermes board whose default workdir is the project folder (or inside it), or one you link by hand.
  - Columns follow Hermes' statuses, live. A card opens its body, dependencies, comments, activity and the worker's session (read-only). Create, comment, block/unblock, assign and archive from there; j/k walk cards, h/l columns.
  - *Kanban* in the sidebar lists every board.
- **Inbox**: every approval, question and finished thread in one place. With notifications on, these also arrive as push notifications (per-kind toggles in Settings).
- **Hermes history and search**:
  - Every Hermes session, filterable by source. *Keep in sidebar* mirrors a whole source, such as Discord.
  - Claude Code and Codex sessions can be imported too.
  - Search covers all transcripts.
- **iPhone app push (APNs)**: the iOS app registers its device token with the server; sending needs an APNs auth key. In the Apple Developer portal (paid membership) open *Certificates, Identifiers & Profiles → Keys*, add a key with *Apple Push Notifications service (APNs)* enabled, download the `AuthKey_<KEYID>.p8` once, put it in `~/.gibbous/`, and create `~/.gibbous/apns.json`:
  ```json
  { "keyId": "<KEYID>", "teamId": "6726M85H57", "bundleId": "dev.gibbous.ios", "keyPath": "AuthKey_<KEYID>.p8" }
  ```
  `keyPath` may be absolute or relative to `~/.gibbous`. Optional `"production": true|false` forces the APNs host; by default each device's own environment decides (debug builds = sandbox, TestFlight/App Store = production). Changes are picked up without a restart; without the file APNs stays off. `GIBBOUS_APNS_HOST`/`GIBBOUS_APNS_CA` are for testing against a local HTTP/2 server only.
- **Discord and other surfaces** are read-only: they belong to the gateway. If the gateway API server is on, you can reply from Gibbous, and the reply goes through the gateway. *Continue in Gibbous* forks a conversation into a thread you own.
- **Rooms**: group chats between Hermes profiles.
- **Hosts**: other machines running Hermes, reached over SSH tunnels.
- **Settings → Hermes**:
  - Usage and cost charts, profiles, skills, MCP servers (with OAuth), scheduled jobs, messaging platforms, memory, the vault and password managers, raw config.
  - Update: one click, then a compatibility check.
- **Settings → Maintenance**: orphaned worktrees, backup and restore, and a redacted debug bundle for bug reports.
- Night and light themes, three densities, and reduced motion. Gibbous.app adds a menu-bar status item, a Dock badge, native notifications, launch at login, and ⌃⌥Space to summon it.

## Uninstall

```sh
scripts/uninstall.sh           # service, tailnet port, MCP entry, the Hermes backend it started, Gibbous.app
scripts/uninstall.sh --purge   # …and ~/.gibbous (state, secrets, logs, task worktrees)
```

Hermes and your conversations are untouched either way.

## How it fits together

```
browser / Gibbous.app / phone PWA
        │ one WebSocket per tab
gibbous server (server/, 127.0.0.1:7878)
  ├─ pipes Hermes JSON-RPC through verbatim; mixes in gibbous.event frames
  ├─ orchestrator: own Hermes connection, attached to every thread
  │    → owns approvals/questions, thread status
  ├─ kanban: Hermes' kanban plugin API (/api/plugins/kanban) → /api/kanban/*
  ├─ git/worktrees, PTY terminals, web push
  └─ ~/.gibbous/state.json (projects, threads, settings)
        │
hermes serve (spawned detached on :9120, survives Gibbous restarts)
```

- `hermes serve` runs in desktop mode (`HERMES_DESKTOP=1` and a minted token). That's the only way past the dashboard password gate on loopback, and it's what the official desktop app does.
- Thread transcripts always come from Hermes; Gibbous stores only ids and metadata.
- Types: `web/src/hermes/contract.ts` is copied from Hermes's generated contract. Refresh it after `hermes update` with `pnpm sync:contract`, then run `pnpm typecheck`.

## Development

```sh
GIBBOUS_ALLOWED_HOSTS=localhost:5173 node server/main.ts   # or `pnpm --filter server dev`
pnpm --filter web dev                                      # Vite on :5173, proxies to the server
pnpm test && pnpm typecheck   # unit tests + thread lifecycle against a fake Hermes (server/fake-hermes.ts)
pnpm build && pnpm e2e        # headless Chrome on an isolated instance (temp state, :7979); sends no prompts
```

After `hermes update`, Settings → Update → *Check compatibility* confirms that every JSON-RPC method Gibbous calls still exists in the installed Hermes contract, and that the read-only endpoints still answer. `pnpm test` checks the same thing against the synced contract.

Logs: `~/.gibbous/gibbous.log` and `~/.gibbous/hermes-serve.log`.

## Releasing

The version lives in `ios/project.yml` (`MARKETING_VERSION`) and `package.json`. Both release scripts use the App Store Connect API key in `~/.appstoreconnect` (see `ios/tools/asc.mjs`).

```sh
scripts/release-mac.sh   # notarized dist/Gibbous-<version>.dmg (needs a Developer ID Application certificate)
scripts/release-ios.sh   # archive the iPhone app and upload it to App Store Connect / TestFlight
node e2e/demo/run.ts     # demo footage and screenshots: isolated instance, scripted fake Hermes, no tokens spent
```

The DMG is the unsandboxed `dev.gibbous.desktop` app (signs in to the local server with no setup), attached to a GitHub release. Submitting the iPhone build for App Review is done in App Store Connect.

## Deliberate shortcuts

- State is one JSON file, rewritten on change. Settings → Maintenance shows its size. Move it to SQLite if it ever grows past a few MB.
- The bundle is about 290 KB gzipped: highlight.js and xterm load up front. Code-split them if phone load time ever bothers you.
- Live updates for read-only (Discord) threads and rooms are polled, because Hermes exposes no event stream for sessions it doesn't run.
- Merging requires the project checkout to be on the base branch. Gibbous refuses rather than guessing; a conflicting merge is aborted and left for you.
