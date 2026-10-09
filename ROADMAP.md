# Gibbous roadmap: toward feature-complete

**Status, 2026-10-08:** Milestones 1–6 are implemented and running. Where the build differs from the plan below:

- 6.2 checks the installed Hermes contract plus read-only calls, instead of a live create/submit/approve. That way it never spends tokens.
- 6.3 uses puppeteer-core with system Chrome rather than Playwright: one small dependency and no browser download.
- 6.4 ships a JSON backup and restore and shows the state size. SQLite waits until the file actually grows.
- Multi-host (5.x) was tested only for add, remove and failure handling. Remote Login is off on this Mac.
- Push on a real iPhone is not verified yet.

**Goal:** you never open the Hermes dashboard, TUI or official desktop app again. Every Hermes capability you use has a better home in Gibbous, and Gibbous's orchestration covers the t3code/Paseo workflows: parallel agents, review, ship.

**Sizes:** S ≈ an hour, M ≈ a day, L ≈ several days. *Hermes hook* names the existing method or event to build on. Gibbous now uses 64 of Hermes's 251 JSON-RPC methods.

---

## Milestone 1: Daily-driver polish
*Fix what you'll hit in the first week of real use.*

| | Item | Why | Hermes hook | Size |
|---|---|---|---|---|
| 1.1 | **Per-thread model and reasoning picker** in the thread header: model, reasoning effort, fast mode | Today it's only a global default | `model.options`, `command.dispatch` `/model`, `session.info` | S |
| 1.2 | **Approval mode toggle** per thread (smart / ask / yolo) with a visible badge | Long autonomous runs vs. careful ones | `config.set`, `session.info.approval_mode` | S |
| 1.3 | **Rename syncs to Hermes**, so titles match everywhere (CLI, Discord list, dashboard) | Gibbous renames are local only | `session.title` | S |
| 1.4 | **Per-turn undo / checkpoints**: "revert files to before this turn" on each turn | t3code's headline feature; Hermes already snapshots | `rollback.list`, `rollback.diff`, `rollback.restore`, `checkpoints.enabled` | M |
| 1.5 | **Search**: across all threads (titles and content) and within a thread (⌘F) | 1,600+ sessions | `/api/sessions/search` (serve REST, FTS) | M |
| 1.6 | **Long-thread performance**: virtualized timeline, lazy markdown and highlighting | The 374-message Discord thread is heavy on a phone | — | M |
| 1.7 | **Bundle split**: load highlight.js, xterm and the board lazily | ~290 KB gzip on the first phone load | — | S |
| 1.8 | **Hermes health banner**: backend down or restarting, update available, credential warnings | Today you only see a dot in the sidebar | `session.info.update_behind`, `credential_warning`, `/api/status` | S |
| 1.9 | **Keyboard map**: ⌘N new thread, ⌘1–9 switch threads, ⌘. stop, ⌘⇧A approve, ? for a help sheet | Speed | — | S |
| 1.10 | **Phone sign-in by QR code** in Settings, plus a "sign in this installed app" deep link | iOS PWAs don't share Safari's cookies | — | S |
| 1.11 | **Verify push on a real iPhone**, then add per-event notification settings (approvals only / turn done / task ready) | Untested; push can get noisy | — | S |
| 1.12 | **Show attachments and images in transcripts**: thumbnails for attached and generated images, files as chips | Discord images and pasted screenshots are invisible today | `inline_images` on `/messages`, `image.generate` | M |

## Milestone 2: Coding workbench (t3code parity)

