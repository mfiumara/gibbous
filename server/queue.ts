// Prompts typed while a turn runs, per thread, held by the Gibbous server so they stay editable and keep going out
// with every tab closed. Hermes can't do this itself: it merges consecutive text-only queued prompts into ONE turn
// (tui_gateway `_enqueue_prompt`), shows only the head, and has no RPC to edit or remove a queued prompt. So nothing
// waits in Hermes: the orchestrator hands over the head only when a turn ends (Hermes is idle then). Pure, tested.
export interface QueueItem { id: string; text: string; shown: string; at: number }

export const MAX_QUEUE = 50;
export const MAX_TEXT = 100_000;

export function add(q: QueueItem[] = [], item: QueueItem): QueueItem[] {
  if (q.length >= MAX_QUEUE) throw new Error(`the queue holds at most ${MAX_QUEUE} messages`);
  return [...q, item];
}
export const edit = (q: QueueItem[] = [], id: string, text: string, shown?: string) => q.map(m => m.id === id ? { ...m, text, shown: shown ?? text } : m);
export const remove = (q: QueueItem[] = [], id: string) => q.filter(m => m.id !== id);
export function toFront(q: QueueItem[] = [], id: string): QueueItem[] {
  const m = q.find(x => x.id === id);
  return m ? [m, ...q.filter(x => x !== m)] : q;
}
// The given ids first, in that order; anything not listed keeps its place after them (a stale client never loses one).
export function reorder(q: QueueItem[] = [], ids: string[]): QueueItem[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return q.map((m, i) => [m, rank.get(m.id) ?? ids.length + i] as const).sort((a, b) => a[1] - b[1]).map(([m]) => m);
}

// What a turn's end means for the queue. A Stop (interrupted) pauses it, unless the interrupt was our own "send now",
// which wants the head out right away. A finished or failed turn sends the head, unless the queue is paused or empty.
export function onTurnEnd(o: { queue?: QueueItem[]; paused?: boolean; sendNow?: boolean }, status: string | undefined): 'send' | 'pause' | 'none' {
  const has = !!o.queue?.length;
  if (status === 'interrupted') return o.sendNow ? (has ? 'send' : 'none') : (has && !o.paused ? 'pause' : 'none');
  return has && !o.paused ? 'send' : 'none';
}
