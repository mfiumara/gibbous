// Bringing Hermes / Claude Code / Codex sessions into Gibbous as threads: pure helpers (grouping, default selection,
// dedupe) plus the sequential import loop, with every side effect injected so it's testable without a browser.
// Used by the first-run picker (Welcome.tsx) and Hermes history's multi-select (Inbox.tsx).
import type { SessionListRow, ForeignSessionRow } from './hermes/contract';

export type Kind = 'hermes' | 'claude' | 'codex';
export interface Candidate {
  key: string;        // unique across kinds: `${kind}:${id}`
  kind: Kind;
  id: string;         // Hermes session id, or the opaque foreign-session handle
  title: string; preview: string;
  source: string;     // Hermes session source (cli, desktop, discord…) or claude_code / codex
  at: number;         // last activity (ms), started_at when Hermes doesn't say
  cwd?: string;
  folder?: string;    // the project folder it groups under (repo root for worktrees)
  messages?: number;
}
export interface Folder { root: string; repo: boolean; exists: boolean }
export interface SessionDirs { home: string; sessions: Record<string, { cwd?: string; at?: number }>; folders: Record<string, Folder> }

// Automated runs: scheduled jobs, delegate children, kanban workers, tool integrations, one-shots. Not conversations.
export const NOISE_SOURCES = new Set(['cron', 'subagent', 'kanban', 'tool', 'oneshot', 'unknown']);
// Gateway-owned chats: imported read-only (replies go through the platform), and they can be mirrored automatically.
export const MESSAGING_SOURCES = new Set(['discord', 'telegram', 'slack', 'whatsapp', 'signal', 'matrix', 'mattermost', 'email', 'sms', 'homeassistant', 'dingtalk', 'feishu', 'wecom', 'weixin', 'qq', 'yuanbao']);
// Sessions another surface owns (messaging gateways, IDE/Paseo over ACP, the API) open read-only, like Hermes history.
// Your own CLI/TUI/desktop sessions become live threads you can keep talking in.
export const readOnlyFor = (source: string) => MESSAGING_SOURCES.has(source) || source === 'acp' || source === 'api_server' || source === 'webhook';

export const RECENT_DAYS = 14;
const DAY = 86_400_000;

export function hermesCandidate(r: SessionListRow, dirs?: SessionDirs): Candidate {
  const source = r.source || 'other', d = dirs?.sessions[r.id], cwd = d?.cwd;
  return { key: `hermes:${r.id}`, kind: 'hermes', id: r.id, title: r.title || r.preview?.slice(0, 80) || 'Untitled', preview: r.preview ?? '', source,
    at: d?.at ?? (r.started_at ?? 0) * 1000, cwd, folder: cwd && dirs && !MESSAGING_SOURCES.has(source) ? folderKey(cwd, dirs) : undefined, messages: r.message_count };
}

export function fromHermes(rows: SessionListRow[], dirs?: SessionDirs): Candidate[] {
  // Empty sessions (opened, never used) are noise too.
  return rows.filter(r => !NOISE_SOURCES.has(r.source || 'other') && r.message_count).map(r => hermesCandidate(r, dirs)).sort((a, b) => b.at - a.at);
}

export function fromForeign(rows: ForeignSessionRow[]): Candidate[] {
  return rows.map(r => ({ key: `${r.source}:${r.id}`, kind: r.source, id: r.id, title: r.title || r.label, preview: r.excerpt ?? '', source: r.source === 'claude' ? 'claude_code' : 'codex',
    at: r.mtime * 1000, cwd: r.cwd ?? undefined, messages: r.turn_count } as Candidate)).sort((a, b) => b.at - a.at);
}

// Removed worktrees (Paseo's ~/.paseo/worktrees/<id>/<name>, Gibbous' …/worktrees/<project>/<name>) collapse into
// their parent so a hundred dead checkouts read as one group.
export function folderKey(cwd: string, dirs: SessionDirs): string {
  const f = dirs.folders[cwd];
  const m = /^(.*\/worktrees\/[^/]+)\/[^/]+$/.exec(cwd);
  if (f?.exists && (f.repo || !m)) return f.root; // a worktree folder that's no checkout any more is a leftover too
  return m ? m[1] : f?.root ?? cwd;
}

export interface Group {
  key: string; label: string; detail?: string;
  folder?: string;          // set when grouped by folder
  canProject: boolean;      // the folder exists and isn't the home folder: offer "Add as project"
  repo: boolean;            // a git repository (its "Add as project" starts on)
  items: Candidate[];
}
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const tilde = (p: string, home: string) => p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;

