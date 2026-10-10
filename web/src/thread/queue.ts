// Messages typed while a turn runs, per thread. Hermes merges consecutive text-only queued prompts into ONE turn
// (tui_gateway `_enqueue_prompt`: "text-only arrivals share a slot and merge"), so handing it every message at once
// sent "a\n\nb\n\nc" as a single prompt. Gibbous keeps the line itself and gives Hermes at most one at a time: the
// head goes into Hermes' queue (so it still runs if this tab closes), the next one only once that head's turn has
// started. A stopped turn makes Hermes drop its queue (`session.interrupt`), so everything left becomes "held" until
// the user resends or discards it. Lives outside React: it keeps working while you look at another thread.
import { useSyncExternalStore } from 'react';
import type { Rpc, HermesEvent } from '../rpc';

export interface Queued {
  id: string;
  shown: string;      // what the bubble shows (the typed text, or the file names)
  message: string;    // what Hermes gets (with @file refs)
  images: boolean;    // images ride on the session, so these went to Hermes at once and can't be re-sent from here
  held?: boolean;     // Hermes no longer has it (the turn was stopped, or the page reloaded): resend or discard
  inHermes?: boolean; // handed to Hermes' queue; runs when the current turn ends
}

let n = 0;
export const queuedId = () => `q${Date.now().toString(36)}${++n}`;

// ── Pure transitions (unit-tested) ────────────────────────────────────────────────────────────────────────────────

// A turn ended. Stopped: Hermes cleared its queue, so nothing goes out and everything is held. Otherwise the message
// Hermes had queued is the turn that starts now: it leaves the line and is returned so the timeline can show it.
export function afterTurn(q: Queued[], status: string | undefined): { q: Queued[]; sent?: Queued } {
  if (status === 'interrupted') return { q: q.map(m => ({ ...m, held: true, inHermes: false })) };
  const i = q.findIndex(m => m.inHermes);
  if (i < 0) return { q };
  return { q: [...q.slice(0, i), ...q.slice(i + 1)], sent: q[i] };
}

// The next message to hand Hermes: only when it holds none of ours (one at a time, so nothing merges).
export const nextToFeed = (q: Queued[]) => q.some(m => m.inHermes) ? undefined : q.find(m => !m.held);

// Re-sync with Hermes' head (`session.resume` → `queued.user`) after (re)opening the thread. No head → whatever we
// had handed over already ran. A head we don't know (another client, or this page reloaded) is shown as Hermes'.
export function syncQueue(q: Queued[], head: string | null | undefined): Queued[] {
  const h = head?.trim();
  if (!h) return q.some(m => m.inHermes) ? q.filter(m => !m.inHermes) : q;
  if (q.some(m => m.inHermes)) return q;
  const at = q.findIndex(m => !m.held && (m.message.trim() === h || m.shown.trim() === h));
  if (at >= 0) return q.map((m, i) => i === at ? { ...m, inHermes: true } : m);
  return [{ id: queuedId(), shown: h, message: h, images: false, inHermes: true }, ...q];
}

// "Send now": this one first, unheld; everything Hermes had is gone after the interrupt, so nothing is in Hermes.
export function promote(q: Queued[], id: string): Queued[] {
  const m = q.find(x => x.id === id);
  if (!m) return q;
  return [{ ...m, held: false, inHermes: false }, ...q.filter(x => x !== m).map(x => ({ ...x, inHermes: false }))];
}

// ── Store + driver ────────────────────────────────────────────────────────────────────────────────────────────────
interface Line { q: Queued[]; rpc?: Rpc; sid?: string; off?: () => void; feeding?: boolean; feedOnStart?: boolean; timer?: ReturnType<typeof setTimeout>; keepOnStop?: boolean }
const lines = new Map<string, Line>();
const subs = new Set<() => void>();
const sentListeners = new Set<(thread: string, m: Queued) => void>();
const NONE: Queued[] = [];
const KEY = (t: string) => `gibbous.queue.${t}`;

function line(thread: string): Line {
  let l = lines.get(thread);
  if (!l) {
    // Messages that never reached Hermes survive a reload, held: we can't know whether the moment for them passed.
    let saved: Queued[] = [];
    try { saved = JSON.parse(localStorage.getItem(KEY(thread)) ?? '[]'); } catch { /* ignore */ }
    l = { q: saved.map(m => ({ ...m, held: true, inHermes: false })) };
    lines.set(thread, l);
  }
  return l;
}
function set(thread: string, q: Queued[]) {
  const l = line(thread);
  l.q = q;
  try {
    const keep = q.filter(m => !m.inHermes && !m.images);
    if (keep.length) localStorage.setItem(KEY(thread), JSON.stringify(keep)); else localStorage.removeItem(KEY(thread));
  } catch { /* storage full or blocked: the line still works in memory */ }
  if (q.length) listen(thread); else { l.off?.(); l.off = undefined; clearTimeout(l.timer); }
  subs.forEach(f => f());
}
// After the current event's own handlers: the bubble lands after the reply that just finished, not inside it.
const emitSent = (thread: string, m: Queued) => setTimeout(() => sentListeners.forEach(f => f(thread, m)));

