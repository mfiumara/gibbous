// Hermes' kanban, shown per project. Gibbous keeps no task state of its own: it reads and acts through the REST API
// the kanban dashboard plugin mounts on `hermes serve` (/api/plugins/kanban/*, the same kanban_db code paths the
// `hermes kanban` CLI and agents use). REST rather than the CLI: one call per board instead of a ~0.8s Python start
// per request, and the CLI refuses even `list` inside delegated agent contexts (its read path writes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Backend } from './hermes.ts';
import type { Project } from './store.ts';
import { openStateDb } from './subagents.ts';

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;   // kanban_db._BOARD_SLUG_RE
export const TASK_RE = /^[A-Za-z0-9_-]{1,64}$/;          // ids are t_<hex>; anything path-safe is passed to Hermes as-is
export const STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived'] as const;
export type KanbanStatus = typeof STATUSES[number];

export interface KanbanBoard {
  slug: string; name: string; description: string; icon: string; color: string;
  defaultWorkdir: string | null; hermesProjectId: string | null; archived: boolean; current: boolean;
  counts: Partial<Record<KanbanStatus, number>>; total: number;
}
export interface KanbanCard {
  id: string; title: string; status: KanbanStatus; assignee: string | null; priority: number;
  createdAt: number; startedAt: number | null; completedAt: number | null; runStartedAt: number | null;
  parents: number; children: number; progress: { done: number; total: number } | null;
  comments: number; summary: string | null; warnings: number; blockKind: string | null; branch: string | null;
}
export interface KanbanColumn { name: KanbanStatus; tasks: KanbanCard[] }
export interface BoardMatch { slug: string; how: 'linked' | 'workdir' | 'hermes-project' | 'inside' }

export class KanbanError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

// ── pure helpers (tested in kanban.test.ts) ────────────────────────────────

export function toBoard(b: any): KanbanBoard {
  return {
    slug: String(b.slug), name: String(b.name || b.slug), description: String(b.description ?? ''), icon: String(b.icon ?? ''), color: String(b.color ?? ''),
    defaultWorkdir: b.default_workdir || null, hermesProjectId: b.project_id || null, archived: !!b.archived, current: !!b.is_current,
    counts: b.counts ?? {}, total: Number(b.total ?? 0),
  };
}

export function toCard(t: any): KanbanCard {
  return {
    id: String(t.id), title: String(t.title ?? ''), status: (STATUSES as readonly string[]).includes(t.status) ? t.status : 'todo',
    assignee: t.assignee || null, priority: Number(t.priority ?? 0),
    createdAt: t.created_at ?? 0, startedAt: t.started_at ?? null, completedAt: t.completed_at ?? null, runStartedAt: t.current_run_started_at ?? null,
    parents: t.link_counts?.parents ?? 0, children: t.link_counts?.children ?? 0, progress: t.progress ?? null,
    comments: t.comment_count ?? 0, summary: t.latest_summary || null, warnings: t.warnings?.count ?? 0, blockKind: t.block_kind || null, branch: t.branch_name || null,
  };
}

