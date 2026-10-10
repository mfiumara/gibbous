import { useEffect, useState } from 'react';
import { Pause, Play, Plus, Trash2, Zap, History, Pencil } from 'lucide-react';
import { hermes } from '../api';
import { useStore, toastError } from '../store';
import { Button, IconButton, Modal, Field, Skeleton, inputCls, ago } from '../ui';
import { Section } from './common';
import { TranscriptModal } from '../thread/TranscriptModal';

// Shape of Hermes' REST /api/cron/jobs rows (differs from the RPC Job).
export interface Job { last_run_at?: string | null; last_delivery_error?: string | null; id: string; name?: string; prompt?: string; schedule?: { display?: string; expr?: string } | string; schedule_display?: string; deliver?: string; enabled?: boolean; paused_at?: string | null; next_run_at?: string | null; last_status?: string | null; last_error?: string | null; skills?: string[] }
export const sched = (j: Job) => j.schedule_display ?? (typeof j.schedule === 'string' ? j.schedule : j.schedule?.display ?? j.schedule?.expr ?? '');

interface Run { id: string; title?: string; preview?: string; started_at?: number; source?: string; message_count?: number; is_active?: boolean }
export interface Target { id: string; name: string; home_target_set?: boolean }
export type Draft = { id?: string; name: string; schedule: string; prompt: string; deliver: string; skills: string };

export function JobEditor({ draft, onClose, onDone }: { draft: Draft; onClose(): void; onDone(): void }) {
  const [d, setD] = useState(draft);
  const [targets, setTargets] = useState<Target[]>([]);
  useEffect(() => { hermes.get<{ targets: Target[] }>('cron/delivery-targets').then(r => setTargets(r.targets ?? []), () => {}); }, []);
  const save = async () => {
    const body = { name: d.name, schedule: d.schedule, prompt: d.prompt, deliver: d.deliver, skills: d.skills.split(',').map(s => s.trim()).filter(Boolean) };
    try { d.id ? await hermes.put(`cron/jobs/${d.id}`, { updates: body }) : await hermes.post('cron/jobs', body); onDone(); onClose(); }
    catch (e) { toastError(e); }
  };
  const deliverSet = new Set(d.deliver.split(',').filter(Boolean));
  const toggleTarget = (id: string) => { const n = new Set(deliverSet); n.has(id) ? n.delete(id) : n.add(id); setD({ ...d, deliver: [...n].join(',') || 'local' }); };
  return (
    <Modal open onClose={onClose} title={d.id ? `Edit ${d.name}` : 'New scheduled job'} wide>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Name"><input className={inputCls} value={d.name} onChange={e => setD({ ...d, name: e.target.value })} placeholder="Morning inbox summary" autoFocus /></Field>
        <Field label="When" hint={'"every weekday 9am", "every 2h", "in 30m", or cron "0 9 * * 1-5"'}><input className={inputCls + ' font-mono'} value={d.schedule} onChange={e => setD({ ...d, schedule: e.target.value })} /></Field>
      </div>
      <Field label="What the agent should do"><textarea className={inputCls + ' min-h-28'} value={d.prompt} onChange={e => setD({ ...d, prompt: e.target.value })} placeholder="Summarise unread email from the last 24h and list anything that needs a reply." /></Field>
      <Field label="Deliver to" hint="Local keeps it under Sessions.">
        <div className="flex flex-wrap gap-1.5">
          {[{ id: 'local', name: 'Local only' }, { id: 'origin', name: 'Where it was created' }, ...targets].map(t => (
            <button key={t.id} onClick={() => toggleTarget(t.id)} aria-pressed={deliverSet.has(t.id)} className={`press h-7 px-2.5 rounded-md border text-[12.5px] ${deliverSet.has(t.id) ? 'border-tide/60 bg-tide/10 text-moon' : 'border-line text-dust'}`}>{t.name}</button>
          ))}
        </div>
      </Field>
      <Field label="Skills (optional)" hint="Comma-separated."><input className={inputCls + ' font-mono'} value={d.skills} onChange={e => setD({ ...d, skills: e.target.value })} /></Field>
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!d.schedule || !d.prompt} onClick={save}>{d.id ? 'Save job' : 'Create job'}</Button></div>
    </Modal>
  );
}