| | Item | Why | Hermes hook | Size |
|---|---|---|---|---|
| 2.1 | **Project scripts runner**: named scripts per project (`dev`, `test`, `lint`) as one-click buttons in the terminal panel, with output tabs | `Project.scripts` exists in state with no UI | — | M |
| 2.2 | **Preview panel**: dev-server URL in an iframe, opened automatically when the agent starts a server | Check UI changes without leaving | `preview.open`, `preview.close`, `process.list` | M |
| 2.3 | **Agent processes view**: background processes the agent started, with live output, stop and kill | You currently can't see what's still running | `process.list`, `process.stop`, `process.kill`, `agent.terminal.output` | M |
| 2.4 | **Inline review comments**: comment on diff lines, then "send all comments to agent" as one follow-up | The fastest way to steer a code change | `prompt.submit` | M |
| 2.5 | **File editing**: small edits in the Files panel with save, plus "open in editor" (VS Code / Cursor / Zed URL schemes) | Fix a typo without a turn | — | M |
| 2.6 | **Git toolbelt**: branch switcher, stash, pull and rebase on base, a conflict view with an "ask agent to resolve" button | Merges currently fail closed on a dirty or conflicted checkout | `git` CLI | L |
| 2.7 | **PR lifecycle**: PR status, CI checks and review comments on the task card; "fix CI" sends failing logs to the worker | Shipping doesn't end at "PR opened" | `gh pr view/checks` | L |
| 2.8 | **Context controls**: context breakdown chart, manual compress, "start fresh with summary" | Long sessions degrade | `session.context_breakdown`, `session.compress` | S |
| 2.9 | **Side questions and background prompts**: `/btw` without derailing a turn, plus background jobs with completion toasts | Hermes supports both natively | `prompt.btw`, `prompt.background`, `btw.complete`, `background.complete` | S |
| 2.10 | **Todo and plan view** pinned above the composer while a turn runs | The agent's plan at a glance | `todo.updated` | S |

## Milestone 3: Orchestration v2 (beyond Paseo)

| | Item | Why | Size |
|---|---|---|---|
| 3.1 | **Dependency graph view** of the board: DAG with critical path, drag to add dependencies | Plans with more than 5 tasks get hard to read as columns | M |
| 3.2 | **Plan review step**: edit, merge or split the planner's tasks before they land; re-plan from feedback | Today the plan drops straight into the backlog | M |
| 3.3 | **Playbooks**: saved pipelines such as "plan → implement ×N → review → test → PR", "bug triage" or "dependency bump", with per-step model and profile | Repeatable workflows | L |
| 3.4 | **Reviewer roles**: choose a reviewer model or profile per project (e.g. a different model as a second opinion), a security-review pass, a test-writer pass | Better than self-review by the same model | M |
| 3.5 | **Cost and time per task and project**: tokens, $, wall time, review rounds; budget caps that pause a task | Parallel agents spend fast | M |
| 3.6 | **Scheduled tasks**: "run this task every Monday" or "nightly dependency check", landing on the board | Combine cron with the board | M |
| 3.7 | **Coordinator thread UX**: a live mini-board inside a lead thread showing the threads it spawned, their status and diffs | Coordinator mode works but is invisible | M |
| 3.8 | **Auto-merge policy** per project: merge automatically when the reviewer approves and tests pass, or when CI is green | Fully hands-off for low-risk repos | S |
| 3.9 | **Stale and stuck detection**: tasks idle too long, a worker that stopped without finishing, orphaned worktrees, with a cleanup screen | Keeps the system tidy | S |
| 3.10 | **Native subagent tree for every turn**: a tree view with each child's own transcript and diff | Today it's flat cards | M |

## Milestone 4: Hermes management (retire the dashboard)

