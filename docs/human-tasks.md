# Tasks for the human

Each thread holds a **For me** checklist, separate from the agent’s kanban work. Add tasks from the thread’s ⋯ menu, a sidebar context menu, ⌘K “Add a task for me”, or the checklist’s inline **+ Add**. Each open task has its own sidebar row and round checkbox; three or more share a tiny thread heading. Clicking a row opens the thread and highlights that task. Double-click a task or use its pencil to edit; × removes only that task. Completed tasks fold into **N done**, where they can be unchecked. Open tasks stay visible across spaces and archived threads, and count toward app/tab/push badges together with pending approvals.

Assistant paragraphs and list items offer **+ For me** on hover (never code or tables). On phones, long-press a reply item and choose **Add to For me**; a text selection takes precedence. The plain text, including bold leads, is shortened to about 140 characters. Nothing is sent to the agent.

## Let agents file tasks for you (explicit opt-in)

From your Gibbous installation, run once:

```sh
node scripts/enable-human-tasks.ts
```

If your server uses a custom home or port, pass the **same** `GIBBOUS_HOME` and `GIBBOUS_PORT` to this command. It calls Hermes’ own `hermes config set mcp_servers.gibbous …`, replaces any stale Gibbous MCP entry, and uses `http://127.0.0.1:<GIBBOUS_PORT>/mcp` (default 7878, not the test port). It writes only when you run it. The bearer credential is generated in `GIBBOUS_HOME/human-task-mcp-secret.json` (0600), separate from state/backups, and never printed. Reload MCP using `/reload-mcp` or start a fresh agent session. Disable with `hermes mcp remove gibbous`.

Tools:

- `gibbous_request_human_task {tasks: string[], thread?: string}` — append 1–10 short imperative items (1–1000 characters each); returns `created` task ids and the full task list. Legacy `{text}` still appends one task.
- `gibbous_list_human_tasks {thread?: string}` — list ids, text, author, timestamps and completion state. Check before filing to avoid duplicates.
- `gibbous_complete_human_task {task_id?: string, text?: string, thread?: string}` — complete exactly one open task after the user confirms, by id or exact text. For compatibility, omitting both selectors works only when exactly one task is open.

Tool descriptions and MCP initialization instructions require agents to file **every** human-only step before ending their turn, including hardware tests, judgement calls, approvals, purchases and sign-ins. They must not file work they can do themselves. Existing sessions need `/reload-mcp` (or a fresh session) to see new tools/descriptions; prose alone does not create tasks.

`thread` accepts either the Gibbous thread ID or the caller’s durable Hermes session ID. If unknown, the agent must read `HERMES_SESSION_ID` in its own terminal and pass it as `thread`. The tool description explains this. A client that supplies `X-Hermes-Session-Id` can omit `thread`; today Hermes does **not** send that header to MCP servers.

### Why caller identity is explicit

Hermes source `tools/mcp_tool_server_run.py` constructs its HTTP transport from static config headers (around line 292); `tools/mcp_tool_handlers.py` (around lines 586–592) calls the tool with only its arguments. Call context is retained for elicitation, not sent in headers. Config placeholders resolve environment/workspace values at connection time (`mcp_tool_config.py`), not per session. Connections are shared across conversations, so a configured session header would misattribute concurrent agents.

Hermes’ local terminal bridges session ContextVars into each child environment (`tools/environments/local.py`, `_inject_session_context_env`, around lines 223–241), explicitly preventing cross-session last-writer-wins leakage. That makes reading `HERMES_SESSION_ID` in the calling agent’s terminal a reliable fallback on the local backend. Gibbous maps the supplied session to `thread.sessionId`, following `sessions.parent_session_id` read-only in the relevant profile’s state.db for compression continuations. No prompt injection or Hermes modification is needed. Missing/unknown identities fail closed: matching the most recent running thread or cwd is unsafe when agents share a checkout. Remote sessions must supply the explicit Gibbous thread ID, since their session database is on another host. This is routing, not per-thread authorization: the bearer credential grants task mutation across Gibbous threads.

REST (normal browser authentication):

- `POST /api/threads/:id/human-tasks {text}` adds a task.
- `PATCH /api/threads/:id/human-tasks/:taskId {text?, done?: boolean}` edits, completes or reopens one task.
- `DELETE /api/threads/:id/human-tasks/:taskId {}` removes one task.

The old singular `PUT …/human-task`, `POST …/human-task/done`, `DELETE …/human-task` remain thin compatibility aliases: they refuse ambiguous multi-task changes. Storage is `thread.humanTasks: {id,text,at,by,doneAt?}[]`; old `humanTask` backups migrate with stable ids. User-written tasks never notify. Agent additions debounce for about three seconds per thread: one notification per batch, with the single text or “Gibbous needs you · N things”. Removed/completed tasks are excluded at delivery.
