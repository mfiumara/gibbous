// Warm the timeline cache for a thread the pointer is about to open (sidebar hover / touch).
import { api } from '../api';
import { rpcFor } from '../rpc';
import { useStore } from '../store';
import { getCached, putCached } from './cache';
import { firstPage, resumeWith } from './load';

const FRESH_MS = 15_000; // a recent copy is good enough: opening the thread refreshes it anyway
const inflight = new Set<string>();

export async function prefetch(threadId: string) {
  const t = useStore.getState().threads.find(x => x.id === threadId);
  // Read-only (external) threads render through ExternalThread; the open one keeps its own cache entry current.
  if (!t || t.readOnly || t.status === 'archived' || inflight.has(threadId) || location.hash === `#/t/${threadId}`) return;
  const c = getCached(threadId);
  if (c && Date.now() - c.at < FRESH_MS) return;
  inflight.add(threadId);
  const started = Date.now();
  try {
    // Same order as ThreadView: Gibbous's server attaches first so it owns the live session (approvals stay
    // answerable); our resume then joins that live session instead of starting a second one.
    const hist = firstPage(threadId);
    await api.post(`/api/threads/${threadId}/attach`);
    const { tl, page } = await resumeWith(rpcFor(t.host), t, hist);
    if ((getCached(threadId)?.at ?? 0) > started) return; // opened meanwhile and ThreadView already has newer data
    putCached(threadId, { tl, page, session: t.sessionId, checkpoints: c?.session === t.sessionId ? c.checkpoints : undefined }, true);
  } catch { /* best effort: opening the thread loads it the normal way */ }
  finally { inflight.delete(threadId); }
}
