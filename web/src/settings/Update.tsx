// Updating Hermes from Gibbous: check, show what's new, apply, follow the log. The backend restarts itself;
// Gibbous reconnects on its own (threads reattach, running turns resume or are reported).
import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, RefreshCw, CheckCircle2, GitCommit, XCircle } from 'lucide-react';
import { api, hermes } from '../api';
import { useStore, toastError } from '../store';
import { Button, Skeleton, MoonLoader, ago } from '../ui';
import { Section } from './common';

interface Check { install_method: string; current_version: string; behind: number | null; update_available: boolean; can_apply: boolean; update_command?: string; message?: string; commits?: { sha: string; summary: string; author: string; at: number }[] }
interface Smoke { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] }
interface Status { running: boolean; exit_code?: number | null; lines?: string[]; receipt?: { outcome?: string } }

export function UpdateTab() {
  const [check, setCheck] = useState<Check>();
  const [status, setStatus] = useState<Status | null>(null);
  const [compat, setCompat] = useState<Smoke | 'checking'>();
  const runSmoke = () => { setCompat('checking'); api.get<Smoke>('/api/smoke').then(setCompat, e => { toastError(e); setCompat(undefined); }); };
  const log = useRef<HTMLPreElement>(null);
  const load = (force = false) => { setCheck(undefined); hermes.get<Check>(`hermes/update/check${force ? '?force=true' : ''}`).then(setCheck, toastError); };
  useEffect(() => { load(); }, []);
  useEffect(() => { log.current?.scrollTo(0, log.current.scrollHeight); }, [status?.lines?.length]);

  const apply = async () => {
    if (!confirm('Update Hermes now? Running turns may be interrupted while the backend restarts.')) return;
    try {
      const r = await hermes.post<{ ok: boolean; message?: string }>('hermes/update');
      if (!r.ok) throw new Error(r.message ?? 'Hermes refused the update');
      // Poll the action log; the request can fail mid-way while serve restarts, so keep retrying.
      for (let i = 0; i < 600; i++) {
        await new Promise(res => setTimeout(res, 1500));
        const s = await hermes.get<Status>('actions/hermes-update/status?lines=200').catch(() => null);
        if (s) setStatus(s);
        if (s && !s.running) break;
      }
      useStore.getState().toast({ title: 'Hermes update finished' });
      load(true); runSmoke();
    } catch (e) { toastError(e); }
  };

  if (!check) return <Skeleton className="h-48 rounded-2xl" />;
  return <>
    <Section title="Hermes" description={`Installed as ${check.install_method}. ${check.message ?? ''}`}
      aside={<Button onClick={() => load(true)}><RefreshCw size={13} />Check now</Button>}>
      <div className="flex items-center gap-4">
        {check.update_available ? <ArrowUpCircle size={28} className="text-tide" /> : <CheckCircle2 size={28} className="text-sprout" />}
        <div className="flex-1">
          <p className="font-bold">{check.update_available ? `Update available${check.behind && check.behind > 0 ? ` · ${check.behind} commits behind` : ''}` : 'Hermes is up to date'}</p>
          <p className="text-[13px] text-dust font-mono">version {check.current_version}</p>
        </div>
        {check.update_available && (check.can_apply
          ? <Button tone="primary" onClick={apply} disabled={!!status?.running}>Update Hermes</Button>
          : <code className="font-mono text-[12px] bg-well border border-line rounded-md px-2 py-1">{check.update_command}</code>)}
      </div>
      {!!check.commits?.length && <div className="space-y-1.5">
        <p className="label">What's new</p>
        <ul className="max-h-72 overflow-y-auto divide-y divide-line">{check.commits.map(c => (
          <li key={c.sha} className="py-1.5 flex gap-2.5 text-[13px]"><GitCommit size={13} className="text-ash mt-0.5 flex-none" /><span className="flex-1">{c.summary}</span><span className="text-[11px] text-ash whitespace-nowrap">{c.author} · {ago(c.at * 1000)}</span></li>
        ))}</ul>
      </div>}
    </Section>
    <Section title="Compatibility" description="Runs after every update."
      aside={<Button onClick={runSmoke} disabled={compat === 'checking'}>{compat === 'checking' ? <MoonLoader size={14} label="Checking" /> : <RefreshCw size={13} />}Check compatibility</Button>}>
      {compat && compat !== 'checking' && <ul className="divide-y divide-line">{compat.checks.map(c => (
        <li key={c.name} className="py-2 flex items-start gap-2.5 text-[13px]">
          {c.ok ? <CheckCircle2 size={14} className="text-sprout mt-0.5 flex-none" /> : <XCircle size={14} className="text-oxide mt-0.5 flex-none" />}
          <span className="flex-1"><span className="font-mono">{c.name}</span>{c.detail && <span className="block text-dust break-words">{c.detail}</span>}</span>
        </li>
      ))}</ul>}
    </Section>
    {status && <Section title={status.running ? 'Updating…' : status.exit_code ? 'Update failed' : 'Update log'}>
      <pre ref={log} className="max-h-80 overflow-auto rounded-xl bg-well border border-line p-3 font-mono text-[11.5px] text-dust whitespace-pre-wrap">{(status.lines ?? []).join('\n')}</pre>
    </Section>}
  </>;
}
