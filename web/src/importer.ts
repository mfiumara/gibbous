// The browser side of importSessions.ts: binds its import loop to the Gibbous API and Hermes RPC, and reports.
import { api, type Project, type Thread } from './api';
import { rpc } from './rpc';
import { useStore, toastError } from './store';
import { sourceLabel } from './ui';
import { runImport, type Candidate, type ImportResult } from './importSessions';
import type { ForeignSessionRow, SessionForeignListResult } from './hermes/contract';

// Claude Code / Codex sessions on this Mac, newest first. Hermes pages them 50 at a time (a bigger limit is refused).
export async function listForeign(source: 'claude' | 'codex', max = 200): Promise<ForeignSessionRow[]> {
  const out: ForeignSessionRow[] = [];
  for (let offset: number | null | undefined = 0; offset != null && out.length < max;) {
    const r: SessionForeignListResult = await rpc.call('session.foreign.list', { source, offset, limit: Math.min(50, max - out.length) });
    out.push(...(r.sessions ?? []));
    offset = r.sessions?.length ? r.next_offset : null;
  }
  return out;
}

// `host`: a remote machine's sessions (Hermes history's machine switch); folders/projects are this Mac only.
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

// "Keep in sidebar": Gibbous mirrors every session of that source from now on (settings.syncSources + /api/sync).
export async function toggleSync(source: string) {
  const s = useStore.getState(), synced = new Set(s.settings?.syncSources ?? []);
  const next = synced.has(source) ? [...synced].filter(x => x !== source) : [...synced, source];
  try {
    await api.patch('/api/settings', { syncSources: next });
    if (!synced.has(source)) {
      const r = await api.post<{ added: number }>('/api/sync');
      s.toast({ title: `${sourceLabel(source)} chats are in the sidebar`, body: r.added ? `Added ${r.added}. New ones appear automatically.` : 'New ones appear automatically.' });
    }
  } catch (e) { toastError(e); }
}
