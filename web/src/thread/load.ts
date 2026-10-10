// Loading a thread's conversation: the newest page of stored history (server/history.ts, Hermes' REST transcript)
// plus `session.resume {omit_messages}` for the live state (running turn, in-flight reply, todos, usage). This is how
// Hermes' own desktop hydrates; a full resume projects the whole lineage on every open (10-20s for long threads).
import { api } from '../api';
import type { Rpc } from '../rpc';
import type { SessionResumeResult, TranscriptMessage } from '../hermes/contract';
import { fromHistory, type Item, type Timeline } from './timeline.ts';
import { fromResume, type Paging } from './cache.ts';

export interface HistoryPage { messages: TranscriptMessage[]; next: number; more: boolean; first?: number }
export const FIRST_PAGE = 200;  // stored rows; ThreadView renders the last 160 items
export const OLDER_PAGE = 300;

// Start this before attaching: it doesn't need the live session. null = no history route (older server) or it failed.
export const firstPage = (threadId: string) => api.get<HistoryPage>(`/api/threads/${threadId}/history?limit=${FIRST_PAGE}`).catch(() => null);

export async function resumeWith(rpc: Rpc, t: { sessionId: string; profile?: string }, hist: Promise<HistoryPage | null>): Promise<{ r: SessionResumeResult; tl: Timeline; page: Paging }> {
  const base = { session_id: t.sessionId, ...(t.profile ? { profile: t.profile } : {}) };
  const [r, h] = await Promise.all([rpc.call('session.resume', { ...base, omit_messages: true }), hist]);
  if (!h) {
    const full = await rpc.call('session.resume', base); // the old way: everything at once
    return { r: full, tl: fromResume(full), page: { next: 0, more: false } };
  }
  return { r, tl: fromResume({ ...r, messages: h.messages }), page: { next: h.next, more: h.more, first: h.first } };
}

// The page(s) before what's loaded. `seam`: the loaded timeline starts mid-turn (no turn footer at the seam then).
export async function olderPages(threadId: string, page: Paging, all = false, seam = false): Promise<{ items: Item[]; page: Paging }> {
  let p = page, messages: TranscriptMessage[] = [];
  while (p.more) {
    const h = await api.get<HistoryPage>(`/api/threads/${threadId}/history?offset=${p.next}&limit=${OLDER_PAGE}${p.first != null ? `&before=${p.first}` : ''}`);
    messages = [...h.messages, ...messages];
    p = { next: h.next, more: h.more && h.next > p.next, first: h.first ?? p.first };
    if (!all) break;
  }
  return { items: fromHistory(messages, seam), page: p };
}