// Folder groups for sessions with a known folder, source groups for the rest; the most recently active group first.
export function groupCandidates(cands: Candidate[], o: { dirs?: SessionDirs; label(source: string): string }): Group[] {
  const home = o.dirs?.home ?? '';
  const folders = Object.values(o.dirs?.folders ?? {});
  const exists = new Set(folders.filter(f => f.exists).map(f => f.root)), repos = new Set(folders.filter(f => f.repo).map(f => f.root));
  const m = new Map<string, Group>();
  for (const c of cands) {
    const key = c.folder ? `dir:${c.folder}` : `src:${c.source}`;
    let g = m.get(key);
    if (!g) {
      if (c.folder) {
        const dead = !exists.has(c.folder);
        g = { key, folder: c.folder, items: [], repo: repos.has(c.folder), canProject: !dead && c.folder !== home && !/\/worktrees\/[^/]+$/.test(c.folder),
          label: c.folder === home ? 'Home folder' : dead && /\/worktrees\/[^/]+$/.test(c.folder) ? `Removed worktrees (${base(c.folder)})` : base(c.folder),
          detail: tilde(c.folder, home) };
      } else g = { key, label: o.label(c.source), canProject: false, repo: false, items: [] };
      m.set(key, g);
    }
    g.items.push(c);
  }
  const at = (g: Group) => Math.max(...g.items.map(c => c.at));
  return [...m.values()].sort((a, b) => at(b) - at(a));
}

// Pre-ticked: Hermes sessions active in the last 14 days that aren't in Gibbous yet. Claude Code / Codex sessions
// start unticked: importing one copies it into Hermes for good, so that's always an explicit pick.
export function defaultSelection(cands: Candidate[], imported: Set<string>, now = Date.now()): Set<string> {
  return new Set(cands.filter(c => c.kind === 'hermes' && !imported.has(c.id) && now - c.at < RECENT_DAYS * DAY).map(c => c.key));
}

// Hover text for a relative age: time only for today, weekday + date otherwise, the year only when it differs.
export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at), n = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === n.toDateString()) return `Last active today, ${time}`;
  return `Last active ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) })}, ${time}`;
}

export function matches(c: Candidate, q: string) {
  const n = q.trim().toLowerCase();
  return !n || `${c.title} ${c.preview} ${c.cwd ?? ''} ${c.source}`.toLowerCase().includes(n);
}

export type Tri = 'all' | 'some' | 'none';
export function triState(items: Candidate[], sel: Set<string>): Tri {
  const n = items.filter(c => sel.has(c.key)).length;
  return n === 0 ? 'none' : n === items.length ? 'all' : 'some';
}
// A group's checkbox: anything unticked → tick them all; all ticked → untick all.
export function toggleAll(sel: Set<string>, items: Candidate[]): Set<string> {
  const next = new Set(sel), on = triState(items, sel) !== 'all';
  for (const c of items) on ? next.add(c.key) : next.delete(c.key);
  return next;
}

export function countBy<T>(xs: T[], f: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export interface ImportDeps {
  imported: Set<string>;                                   // Hermes session ids already behind a Gibbous thread
  projectFor(folder: string): Promise<string | undefined>; // find-or-create the project for a folder
  importForeign(c: Candidate): Promise<string>;            // copy a Claude Code / Codex session into Hermes → its session id
  addThread(body: { sessionId: string; title: string; source: string; startedAt?: number; projectId?: string; readOnly: boolean }): Promise<{ id: string }>;
  onProgress?(done: number, total: number, current?: Candidate): void;
}
export interface ImportResult { threads: string[]; skipped: number; failed: { c: Candidate; error: string }[] }

// One at a time (Hermes copies and project creation aren't free), skipping what's already in, carrying on past failures.
// `projectFolders`: folders whose sessions land in a project (find-or-create runs once per folder).
export async function runImport(items: Candidate[], projectFolders: Set<string>, d: ImportDeps): Promise<ImportResult> {
  const res: ImportResult = { threads: [], skipped: 0, failed: [] }, seen = new Set(d.imported), projects = new Map<string, Promise<string | undefined>>();
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    d.onProgress?.(i, items.length, c);
    try {
      if (c.kind === 'hermes' && seen.has(c.id)) { res.skipped++; continue; }
      let projectId: string | undefined;
      if (c.folder && projectFolders.has(c.folder)) {
        if (!projects.has(c.folder)) projects.set(c.folder, d.projectFor(c.folder));
        projectId = await projects.get(c.folder)!.catch(() => undefined); // a folder that can't be a project still imports, unfiled
      }
      const sessionId = c.kind === 'hermes' ? c.id : await d.importForeign(c);
      if (seen.has(sessionId)) { res.skipped++; continue; }
      seen.add(sessionId);
      const t = await d.addThread({ sessionId, title: c.title, source: c.source, startedAt: c.at || undefined, projectId, readOnly: c.kind === 'hermes' && readOnlyFor(c.source) });
      res.threads.push(t.id);
    } catch (e) { res.failed.push({ c, error: (e as Error)?.message ?? String(e) }); }
  }
  d.onProgress?.(items.length, items.length);
  return res;
}
