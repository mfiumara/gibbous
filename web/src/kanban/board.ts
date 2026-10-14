// Pure helpers for the Hermes kanban view (tested in board.test.ts); the DOM side is Kanban.tsx.
import type { KanbanCard, KanbanColumn, KanbanStatus } from '../api';

export const LABEL: Record<KanbanStatus, string> = {
  triage: 'Triage', todo: 'To do', scheduled: 'Scheduled', ready: 'Ready', running: 'Running', blocked: 'Blocked', review: 'Review', done: 'Done', archived: 'Archived',
};
export const HINT: Record<KanbanStatus, string> = {
  triage: 'Rough ideas waiting to be specified', todo: 'Waiting on a parent task or not promoted yet', scheduled: 'Parked until a set time',
  ready: 'Queued for the dispatcher to hand to a worker', running: 'A worker profile is on it now', blocked: 'Waiting on a person or an outside event',
  review: 'Implementation done, waiting for a reviewer', done: 'Completed, newest first', archived: 'Hidden from the board',
};
// Always shown, even when empty, so the board keeps its shape: what's waiting, what's moving, what's finished.
const ALWAYS: KanbanStatus[] = ['todo', 'running', 'done'];

// Hermes' column order; empty columns other than ALWAYS fold away, archived only when asked for.
export function visibleColumns(cols: KanbanColumn[], archived: boolean): KanbanColumn[] {
  return cols.filter(c => c.name === 'archived' ? archived : c.tasks.length > 0 || ALWAYS.includes(c.name));
}

// Index of the column h/l should land on, skipping empty ones; null at the edge.
export function stepColumn(cols: KanbanColumn[], from: number, dir: 1 | -1): number | null {
  for (let i = from + dir; i >= 0 && i < cols.length; i += dir) if (cols[i].tasks.length) return i;
  return null;
}

// A filter box matches title, id and assignee.
export function filterColumns(cols: KanbanColumn[], q: string): KanbanColumn[] {
  const n = q.trim().toLowerCase();
  if (!n) return cols;
  return cols.map(c => ({ ...c, tasks: c.tasks.filter(t => `${t.title} ${t.id} ${t.assignee ?? ''}`.toLowerCase().includes(n)) }));
}

// Hermes stores event payloads as JSON (sometimes double-encoded); show a one-line gist.
export function eventGist(kind: string, payload: unknown): string {
  let p: any = payload;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* plain text */ } }
  const words = kind.replace(/_/g, ' ');
  if (p == null || p === 'None') return words;
  if (typeof p !== 'object') return `${words}: ${String(p).slice(0, 140)}`;
  const bit = p.reason ?? p.status ?? p.assignee ?? p.profile ?? p.summary ?? p.error ?? p.message;
  return bit != null && typeof bit !== 'object' ? `${words}: ${String(bit).replace(/\s+/g, ' ').slice(0, 140)}` : words;
}

// Seconds → "5m" / "3h" / "2d" (kanban timestamps are unix seconds).
export const agoS = (sec?: number | null, now = Date.now() / 1000) => {
  if (!sec) return '';
  const s = Math.max(0, now - sec);
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

export type BoardTask = KanbanCard & { fromChat: boolean; next: { id: string; title: string; status: KanbanCard['status'] }[] };
export type Step = { kind: 'task'; id: string; task: BoardTask } | { kind: 'next'; id: string; title: string; status: KanbanCard['status'] };

// Chains for the card: each active task, then what it hands off to. An active task that waits on another active one
// sits right under it (not as its own chain); a task with no active follow-up shows its first queued next step, greyed.
// Only that one: the rest of the queue is on the board.
export function chains(tasks: BoardTask[]): Step[][] {
  tasks = tasks.map(t => ({ ...t, next: t.next ?? [] }));   // a server from before `next` sends none
  const live = new Map(tasks.map(t => [t.id, t]));
  const waits = new Set(tasks.flatMap(t => t.next.filter(n => live.has(n.id)).map(n => n.id)));
  const seen = new Set<string>();
  const walk = (t: BoardTask, out: Step[]) => {
    if (seen.has(t.id)) return;
    seen.add(t.id); out.push({ kind: 'task', id: t.id, task: t });
    const kids = t.next.filter(n => live.has(n.id) && !seen.has(n.id));
    if (kids.length) for (const k of kids) walk(live.get(k.id)!, out);
    else { const n = t.next.find(n => !live.has(n.id)); if (n) out.push({ kind: 'next', id: `${t.id}>${n.id}`, title: n.title, status: n.status }); }
  };
  const out: Step[][] = [];
  // Roots first (nothing active above them); then anything a cycle left out.
  for (const t of [...tasks.filter(t => !waits.has(t.id)), ...tasks]) { const g: Step[] = []; walk(t, g); if (g.length) out.push(g); }
  return out;
}
