// Last-seen timelines of recently opened (or hovered) threads, so switching threads paints the conversation in the
// first frame instead of a skeleton; ThreadView then refreshes from Hermes in the background. Pure, tested in cache.test.ts.
import { fromHistory, withInflight, type Timeline, type Item } from './timeline.ts';
import type { RollbackCheckpoint, SessionResumeResult } from '../hermes/contract';

export interface Cached { tl: Timeline; session?: string; checkpoints?: { enabled: boolean; list: RollbackCheckpoint[] }; at: number }

export const MAX_THREADS = 12;
export const MAX_ITEMS = 400; // ThreadView renders the last 160; the rest only feeds "Show earlier" until fresh data lands

const lru = new Map<string, Cached>(); // Map keeps insertion order: first key = least recently used
const subs = new Set<(id: string) => void>();

export function getCached(id: string): Cached | undefined {
  const c = lru.get(id);
  if (c) { lru.delete(id); lru.set(id, c); }
  return c;
}

export function putCached(id: string, e: Omit<Cached, 'at'> & { at?: number }, notify = false) {
  const items = e.tl.items.length > MAX_ITEMS ? e.tl.items.slice(-MAX_ITEMS) : e.tl.items;
  lru.delete(id);
  lru.set(id, { ...e, tl: items === e.tl.items ? e.tl : { ...e.tl, items }, at: e.at ?? Date.now() });
  while (lru.size > MAX_THREADS) lru.delete(lru.keys().next().value!);
  if (notify) for (const f of subs) f(id);
}

// The copy to paint on open. Its running state may be stale; the thread's live status (pushed by the server) decides,
// so a turn that ended while you were away doesn't show "Waxing…" until the refresh lands.
export function revive(c: Cached, running: boolean): Timeline {
  return c.tl.running && !running ? { ...c.tl, running: false, status: undefined, compacting: undefined, turnStartedAt: undefined } : c.tl;
}

export const dropCached = (id: string) => { lru.delete(id); };
export const clearCache = () => { lru.clear(); };
export const cachedIds = () => [...lru.keys()];
// Fires when a prefetch lands, so a thread opened while its prefetch was in flight can skip the skeleton.
export function onCached(f: (id: string) => void) { subs.add(f); return () => { subs.delete(f); }; }

// A session.resume result as a timeline (the shape ThreadView renders).
export type ResumeLike = Partial<Pick<SessionResumeResult, 'messages' | 'running' | 'inflight' | 'info' | 'todo_state'>>;
export function fromResume(r: ResumeLike): Timeline {
  const items: Item[] = withInflight(fromHistory(r.messages ?? [], !!r.running), r.inflight, !!r.running);
  // Attaching mid-turn: time it from its user row so the finished turn still gets a duration footer.
  const startedAt = r.running ? (items.findLast(i => i.kind === 'user') as { at?: number } | undefined)?.at ?? Date.now() : undefined;
  return { items, running: !!r.running, turnStartedAt: startedAt, info: r.info, usage: r.info?.usage ?? undefined, todos: r.todo_state?.todos };
}

// Fresh rows that match a row already on screen keep its id and object: React keeps the DOM node (no remount, no
// re-highlighting, no height change) and memoized rows skip rendering. Matching is by content, in order, because
// some ids (reasoning, turn footers) are minted anew on every fromHistory.
const sig = (i: Item) => { const { id: _, ...rest } = i; return JSON.stringify(rest); };
export function reconcile(prev: Item[], next: Item[]): Item[] {
  if (!prev.length) return next;
  const bySig = new Map<string, number[]>();
  prev.forEach((p, i) => { const s = sig(p); const l = bySig.get(s); if (l) l.push(i); else bySig.set(s, [i]); });
  const nextIds = new Set(next.map(i => i.id));
  let after = -1;
  const out = next.map(n => {
    const l = bySig.get(sig(n));
    while (l?.length && l[0] <= after) l.shift();
    const i = l?.[0];
    if (i == null) return n;
    const p = prev[i];
    // Never borrow an id another fresh row owns, or React would see two rows with one key.
    if (p.id !== n.id && nextIds.has(p.id)) return n;
    l!.shift(); after = i;
    return p;
  });
  return new Set(out.map(i => i.id)).size === out.length ? out : next;
}