// Hermes' /board payload → columns in Hermes' order, trimmed to what a card shows.
export function toColumns(payload: any): KanbanColumn[] {
  return (payload?.columns ?? []).filter((c: any) => (STATUSES as readonly string[]).includes(c.name))
    .map((c: any) => ({ name: c.name, tasks: (c.tasks ?? []).map(toCard) }));
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// Which Hermes board belongs to which Gibbous project. Order: the board you linked by hand, a board whose default
// workdir IS the project, a board scoped to a Hermes project with that path, then a board whose workdir sits inside
// the project (boards often point at a sub-repo, e.g. <project>/<package>) — only for the closest enclosing project.
export function matchBoards(projects: Pick<Project, 'id' | 'path' | 'kanbanBoard'>[], boards: KanbanBoard[],
  hermesProjects: { id: string; primary_path: string }[] = [], real: (p: string) => string = p => p): Record<string, BoardMatch> {
  const live = boards.filter(b => !b.archived);
  const paths = new Map(projects.map(p => [p.id, real(p.path)]));
  const hp = new Map(hermesProjects.map(h => [h.id, h.primary_path ? real(h.primary_path) : '']));
  const wd = new Map(live.map(b => [b.slug, b.defaultWorkdir ? real(b.defaultWorkdir) : '']));
  const out: Record<string, BoardMatch> = {};
  for (const p of projects) {
    const dir = paths.get(p.id)!;
    const linked = p.kanbanBoard && live.find(b => b.slug === p.kanbanBoard);
    if (linked) { out[p.id] = { slug: linked.slug, how: 'linked' }; continue; }
    const exact = live.find(b => wd.get(b.slug) === dir);
    if (exact) { out[p.id] = { slug: exact.slug, how: 'workdir' }; continue; }
    const scoped = live.find(b => b.hermesProjectId && hp.get(b.hermesProjectId) === dir);
    if (scoped) { out[p.id] = { slug: scoped.slug, how: 'hermes-project' }; continue; }
    const nested = live.filter(b => {
      const w = wd.get(b.slug);
      if (!w || !inside(w, dir)) return false;
      // A deeper project that also contains the workdir owns it instead.
      return ![...paths.values()].some(o => o !== dir && inside(o, dir) && inside(w, o));
    }).sort((a, b) => wd.get(a.slug)!.length - wd.get(b.slug)!.length)[0];
    if (nested) out[p.id] = { slug: nested.slug, how: 'inside' };
  }
  return out;
}

export function realpathOr(p: string) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

// ── Hermes REST ─────────────────────────────────────────────────────────

const BASE = '/api/plugins/kanban';
export async function kanbanFetch<T = any>(b: Backend, method: string, p: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${b.port}${BASE}${p}`, {
      method, signal: AbortSignal.timeout(20_000),
      headers: { 'X-Hermes-Session-Token': b.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e: any) { throw new KanbanError(503, `Hermes is not reachable: ${e.message ?? e}`); }
  const data: any = await r.json().catch(() => null);
  if (r.ok) return data as T;
  const detail = typeof data?.detail === 'string' ? data.detail : data?.detail ? JSON.stringify(data.detail) : '';
  // Route missing entirely (no `detail` from a kanban handler): the plugin isn't mounted on this Hermes.
  if (r.status === 404 && (!detail || detail === 'Not Found')) throw new KanbanError(501, 'This Hermes has no kanban API (the kanban dashboard plugin is missing or disabled). Update Hermes or enable the kanban plugin.');
  throw new KanbanError(r.status >= 400 && r.status < 500 ? r.status : 502, detail || `Hermes kanban: HTTP ${r.status}`);
}

// Polling tabs (every few seconds, several devices) share one Hermes read per board.
const cache = new Map<string, { at: number; value: Promise<any> }>();
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}
export const invalidate = (slug?: string) => { for (const k of cache.keys()) if (!slug || k === 'boards' || k.includes(`:${slug}:`) || k.endsWith(`:${slug}`)) cache.delete(k); };

export const slug = (s: string) => { const v = String(s ?? '').toLowerCase(); if (!SLUG_RE.test(v)) throw new KanbanError(400, 'invalid board slug'); return v; };
export const taskId = (s: string) => { if (!TASK_RE.test(String(s ?? ''))) throw new KanbanError(400, 'invalid task id'); return s; };

export async function listBoards(b: Backend) {
  return cached('boards', 2000, async () => {
    const [r, hp] = await Promise.all([
      kanbanFetch<{ boards: any[]; current: string }>(b, 'GET', '/boards'),
      kanbanFetch<{ projects: { id: string; primary_path: string }[] }>(b, 'GET', '/projects').catch(() => ({ projects: [] })),
    ]);
    return { boards: r.boards.map(toBoard), current: r.current, hermesProjects: hp.projects };
  });
}

export async function boardTasks(b: Backend, s: string, archived: boolean) {
  return cached(`tasks:${s}:${archived ? 1 : 0}`, 2000, async () => {
    const r = await kanbanFetch(b, 'GET', `/board?board=${encodeURIComponent(s)}${archived ? '&include_archived=true' : ''}`);
    return { columns: toColumns(r), assignees: (r.assignees ?? []) as string[], now: r.now as number };
  });
}

export async function taskDetail(b: Backend, s: string, id: string) {
  const r = await kanbanFetch(b, 'GET', `/tasks/${encodeURIComponent(id)}?board=${encodeURIComponent(s)}`);
  const t = r.task;
  return {
    task: { ...toCard(t), body: t.body ?? '', result: t.result ?? null, summary: t.latest_summary ?? null, workspace: t.workspace_path ?? null, createdBy: t.created_by ?? null, tenant: t.tenant ?? null, lastError: t.last_failure_error ?? null },
    comments: (r.comments ?? []).map((c: any) => ({ id: c.id, author: c.author, body: c.body, at: c.created_at })),
    events: (r.events ?? []).filter((e: any) => e.kind !== 'heartbeat').map((e: any) => ({ id: e.id, kind: e.kind, payload: e.payload, at: e.created_at, runId: e.run_id })),
    runs: (r.runs ?? []).map((x: any) => ({ id: x.id, profile: x.profile, status: x.status, outcome: x.outcome, summary: x.summary, error: x.error, startedAt: x.started_at, endedAt: x.ended_at, sessionId: workerSession(x.profile, t.title, x.started_at, x.ended_at) })),
    links: (r.link_tasks ?? []).map((l: any) => ({ id: l.id, title: l.title, status: l.status, parent: (r.links?.parents ?? []).includes(l.id) })),
  };
}

// A kanban worker runs as its own Hermes session (source 'kanban') in the assignee profile's state.db, but neither side
// stores the other's id. Match by profile + time window (+ title, which the dispatcher copies from the task).
export function workerSession(profile: string | null, title: string, startedAt: number | null, endedAt: number | null): string | null {
  if (!profile || !/^[\w-]+$/.test(profile) || !startedAt) return null;
  try {
    const db = openStateDb(profile);
    const row = db?.prepare(`SELECT id FROM sessions WHERE source = 'kanban' AND parent_session_id IS NULL AND started_at BETWEEN ? AND ?
      ORDER BY (title = ?) DESC, started_at LIMIT 1`).get(startedAt - 5, (endedAt ?? Date.now() / 1000) + 5, title) as { id: string } | undefined;
    return row?.id ?? null;
  } catch { return null; }
}

// ── dependency links (straight from the board's SQLite, read-only) ─────────
// The /board payload only carries link COUNTS; the graph view needs the edges. Hermes keeps them in `task_links` of the
// board's own db: `default` → <root>/kanban.db, others → <root>/kanban/boards/<slug>/kanban.db, where <root> is
// HERMES_KANBAN_HOME, else the default Hermes root (boards are shared across profiles; kanban_db.kanban_home and
// hermes_constants.get_default_hermes_root).
export function kanbanDbPath(s: string, env: NodeJS.ProcessEnv = process.env, homedir = os.homedir()): string {
  const native = path.join(homedir, '.hermes'), h = env.HERMES_HOME?.trim();
  const root = env.HERMES_KANBAN_HOME?.trim()
    || (!h || inside(path.resolve(h), native) ? native                                 // ~/.hermes, or a profile under it
      : path.basename(path.dirname(h)) === 'profiles' ? path.dirname(path.dirname(h)) : h); // custom root (/x/profiles/p → /x)
  return s === 'default' ? path.join(root, 'kanban.db') : path.join(root, 'kanban', 'boards', s, 'kanban.db');
}

export interface KanbanLink { parent: string; child: string }
const linkDbs = new Map<string, DatabaseSync>();
// node:sqlite opens a live WAL db read-only fine (Python's `mode=ro` doesn't). A missing db or table = no links.
export function readLinks(file: string): KanbanLink[] {
  if (!fs.existsSync(file)) { linkDbs.get(file)?.close(); linkDbs.delete(file); return []; }
  try {
    let db = linkDbs.get(file);
    if (!db) { db = new DatabaseSync(file, { readOnly: true }); db.exec('PRAGMA busy_timeout = 2000'); linkDbs.set(file, db); }
    return (db.prepare('SELECT parent_id AS parent, child_id AS child FROM task_links ORDER BY rowid').all() as any[])
      .map(r => ({ parent: String(r.parent), child: String(r.child) }));
  } catch (e: any) {
    if (/no such table/.test(String(e?.message))) return [];
    linkDbs.get(file)?.close(); linkDbs.delete(file);   // a replaced file: reopen next time
    throw new KanbanError(502, `Could not read the board's links: ${e?.message ?? e}`);
  }
}