| | Item | Hermes hook | Size |
|---|---|---|---|
| 4.1 | **Profiles**: list, create, switch per thread, show each profile's model and skills | `profiles.*`, `profile` param | M |
| 4.2 | **MCP servers**: add, edit, remove, OAuth login, test, per-server tool list | `mcp.servers.add/remove/test/oauth.*`, `mcp.catalog` | M |
| 4.3 | **Skills**: browse, search, install, update, view a skill's contents | `skills.manage`, `skills.reload` | M |
| 4.4 | **Scheduled jobs**: create and edit with a cron helper, run now, history with outputs | `cron.manage`, `/api/jobs` | M |
| 4.5 | **Messaging platforms**: Discord, Telegram and others, with connection status, pairing and channel routing | `platforms.changed`, `/health/detailed`, gateway API | M |
| 4.6 | **Config editor**: schema-aware form for `config.yaml` with diff-before-save, plus env/keys management | `config.get/set/show`, `reload.env`, `model.save_key` | L |
| 4.7 | **Memory and learning**: view and edit what Hermes remembers about you | `learning.*`, memory providers | M |
| 4.8 | **Usage and insights dashboard**: sessions, tokens, cost by model, source and project over time | `insights.get`, `usage.bars` | M |
| 4.9 | **Vault and connectors**: browser vault logins and connected accounts | `vault.*`, `connectors.*` | M |
| 4.10 | **Hermes update flow**: changelog, a one-click update, restart `serve`, re-sync the contract, smoke-test | `update_command`, `scripts/` | M |

## Milestone 5: Every surface, everywhere

| | Item | Why | Size |
|---|---|---|---|
| 5.1 | **Reply into Discord and Telegram from Gibbous** by handing the message to the gateway that owns the session (gateway API on :8642 or a gateway relay), not by writing the session ourselves | Read-only today, for good reason | L |
| 5.2 | **Live updates for external sessions** via the gateway's event stream instead of 8-second polling | Instant and cheaper | M |
| 5.3 | **Voice**: push-to-talk in the composer, spoken replies, hands-free mode on the phone | `voice.record`, `voice.tts`, `voice.*` | M |
| 5.4 | **Bot Mode rooms**: multi-profile group chats as a first-class view | `groups.*` | L |
| 5.5 | **Browser and computer use**: watch the agent's browser or sandbox desktop live, take over | `browser.manage`, `display.*` | L |
| 5.6 | **Multiple Hermes hosts**: connect Gibbous to Hermes on other machines (Mac mini, server) over SSH or the tailnet; per-thread host | Paseo-style fleet | L |
| 5.7 | **Import Claude Code and Codex sessions** | `session.foreign.list/preview/import` | S |
| 5.8 | **Share and export**: thread to Markdown or HTML, a read-only share link on the tailnet | — | S |
| 5.9 | **Desktop app extras**: menu-bar icon with the needs-you count, global hotkey for quick-ask, launch at login, auto-update | — | M |

## Milestone 6: Quality and hardening

| | Item | Size |
|---|---|---|
| 6.1 | **Orchestrator tests**: a fake Hermes JSON-RPC server, with scripted tests for the task state machine (queue, review loop, restart catch-up, merge guards) | M |
| 6.2 | **Contract smoke test** after every `hermes update`: handshake, create, submit, history, approve. Fails loudly when the protocol drifts | S |
| 6.3 | **End-to-end UI tests** (Playwright) for the main flows on desktop and phone viewports | M |
| 6.4 | **State to SQLite** once `state.json` grows; keep a JSON export | S |
| 6.5 | **Accessibility pass**: screen-reader labels on the timeline, focus order in dialogs, contrast check, reduced motion audit | S |
| 6.6 | **Light theme** and density settings | S |
| 6.7 | **Logs and diagnostics page**: Gibbous and `serve` logs, connection state, "copy debug bundle" | S |
| 6.8 | **Backup and restore** of Gibbous state; clean uninstall script (service, Tailscale port, MCP entry) | S |

---

## Suggested order

1. **Milestone 1** first. It's small, and it makes Gibbous pleasant for daily use.
2. Then **2.1–2.4** and **1.4**, the coding loop you'll use most.
3. Then **3.2, 3.4, 3.5** (plan review, reviewer roles, cost), which matter once you run several tasks in parallel.
4. **6.1–6.2** before anything in Milestone 3 gets complex, so orchestration changes stay safe.
5. **Milestone 4** as you hit each "I had to open the dashboard for this" moment.
6. **Milestone 5** by appetite: 5.1 (reply to Discord) and 5.3 (voice) are the most visible.

