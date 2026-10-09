// Gibbous as an MCP server (streamable HTTP, stateless, JSON responses) so Hermes agents can orchestrate:
// a coordinator thread — or Hermes on Telegram — can spawn worktree threads, wait on them, read diffs, merge.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Orchestrator } from './orchestrator.ts';
import { state } from './store.ts';
import * as g from './git.ts';

type Args = Record<string, any>;
const str = (description: string) => ({ type: 'string', description });

export function mcpTools(o: Orchestrator) {
  const project = (ref: string) => {
    const p = state.projects.find(p => p.id === ref || p.name === ref || p.path === ref);
    if (!p) throw new Error(`unknown project "${ref}". Known: ${state.projects.map(p => p.name).join(', ') || 'none'}`);
    return p;
  };
  const thread = (id: string) => { const t = o.thread(id); if (!t) throw new Error(`unknown thread ${id}`); return t; };
  const brief = (t: ReturnType<typeof thread>) => ({
    id: t.id, title: t.title, status: t.status, role: t.role, project: o.project(t.projectId)?.name,
    cwd: t.cwd, branch: t.worktree?.branch, task: t.taskId, error: t.error, last_reply: t.lastText?.slice(-3000),
  });

  return {
    gibbous_list_projects: {
      description: 'List projects (repositories) Gibbous manages.',
      inputSchema: { type: 'object', properties: {} },
      run: () => state.projects.map(p => ({ id: p.id, name: p.name, path: p.path, base_branch: p.baseBranch })),
    },
    gibbous_add_project: {
      description: 'Register a local directory/repository as a Gibbous project.',
      inputSchema: { type: 'object', properties: { path: str('absolute path'), name: str('display name') }, required: ['path'] },
      run: (a: Args) => o.addProject(a.path, a.name),
    },
    gibbous_list_threads: {
      description: 'List Gibbous threads (agent sessions) with their status, optionally for one project.',
      inputSchema: { type: 'object', properties: { project: str('project id, name or path') } },
      run: (a: Args) => state.threads.filter(t => t.status !== 'archived' && (!a.project || t.projectId === project(a.project).id)).map(brief),
    },
    gibbous_spawn_thread: {
      description: 'Start a new Hermes agent thread on a project, by default in its own fresh git worktree, and send it a prompt. Returns immediately; use gibbous_wait to wait for it.',
      inputSchema: {
        type: 'object', required: ['project', 'title', 'prompt'],
        properties: { project: str('project id, name or path'), title: str('short title'), prompt: str('full self-contained instructions'), worktree: { type: 'boolean', description: 'isolated worktree (default true)' }, parent_thread_id: str('your own Gibbous thread id, if you are a coordinator thread') },
      },
      run: async (a: Args) => brief(await o.createThread({ projectId: project(a.project).id, title: a.title, prompt: a.prompt, worktree: a.worktree ?? true, role: 'worker', parentId: a.parent_thread_id && o.thread(a.parent_thread_id) ? a.parent_thread_id : undefined })),
    },
    gibbous_read_thread: {
      description: 'Get a thread status, its last reply and the files it changed.',
      inputSchema: { type: 'object', required: ['thread_id'], properties: { thread_id: str('thread id') } },
      run: async (a: Args) => {
        const t = thread(a.thread_id);
        const changes = await g.changes(t.cwd, t.worktree?.base).catch(() => []);
        return { ...brief(t), changed_files: changes.map(c => `${c.status} ${c.path} +${c.added}/-${c.removed}`) };
      },
    },
    gibbous_send: {
      description: 'Send a follow-up message to a thread (it runs a new turn).',
      inputSchema: { type: 'object', required: ['thread_id', 'text'], properties: { thread_id: str('thread id'), text: str('message') } },
      run: async (a: Args) => { await o.send(thread(a.thread_id), a.text); return 'sent'; },
    },
    gibbous_wait: {
      description: 'Block until all given threads finish their current turn (or timeout), then return their status and last replies.',
      inputSchema: { type: 'object', required: ['thread_ids'], properties: { thread_ids: { type: 'array', items: { type: 'string' } }, timeout_seconds: { type: 'number', description: 'default 240, max 280 (call again to keep waiting)' } } },
      run: async (a: Args) => (await o.waitIdle(a.thread_ids, Math.min(Number(a.timeout_seconds ?? 240), 280) * 1000 /* Hermes aborts MCP calls at 300s */)).map(brief),
    },
    gibbous_thread_diff: {
      description: "Unified diff of a thread's workspace (vs its worktree base, incl. uncommitted changes). Truncated to 40k chars.",
      inputSchema: { type: 'object', required: ['thread_id'], properties: { thread_id: str('thread id') } },
      run: async (a: Args) => { const t = thread(a.thread_id); const d = await g.fullDiff(t.cwd, t.worktree?.base); return d.length > 40000 ? d.slice(0, 40000) + '\n…[truncated]' : d || '(no changes)'; },
    },
    gibbous_create_tasks: {
      description: "Add tasks to a project's Gibbous board. Tasks run in parallel worktrees, get auto-reviewed, then wait for the user to merge. Use keys to express dependencies.",
      inputSchema: {
        type: 'object', required: ['project', 'tasks'],
        properties: {
          project: str('project id, name or path'),
          queue: { type: 'boolean', description: 'start them now (default false = backlog for the user to approve)' },
          tasks: { type: 'array', items: { type: 'object', required: ['key', 'title', 'prompt'], properties: { key: str('local key'), title: str('title'), prompt: str('instructions'), deps: { type: 'array', items: { type: 'string' } } } } },
        },
      },
      run: (a: Args) => {
        const p = project(a.project);
        const ids = new Map<string, string>();
        const made = (a.tasks as any[]).map(x => { const t = o.createTask({ projectId: p.id, title: x.title, prompt: x.prompt, status: a.queue ? 'queued' : 'backlog' }); ids.set(x.key, t.id); return [t, x] as const; });
        for (const [t, x] of made) o.updateTask(t, { deps: (x.deps ?? []).map((k: string) => ids.get(k)).filter(Boolean) });
        return made.map(([t]) => ({ id: t.id, title: t.title, status: t.status, deps: t.deps }));
      },
    },
    gibbous_list_tasks: {
      description: "List a project's board tasks.",
      inputSchema: { type: 'object', required: ['project'], properties: { project: str('project id, name or path') } },
      run: (a: Args) => state.tasks.filter(t => t.projectId === project(a.project).id).map(t => ({ id: t.id, title: t.title, status: t.status, deps: t.deps, thread: t.threadId, verdict: t.verdict, review_notes: t.reviewNotes?.slice(0, 1500), merged: t.mergedAs })),
    },
  } as Record<string, { description: string; inputSchema: object; run: (a: Args) => unknown }>;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, o: Orchestrator, body: any) {
  const tools = mcpTools(o);
  const handle = async (m: any) => {
    if (m.id == null) return undefined; // notification
    try {
      switch (m.method) {
        case 'initialize':
          return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gibbous', version: '0.1.0' }, instructions: 'Gibbous orchestrates parallel Hermes coding threads in git worktrees. Spawn threads, wait for them, inspect diffs, or create board tasks for the user to review.' } };
        case 'ping':
          return { jsonrpc: '2.0', id: m.id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id: m.id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } };
        case 'tools/call': {
          const t = tools[m.params?.name];
          if (!t) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${m.params?.name}` } };
          try {
            const out = await t.run(m.params?.arguments ?? {});
            return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] } };
          } catch (e: any) {
            return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Error: ${e.message ?? e}` }], isError: true } };
          }
        }
        default:
          return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
      }
    } catch (e: any) {
      return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message ?? String(e) } };
    }
  };
  const out = Array.isArray(body) ? (await Promise.all(body.map(handle))).filter(Boolean) : await handle(body);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202).end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
}
