// Warm the timeline cache for a thread the pointer is about to open (sidebar hover / touch).
import { api } from '../api';
import { rpcFor } from '../rpc';
import { useStore } from '../store';
import { getCached, putCached, fromResume } from './cache';

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
    await api.post(`/api/threads/${threadId}/attach`);
    const r = await rpcFor(t.host).call('session.resume', { session_id: t.sessionId, ...(t.profile ? { profile: t.profile } : {}) });
    if ((getCached(threadId)?.at ?? 0) > started) return; // opened meanwhile and ThreadView already has newer data
    putCached(threadId, { tl: fromResume(r), session: t.sessionId, checkpoints: c?.session === t.sessionId ? c.checkpoints : undefined }, true);
  } catch { /* best effort: opening the thread loads it the normal way */ }
  finally { inflight.delete(threadId); }
}