export function boardLinks(s: string, env: NodeJS.ProcessEnv = process.env) {
  return cached(`links:${s}`, 2000, async () => ({ links: readLinks(kanbanDbPath(s, env)) }));
}

// Mutations: one verb each, mapped onto the plugin's PATCH/POST so state transitions stay Hermes' own.
export async function act(b: Backend, s: string, id: string, verb: string, body: any) {
  const q = `?board=${encodeURIComponent(s)}`, t = `/tasks/${encodeURIComponent(id)}${q}`;
  const text = (v: unknown, max = 20_000) => String(v ?? '').slice(0, max);
  let r: unknown;
  switch (verb) {
    case 'comment': if (!text(body.body).trim()) throw new KanbanError(400, 'comment is empty'); r = await kanbanFetch(b, 'POST', `/tasks/${encodeURIComponent(id)}/comments${q}`, { body: text(body.body), author: 'gibbous' }); break;
    case 'block': r = await kanbanFetch(b, 'PATCH', t, { status: 'blocked', block_reason: text(body.reason, 2000) || undefined }); break;
    case 'unblock': r = await kanbanFetch(b, 'PATCH', t, { status: 'ready' }); break;
    case 'archive': r = await kanbanFetch(b, 'PATCH', t, { status: 'archived' }); break;
    case 'assign': r = await kanbanFetch(b, 'PATCH', t, { assignee: text(body.assignee, 200) }); break;
    default: throw new KanbanError(400, `unknown action ${verb}`);
  }
  invalidate(s);
  return r;
}

export async function createTask(b: Backend, s: string, body: any) {
  const title = String(body.title ?? '').trim().slice(0, 300);
  if (!title) throw new KanbanError(400, 'title is required');
  const r = await kanbanFetch(b, 'POST', `/tasks?board=${encodeURIComponent(s)}`, {
    title, body: String(body.body ?? '').slice(0, 50_000) || undefined, assignee: String(body.assignee ?? '').slice(0, 200) || undefined,
    priority: Number.isFinite(body.priority) ? Math.trunc(body.priority) : 0, triage: !!body.triage,
  });
  invalidate(s);
  return { task: r.task ? toCard(r.task) : null, warning: r.warning ?? null };
}