export function Runs({ job, onClose }: { job: Job; onClose(): void }) {
  const [runs, setRuns] = useState<Run[]>();
  const [open, setOpen] = useState<Run | null>(null);
  useEffect(() => { hermes.get<{ runs: Run[] }>(`cron/jobs/${job.id}/runs?limit=30`).then(r => setRuns(r.runs), toastError); }, [job.id]);
  return <>
    <Modal open={!open} onClose={onClose} title={`Runs · ${job.name ?? job.id}`} wide>
      {!runs ? <Skeleton className="h-32" /> : !runs.length ? <p className="text-sm text-dust">No runs yet.</p> : <ul className="divide-y divide-line max-h-[60vh] overflow-y-auto">{runs.map(r => (
        <li key={r.id}><button disabled={r.source === 'cron_output'} onClick={() => setOpen(r)} className="press w-full text-left py-2.5 flex gap-3 rounded-md hover:bg-ridge/40 px-1 disabled:cursor-default">
          <span className={`mt-1.5 size-1.5 rounded-full flex-none ${r.is_active ? 'bg-tide animate-pulse' : /fail|error/i.test(r.title ?? '') ? 'bg-oxide' : 'bg-sprout'}`} />
          <span className="flex-1 min-w-0"><span className="block text-sm truncate">{r.title ?? r.id}</span><span className="block text-[12px] text-dust truncate">{r.preview}</span></span>
          <span className="text-xs text-ash">{r.started_at ? ago(r.started_at * 1000) : ''}</span>
        </button></li>
      ))}</ul>}
    </Modal>
    <TranscriptModal sessionId={open?.id ?? null} title={open?.title ?? 'Run'} onClose={() => setOpen(null)} />
  </>;
}

export function JobsTab() {
  const toast = useStore(s => s.toast);
  const [jobs, setJobs] = useState<Job[]>();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [runs, setRuns] = useState<Job | null>(null);
  const load = () => hermes.get<Job[] | { jobs: Job[] }>('cron/jobs').then(r => setJobs(Array.isArray(r) ? r : r.jobs ?? []), toastError);
  useEffect(() => { load(); }, []);
  // The list only carries a preview of the prompt: load the full job before editing so nothing gets truncated.
  const edit = (j: Job) => hermes.get<Job>(`cron/jobs/${j.id}`).then(full => setEditing({ id: j.id, name: full.name ?? '', schedule: sched(full), prompt: full.prompt ?? '', deliver: full.deliver ?? 'local', skills: (full.skills ?? []).join(', ') }), toastError);
  const act = (j: Job, a: 'pause' | 'resume' | 'trigger') => hermes.post(`cron/jobs/${j.id}/${a}`).then(() => { if (a === 'trigger') toast({ title: `Running ${j.name ?? j.id} now` }); load(); }, toastError);
  return <>
    <Section title="Scheduled jobs" description={<a href="#/automations" className="text-tide hover:underline">All automations →</a>}
      aside={<Button tone="primary" onClick={() => setEditing({ name: '', schedule: 'every weekday 9am', prompt: '', deliver: 'local', skills: '' })}><Plus size={14} />New job</Button>}>
      {!jobs ? <Skeleton className="h-32" /> : !jobs.length ? <p className="text-sm text-dust">No scheduled jobs yet.</p> : <ul className="divide-y divide-line">{jobs.map(j => {
        const paused = j.enabled === false || !!j.paused_at;
        return (
          <li key={j.id} className="py-3 flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
            <span className={`mt-1.5 size-2 rounded-full flex-none ${paused ? 'bg-ash' : j.last_status && /fail|error/i.test(j.last_status) ? 'bg-oxide' : 'bg-sprout'}`} />
            <div className="flex-1 min-w-[min(14rem,80%)]">
              <p className="font-bold truncate">{j.name ?? j.id}</p>
              <p className="text-[12.5px] text-dust truncate">{j.prompt}</p>
              <p className="text-[11.5px] text-ash font-mono">{sched(j)} · {paused ? 'paused' : j.next_run_at ? `next ${new Date(j.next_run_at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '—'}{j.last_status ? ` · last ${j.last_status}` : ''}{j.deliver ? ` · → ${j.deliver}` : ''}</p>
              {j.last_error && <p className="text-[12px] text-oxide truncate">{j.last_error}</p>}
            </div>
            <div className="flex items-center ml-auto -mr-1">
            <IconButton label="Run now" onClick={() => act(j, 'trigger')}><Zap size={14} /></IconButton>
            <IconButton label="Run history" onClick={() => setRuns(j)}><History size={14} /></IconButton>
            <IconButton label="Edit" onClick={() => edit(j)}><Pencil size={14} /></IconButton>
            <IconButton label={paused ? 'Resume' : 'Pause'} onClick={() => act(j, paused ? 'resume' : 'pause')}>{paused ? <Play size={14} /> : <Pause size={14} />}</IconButton>
            <IconButton label="Delete" onClick={() => confirm(`Delete ${j.name ?? j.id}?`) && hermes.del(`cron/jobs/${j.id}`).then(load, toastError)}><Trash2 size={14} /></IconButton>
            </div>
          </li>
        );
      })}</ul>}
    </Section>
    {editing && <JobEditor draft={editing} onClose={() => setEditing(null)} onDone={load} />}
    {runs && <Runs job={runs} onClose={() => setRuns(null)} />}
  </>;
}