function listen(thread: string) {
  const l = line(thread);
  if (l.off || !l.rpc || !l.sid) return;
  l.off = l.rpc.onSession(l.sid, (ev: HermesEvent) => {
    if (ev.type === 'message.start' && l.feedOnStart) { l.feedOnStart = false; clearTimeout(l.timer); feed(thread); }
    if (ev.type !== 'message.complete') return;
    const status = ev.payload?.status;
    if (status === 'interrupted' && l.keepOnStop) { l.keepOnStop = false; feed(thread); return; } // our own "send now"
    const { q, sent } = afterTurn(l.q, status);
    set(thread, q);
    if (sent) {
      emitSent(thread, sent);
      // Hermes starts `sent` now; hand over the next one once that turn is running, so it can't merge with it.
      l.feedOnStart = true; clearTimeout(l.timer);
      l.timer = setTimeout(() => { if (l.feedOnStart) { l.feedOnStart = false; feed(thread); } }, 2500);
    } else if (status !== 'interrupted') feed(thread); // nothing was with Hermes: it's idle, go
  });
}

async function feed(thread: string) {
  const l = line(thread), m = nextToFeed(l.q);
  if (!m || l.feeding || !l.rpc || !l.sid) return;
  l.feeding = true;
  try {
    const r = await l.rpc.call('prompt.submit', { session_id: l.sid, text: m.message, queued: true });
    if (r.status === 'queued') set(thread, l.q.map(x => x.id === m.id ? { ...x, inHermes: true } : x));
    else { set(thread, l.q.filter(x => x.id !== m.id)); emitSent(thread, m); } // idle: it runs right away
  } catch {
    set(thread, l.q.map(x => x.id === m.id ? { ...x, held: true } : x));
  } finally { l.feeding = false; }
}

export const getQueue = (thread: string) => lines.get(thread)?.q ?? NONE;
export function useQueue(thread: string | undefined): Queued[] {
  return useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => thread ? line(thread).q : NONE);
}
export function onQueuedSent(f: (thread: string, m: Queued) => void) { sentListeners.add(f); return () => { sentListeners.delete(f); }; }

// Bind the thread's live session. A different session than before: Hermes' queue went with the old one.
export function bindQueue(thread: string, rpc: Rpc, sid: string) {
  const l = line(thread);
  if (l.sid === sid && l.rpc === rpc) return;
  const moved = l.sid && l.sid !== sid;
  l.off?.(); l.off = undefined; l.rpc = rpc; l.sid = sid;
  set(thread, moved ? l.q.map(m => m.inHermes ? { ...m, inHermes: false, held: true } : m) : l.q);
}
export function syncWithHermes(thread: string, head: string | null | undefined) { set(thread, syncQueue(line(thread).q, head)); }

// A message typed while a turn runs. Images already went to Hermes (they attach to the session), so they enter as
// handed over; text waits its turn here.
export function enqueue(thread: string, m: Omit<Queued, 'id'>) {
  set(thread, [...line(thread).q, { ...m, id: queuedId() }]);
  if (!m.inHermes) feed(thread);
}
export const discard = (thread: string, id: string) => set(thread, line(thread).q.filter(m => m.id !== id || m.inHermes));
// Resend a held one: back in line after the waiting ones.
export function requeue(thread: string, id: string) {
  const q = line(thread).q, m = q.find(x => x.id === id);
  if (!m) return;
  const rest = q.filter(x => x !== m), at = rest.findLastIndex(x => !x.held) + 1;
  set(thread, [...rest.slice(0, at), { ...m, held: false }, ...rest.slice(at)]);
  feed(thread);
}
// "Send now": Hermes can't pull one message out of its queue, so stop the running turn (which empties that queue),
// then this one goes first and the rest follow in order. Idle: it just goes.
export async function sendNow(thread: string, id: string, running: boolean) {
  const l = line(thread);
  set(thread, promote(l.q, id));
  if (!running || !l.rpc || !l.sid) return feed(thread);
  l.keepOnStop = true;
  try { await l.rpc.call('session.interrupt', { session_id: l.sid }); } catch (e) { l.keepOnStop = false; throw e; }
}
