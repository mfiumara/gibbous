# Demo footage harness

Stills and screen recordings of Gibbous for the launch video, made from a clean, fictional demo. It costs no model
tokens and never touches your real Gibbous or Hermes.

```sh
pnpm build                    # only if web/dist is missing
node e2e/demo/run.ts          # everything, about 8 minutes → ~/gibbous-launch/ui/{stills,video}
node e2e/demo/run.ts --only=stills,phone,a,b,c,e,f,g,h,i,ios   # a subset (the hero thread is always made first)
node e2e/demo/probe.ts        # seed, then a few quick screenshots into the scratch dir
```

## What it runs

- **`fake-hermes.ts`**: a scripted stand-in for `hermes serve`. It serves the same REST (`/api/config`, `/api/status`, …)
  and JSON-RPC-over-WebSocket (`/api/ws`) that Gibbous uses. Each agent turn is a script that streams real gateway
  events: `message.start`, `reasoning.delta`, `status.update`, `tool.generating/start/complete` with `inline_diff`,
  `subagent.*`, server→client `approval` requests, `message.delta`, `message.complete`. Edits are written to the
  session's cwd (a real git worktree), so the Changes panel shows a real `git diff`.
- **`scripts.ts`**: the turns, chosen by prompt (sliding-window limiter, Retry-After headers, flaky Redis test,
  TypeScript upgrade with an approval, board workers and reviewers that go through the real review loop).
- **`repo.ts`**: `tidepool`, a fictional MIT rate-limiter library with a few weeks of git history, plus a small docs
  site. The author is "Tidepool Maintainers"; there are no real people or companies.
- **`seed.ts`**: fills the demo through Gibbous's real API: projects, finished threads, one running thread, one waiting
  for approval, and Discord chats mirrored into the sidebar.
- **`demo-data.ts`**: stored sessions from other surfaces (agent CLI, Discord, an editor over ACP), Claude Code / Codex
  logs written under the demo home (so `/api/sessions/origins` tells the apps apart; the fake hands out the same
  sha256 handles), the project's Hermes kanban board (served as the kanban plugin's `/api/plugins/kanban/*`), and a
  minimal read-only `state.db` (session folders, the kanban worker's session in the `builder` profile).
- **`ios.ts`**: the real iPhone app (`scripts/build-ios-app.sh` first) in a throwaway Simulator, signed in to the demo
  with `-GibbousConnect`, driven through `Documents/debug.js`, recorded with `simctl io recordVideo`, then deleted.
- **`lib.ts`**: the isolated instance and capture helpers.

## Isolation

- **Gibbous**: a copy of `server/` and the current `web/dist` build in `~/.hermes/cache/scratch/gibbous-demo/app`, so
  rebuilds in the repo can't reload a capture tab. Pass `--resnapshot` to refresh it.
- It runs on port 7990 (`DEMO_PORT`) with `HOME`, `GIBBOUS_HOME`, and `HERMES_HOME` all inside `/Users/Shared/gibbous-demo`
  (`DEMO_HOME`). That folder is wiped on every run, and these are the only paths that can appear on screen.
- **Never the real Hermes**: `hermes-backend.json` points at the fake, and `HERMES_BIN` is a stub that exits. If the
  fake dies, Gibbous can't start a real backend.
- **No outside services**: stub `tailscale` and `gh` on `PATH`, so there's no tailnet URL and no PR lookups. The sky moon's
  IP-location lookup is blocked.
- **The terminal panel**: zsh with the demo home's `.zshrc` (prompt `dir ❯`), user `dev`.
- **Secrets stay out of output**: the server log, which holds the login link, goes to `scratch/gibbous-demo/server.log`
  and is never printed.

## Clips

`a` prompt → streaming turn, `b` vim navigation, `c` Changes panel, `e` approval, `f` phone-width approval (web),
`g` Sessions → import a Claude Code session, `h` kanban board (cards move as Hermes would, j/k/h/l, open a card),
`i` the sky moon swept from a crescent to the 3 March 2026 total eclipse (the harness keeps handles on the moon's
redraw intervals, `window.__moonRedraw()`, and pins `gibbous.moonAt`), `ios` the real iPhone app.
`probe-keys.ts` prints focus after each key on the board and Sessions screens.

## Recording

Headless Chrome only paints about 20–25 fps, so clips are recorded in slow motion (3×, `REC_SLOW`). Everything slows
down together:

- the page's clock (`Date`, `performance.now`, timers, rAF)
- CSS and Web Animations (CDP `Animation.setPlaybackRate`)
- the scripted agent
- the harness's own pacing

The CDP screencast frames are then placed at their real timestamps and resampled to a constant 60 fps H.264 file at
normal speed. Desktop clips are 1920×1200 (`REC_DPR=1`). The phone clip is 804×1748 (402×874 @2x).

## Hosted demo (demo.gibbousapp.com)

A free Cloudflare Worker that serves the real web app and imitates the Gibbous server with recordings of this demo, so
App Review can use the iPhone app without a real server. It is for App Review only: not linked anywhere, `robots.txt`
disallows everything, and the sign-in token is a Worker secret kept out of git (`wrangler secret put DEMO_TOKEN`; a
local copy for `check-demo.ts` lives in `~/.config/gibbous/demo-token`). The sign-in link
(`https://demo.gibbousapp.com/login?token=<token>`) goes only in the App Store review details.

```sh
pnpm build                                        # if web/dist is stale
node e2e/demo/record.ts                           # ~3 min → e2e/demo/worker/fixtures.json
cd e2e/demo/worker && npm run deploy              # copies the recorded web build to public/, wrangler deploy
node e2e/demo/check-demo.ts                       # walk the live demo like a visitor (or pass http://localhost:8787 for `npm run dev`)
```

- **`record.ts`** boots the isolated demo above, drives Chrome through every screen and records each `/api` GET, the
  JSON-RPC answers on `/ws` (plus a full `session.resume` of every session and every Claude Code / Codex import), and
  the event stream of one scripted turn (`DEMO_PROMPT` in `scripts.ts`: reasoning, reads, two patches with inline
  diffs, tests, then a `git push` approval and the reply) and of the seeded TypeScript approval. Paths become
  `/Users/demo`; it refuses to write fixtures that contain the access token or anything that looks personal.
- **`worker/worker.js`**: `/login?token=` and `POST /api/login` set the same cookie as the real server (wrong token →
  401, unauthenticated `/api` → 401, so the iPhone app's sign-in and signed-out flows behave as usual). Each visitor
  gets their own copy of the demo in a SQLite-backed Durable Object (WebSocket hibernation; resets a day after it
  started). Any prompt, from Home or a thread, plays the recorded turn with its original timing (gaps capped at
  1.5 s) and waits at the approval until you answer it (Deny ends the turn like Hermes would); a reload mid-turn or
  after it shows the same rows. Threads you start, rename, archive or delete, queued messages and settings stick.
  Timestamps are shifted so the demo always reads as recorded just now. `/api/state` reports the deployed build, so
  the stale-build banner never fires.
- **Refused, politely**: the terminal (`/pty` prints that it isn't available and closes with 4001 so it doesn't
  retry), git actions, commits/PRs, file writes, adding projects or hosts, shares, attachments, slash commands and
  other Hermes mutations answer "Not available in the demo". Push routes answer ok and send nothing.
- `build.mjs` only deploys a web build that matches the recording (the recorder's snapshot or `web/dist`), since new
  web code may call routes the recording doesn't have: re-record after UI changes, then deploy.
