// The browser side of importSessions.ts: binds its import loop to the Gibbous API and Hermes RPC, and reports.
import { useSyncExternalStore } from 'react';
import { api, type Project, type Thread } from './api';
import { rpc } from './rpc';
import { useStore, toastError } from './store';
import { runImport, type Candidate, type ImportResult } from './importSessions';
import type { ForeignSessionRow, SessionForeignListResult } from './hermes/contract';

// Claude Code / Codex lists, shared by Sessions and the import picker and kept for the tab's life: Hermes parses every
// log on each page (~0.5s per 50; it refuses more than 50 per page),
// so they load progressively, a few pages at a time, and "Load older" adds more.
export interface ForeignList { rows: ForeignSessionRow[]; next: number | null; loading: boolean; error?: string }
const lists: Record<'claude' | 'codex', ForeignList> = { claude: { rows: [], next: 0, loading: false }, codex: { rows: [], next: 0, loading: false } };
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
export async function loadForeign(source: 'claude' | 'codex', pages = 4) {
  const l = lists[source];
  if (l.loading || l.next == null) return;
  lists[source] = { ...l, loading: true }; emit();
  try {
    for (let i = 0; i < pages && lists[source].next != null; i++) {
      const cur = lists[source], r: SessionForeignListResult = await rpc.call('session.foreign.list', { source, offset: cur.next, limit: 50 });
      const seen = new Set(cur.rows.map(x => x.id));
      lists[source] = { ...cur, rows: [...cur.rows, ...(r.sessions ?? []).filter(x => !seen.has(x.id))], next: r.next_offset ?? null };
      emit();
    }
    lists[source] = { ...lists[source], loading: false };
  } catch (e) { lists[source] = { ...lists[source], loading: false, error: (e as Error)?.message ?? String(e) }; }
  emit();
}
// Started lists only: `start` kicks off the first pages once.
export function useForeign(source: 'claude' | 'codex', start = true): ForeignList {
  const l = useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => lists[source]);
  if (start && !l.rows.length && l.next === 0 && !l.loading && !l.error) queueMicrotask(() => loadForeign(source, source === 'codex' ? 6 : 4)); // most Codex logs are helper runs, left out
  return l;
}

// `host`: a remote machine's sessions (the Sessions machine switch); folders/projects are this Mac only.
export function importCandidates(items: Candidate[], projectFolders: Set<string>, onProgress: (done: number, total: number) => void, host?: string): Promise<ImportResult> {
  const imported = new Set(useStore.getState().threads.filter(t => (t.host ?? '') === (host ?? '')).map(t => t.sessionId));
  return runImport(items, host ? new Set() : projectFolders, {
    imported,
    // Reuse a project already on that folder (the server dedupes by real path too).
    projectFor: async path => (useStore.getState().projects.find(p => p.path === path) ?? await api.post<Project>('/api/projects', { path })).id,
    importForeign: async c => (await rpc.call('session.foreign.import', { id: c.id })).session_id,
    addThread: b => api.post<Thread>('/api/import', { ...b, host }),
    onProgress,
  });
}

export function reportImport(r: ImportResult) {
  const { toast } = useStore.getState(), n = r.threads.length;
  if (n || r.skipped) toast({ title: n ? `Imported ${n} session${n === 1 ? '' : 's'}` : 'Nothing new to import', body: r.skipped ? `${r.skipped} ${r.skipped === 1 ? 'was' : 'were'} already in Gibbous.` : undefined });
  if (r.failed.length) toast({ tone: 'error', title: `${r.failed.length} session${r.failed.length === 1 ? '' : 's'} couldn't be imported`,
    body: r.failed.slice(0, 3).map(f => `${f.c.title.slice(0, 50)}: ${f.error}`).join(' · ') + (r.failed.length > 3 ? ` · and ${r.failed.length - 3} more` : '') });
}

// Turn mirroring on/off for several sources at once (a tool can span more than one, e.g. cli + tui).
export async function setSync(sources: string[], on: boolean, label: string) {
  const s = useStore.getState(), synced = new Set(s.settings?.syncSources ?? []);
  for (const x of sources) on ? synced.add(x) : synced.delete(x);
  try {
    await api.patch('/api/settings', { syncSources: [...synced] });
    if (on) {
      const r = await api.post<{ added: number }>('/api/sync');
      s.toast({ title: `${label} sessions are in the sidebar`, body: r.added ? `Added ${r.added}. New ones appear automatically.` : 'New ones appear automatically.',
        action: r.added ? { label: 'Undo', run: () => { setSync(sources, false, label).then(() => removeSynced(sources)); } } : undefined });
    } else {
      // Switching off stops new ones; the ones already in the sidebar go too (they're read-only copies of sessions that
      // stay under Sessions). Threads you have moved into a project are kept.
      const n = await removeSynced(sources);
      s.toast({ title: `${label} sessions stopped syncing`, body: n ? `Removed ${n} from the sidebar. They're still under Sessions.` : undefined });
    }
  } catch (e) { toastError(e); }
}

// Read-only threads mirrored from these sources, not filed into a project: remove them from the sidebar.
export async function removeSynced(sources: string[]) {
  const want = new Set(sources);
  const gone = useStore.getState().threads.filter(t => t.readOnly && t.source && want.has(t.source) && !t.projectId);
  for (const t of gone) await api.del(`/api/threads/${t.id}`).catch(() => {});
  return gone.length;
}