## Open questions

- **5.1 Discord replies:** OK to read `API_SERVER_KEY` from `~/.hermes/.env` so Gibbous can call the gateway's API, or should the gateway expose a dedicated relay?
- **3.8 Auto-merge:** which repos, if any, would you trust to merge without you?
- **5.6 Multiple hosts:** are there other machines running Hermes you'd want in Gibbous?

---

## Milestone 7: Feel (from hands-on testing)

Found by using the app on desktop and phone and by the monkey test (`e2e/monkey.ts`). Ordered by how often each one gets in the way.

**Status, 2026-10-08:** all 30 are done. Three were partly there already and got finished rather than rebuilt:
- 7.16: the palette already searched all conversations.
- 7.20: Home already had "Pick up where you left off"; it gained snippet chips.
- 7.22: Queue and Back to backlog already covered every move drag and drop can make.

Found and fixed along the way:
- stale tabs broke after a rebuild
- the composer stole focus from rename fields
- hover-only actions were unreachable on touch, in 9 places
- renaming a remote thread renamed the local Hermes session instead
- palette keyword matches outranked name matches

| | Item |
|---|---|
| 7.1 | **Drafts survive everything**: the composer keeps an unsent message per thread across reloads, navigation and app restarts |
| 7.2 | **Undo** for archive and delete: a toast with Undo instead of a confirm dialog for reversible actions |
| 7.3 | **Unread dots**: a thread that finished or asked something while you were elsewhere is marked until you open it |
| 7.4 | **Pin threads** to the top of the sidebar |
| 7.5 | **Filter the sidebar**: type to narrow threads by title, across projects |
| 7.6 | **Rename from the sidebar**: double-click (long-press on phones) a thread to rename it in place |
| 7.7 | **Running timer**: the thread header shows how long the current turn has been running |
| 7.8 | **Per-turn footer**: duration, tokens and cost under each finished reply |
| 7.9 | **Copy buttons**: copy a whole reply, and every code block gets a copy button |
| 7.10 | **Jump to latest** and remembered scroll position per thread |
| 7.11 | **Model and approvals on phones**: the controls hidden on narrow screens move into the thread's ⋯ menu |
| 7.12 | **Swipe from the left edge** opens the drawer on phones; swipe it closed |
| 7.13 | **Camera and photo upload** on phones from the composer |
| 7.14 | **Share sheet** on phones for exports and share links |
| 7.15 | **Palette actions**: toggle theme, new room, archive this thread, open any board, go to any settings section |
| 7.16 | **Search messages from ⌘K**: "Search all conversations for …" as the last palette entry |
| 7.17 | **Settings search**: find a setting across all sections |
| 7.18 | **Prompt snippets**: saved prompts you insert from the composer with `;` |
| 7.19 | **Send while offline**: messages typed while reconnecting are queued and sent when the connection is back |
| 7.20 | **Home quick start**: recent projects and "continue where you left off" under the composer |
| 7.21 | **Inbox digest**: "Today" summary of finished threads and tasks, with cost |
| 7.22 | **Board on phones**: move a task between columns from its menu (no drag and drop on touch) |
| 7.23 | **Board filter**: type to filter tasks |
| 7.24 | **Auto-archive**: idle threads older than N days archive themselves (setting, off by default) |
| 7.25 | **Bulk select** in the sidebar: archive or delete several threads at once |
| 7.26 | **Spend alert**: a monthly budget with a notification when you cross it |
| 7.27 | **Needs-you sound**: an optional soft chime when an agent asks for approval |
| 7.28 | **Tonight's moon** on the logo: hover for the phase and the next full moon |
| 7.29 | **Error toasts with details**: "Copy details" on failures, for bug reports |
| 7.30 | **Tab title and favicon**: the favicon shows a dot while agents work, the title counts what needs you |
