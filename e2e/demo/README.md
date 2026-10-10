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
