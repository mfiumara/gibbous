// Maintenance: orphaned worktrees, backup/restore and the diagnostics bundle.
import { useEffect, useState } from 'react';
import { Wrench, Download, Upload, ClipboardCopy, History } from 'lucide-react';
import { api } from '../api';
import { useStore, toastError } from '../store';
import { Button } from '../ui';
import { Section } from './common';
import { viewportReport } from '../viewport';

function Data() {
  const [diag, setDiag] = useState<string>();
  useEffect(() => { api.get<{ text: string }>('/api/diagnostics').then(r => setDiag(`${r.text}\n\nThis device: ${JSON.stringify({ ...viewportReport(), ua: navigator.userAgent }, null, 2)}`), () => {}); }, []);
  const bytes = diag ? Number(/"stateBytes": (\d+)/.exec(diag)?.[1] ?? 0) : 0;
  const restoreFrom = async (f?: File) => {
    if (!f || !confirm(`Replace all projects, threads and settings with ${f.name}? The current state is kept as a .before-restore file next to state.json.`)) return;
    try { await api.post('/api/restore', JSON.parse(await f.text())); useStore.getState().toast({ title: 'Backup restored' }); }
    catch (e) { toastError(e); }
  };
  const copy = () => diag && navigator.clipboard.writeText(diag).then(() => useStore.getState().toast({ title: 'Debug bundle copied' }), toastError);
  return <>
    <Section title="Import sessions" description="Bring sessions from the agent CLI, Paseo, messaging apps, Claude Code and Codex in as threads, grouped by tool and project folder."
      aside={<a href="#/import" className="press inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-line text-[13px] hover:bg-ridge"><History size={13} />Import sessions…</a>} />
    <Section title="Backup" description={`Projects, threads and settings in one file. Conversations themselves live in Hermes.${bytes ? ` Current state: ${(bytes / 1024).toFixed(0)} KB.` : ''}`}
      aside={<div className="flex gap-2">
        <a href="/api/backup" download={`gibbous-backup-${new Date().toLocaleDateString('en-CA')}.json`} className="press inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-line text-[13px] hover:bg-ridge"><Download size={13} />Download backup</a>
        <label className="press inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-line text-[13px] hover:bg-ridge has-[:focus-visible]:outline-2"><Upload size={13} />Restore…
          <input type="file" accept="application/json,.json" className="sr-only" onChange={e => { restoreFrom(e.target.files?.[0]); e.target.value = ''; }} /></label>
      </div>} />
    <Section title="Diagnostics" description="Tokens and keys are removed. Attach it to bug reports."
      aside={<Button onClick={copy} disabled={!diag}><ClipboardCopy size={13} />Copy debug bundle</Button>}>
      {diag && <pre className="max-h-72 overflow-auto rounded-xl bg-well border border-line p-3 font-mono text-[11.5px] text-dust whitespace-pre-wrap">{diag}</pre>}
    </Section>
  </>;
}

export function MaintenanceTab() {
  const [m, setM] = useState<{ orphans: string[] }>();
  const load = () => api.get<NonNullable<typeof m>>('/api/maintenance').then(setM, toastError);
  useEffect(() => { load(); }, []);
  if (!m) return null;
  return <>
    <Section title="Orphaned worktrees" description="Removing deletes the folder and any uncommitted changes.">
      {!m.orphans.length ? <p className="text-sm text-sprout">No orphaned worktrees.</p> : <ul className="divide-y divide-line">{m.orphans.map(p => (
        <li key={p} className="flex items-center gap-3 py-2"><Wrench size={13} className="text-ash" /><span className="flex-1 font-mono text-[12px] truncate">{p}</span>
          <Button size="sm" tone="danger" onClick={() => confirm(`Delete ${p}?`) && api.post<typeof m>('/api/maintenance/remove', { path: p }).then(setM, toastError)}>Remove</Button></li>
      ))}</ul>}
    </Section>
    <Data />
  </>;
}
