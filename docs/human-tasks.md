# Tasks for the human

Each thread can hold one **For me** task, separate from the agent’s kanban work. Add it from the thread’s ⋯ menu, a sidebar row’s context menu (long press on phones), or the command palette. Complete it with the round checkbox or the card’s Done control; Edit replaces it, Remove clears it. Open tasks stay visible even for archived threads and count toward the app/tab/push badge, together with pending approvals.

## Let agents file tasks for you (explicit opt-in)

From your Gibbous installation, run once:

```sh
node scripts/enable-human-tasks.ts
```

If your server uses a custom home or port, pass the **same** `GIBBOUS_HOME` and `GIBBOUS_PORT` to this command. It calls Hermes’ own `hermes config set mcp_servers.gibbous …`, replaces any stale Gibbous MCP entry, and uses `http://127.0.0.1:<GIBBOUS_PORT>/mcp` (default 7878, not the test port). It writes only when you run it. The bearer credential is generated in `GIBBOUS_HOME/human-task-mcp-secret.json` (0600), separate from state/backups, and never printed. Reload MCP using `/reload-mcp` or start a fresh agent session. Disable with `hermes mcp remove gibbous`.

Tools:

- `gibbous_request_human_task {text: string, thread?: string}` — one short imperative sentence, 1–1000 characters. Replaces the task and sends an input notification.
- `gibbous_complete_human_task {thread?: string}` — mark it done after the user confirms.

`thread` accepts either the Gibbous thread ID or the caller’s durable Hermes session ID. If unknown, the agent must read `HERMES_SESSION_ID` in its own terminal and pass it as `thread`. The tool description explains this. A client that supplies `X-Hermes-Session-Id` can omit `thread`; today Hermes does **not** send that header to MCP servers.

### Why caller identity is explicit

Hermes source `tools/mcp_tool_server_run.py` constructs its HTTP transport from static config headers (around line 292); `tools/mcp_tool_handlers.py` (around lines 586–592) calls the tool with only its arguments. Call context is retained for elicitation, not sent in headers. Config placeholders resolve environment/workspace values at connection time (`mcp_tool_config.py`), not per session. Connections are shared across conversations, so a configured session header would misattribute concurrent agents.

Hermes’ local terminal bridges session ContextVars into each child environment (`tools/environments/local.py`, `_inject_session_context_env`, around lines 223–241), explicitly preventing cross-session last-writer-wins leakage. That makes reading `HERMES_SESSION_ID` in the calling agent’s terminal a reliable fallback on the local backend. Gibbous maps the supplied session to `thread.sessionId`, following `sessions.parent_session_id` read-only in the relevant profile’s state.db for compression continuations. No prompt injection or Hermes modification is needed. Missing/unknown identities fail closed: matching the most recent running thread or cwd is unsafe when agents share a checkout. Remote sessions must supply the explicit Gibbous thread ID, since their session database is on another host. This is routing, not per-thread authorization: the bearer credential grants task mutation across Gibbous threads.

REST (normal browser authentication): `PUT /api/threads/:id/human-task {text}`, `POST /api/threads/:id/human-task/done {}`, `DELETE /api/threads/:id/human-task {}`. User-written tasks do not notify; MCP-written tasks notify with kind input and body equal to the task text.
