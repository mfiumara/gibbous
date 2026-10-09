// Everything that runs on its own, in one place: Hermes scheduled jobs and Gibbous board schedules.
// What's next, what's failing, and the controls to run, pause or edit each one.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Pause, Play, Zap, History, Pencil, KanbanSquare, Bot, AlertTriangle, CalendarClock } from 'lucide-react';
import { api, hermes, type Schedule } from './api';
import { useStore, toastError, NONE } from './store';
import { Button, IconButton, MoonLoader, ago } from './ui';
import { PageHeader } from './Inbox';
import { JobEditor, Runs, sched, type Job, type Draft, type Target } from './settings/Jobs';
import { nextRun, describeCron } from '../../server/cron.ts';

interface Row {
  key: string; kind: 'hermes' | 'board'; name: string; when: string; next?: number; last?: number;
  status: 'ok' | 'failed' | 'paused' | 'never'; error?: string; target: string; job?: Job; schedule?: Schedule;
}

const at = (ms?: number) => ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const until = (ms: number) => { const m = Math.round((ms - Date.now()) / 60_000); return m < 1 ? 'now' : m < 60 ? `in ${m}m` : m < 24 * 60 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`; };

export function AutomationsView() {
  const toast = useStore(s => s.toast);
  const schedules = useStore(s => s.schedules ?? NONE);
  const projects = useStore(s => s.projects);
  const [jobs, setJobs] = useState<Job[]>();
  const [targets, setTargets] = useState<Target[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [runs, setRuns] = useState<Job | null>(null);
  const load = () => hermes.get<Job[] | { jobs: Job[] }>('cron/jobs').then(r => setJobs(Array.isArray(r) ? r : r.jobs ?? []), e => { toastError(e); setJobs([]); });
  useEffect(() => { load(); hermes.get<{ targets: Target[] }>('cron/delivery-targets').then(r => setTargets(r.targets ?? []), () => {}); }, []);
  // Next-run times drift into the past while the page is open; re-read them every minute.
  const [, tick] = useState(0);
  useEffect(() => { const h = setInterval(() => { tick(x => x + 1); load(); }, 60_000); return () => clearInterval(h); }, []);

  const target = (deliver?: string) => !deliver || deliver === 'local' ? 'Hermes history' : deliver === 'origin' ? 'the chat it came from'
    : deliver.split(',').map(d => targets.find(t => t.id === d)?.name ?? d.split(':')[0].replace(/^./, c => c.toUpperCase())).join(', ');

  const rows = useMemo<Row[]>(() => [
    ...(jobs ?? []).map(j => {
      const paused = j.enabled === false || !!j.paused_at;
      const failed = !!j.last_error || !!j.last_delivery_error || /fail|error/i.test(j.last_status ?? '');
      return {
        key: `h:${j.id}`, kind: 'hermes' as const, name: j.name ?? j.id, when: describeCron(sched(j)), job: j,
        next: !paused && j.next_run_at ? Date.parse(j.next_run_at) : undefined, last: j.last_run_at ? Date.parse(j.last_run_at) : undefined,
        status: paused ? 'paused' as const : failed ? 'failed' as const : j.last_run_at ? 'ok' as const : 'never' as const,
        error: j.last_error ?? j.last_delivery_error ?? undefined, target: target(j.deliver),
      };
    }),
    ...schedules.map(s => {
      let next: number | undefined;
      try { next = s.enabled ? nextRun(s.cron) ?? undefined : undefined; } catch { /* bad expression: shown as-is */ }
      return {
        key: `b:${s.id}`, kind: 'board' as const, name: s.title, when: describeCron(s.cron), schedule: s, next, last: s.lastRun,
        status: !s.enabled ? 'paused' as const : s.lastRun ? 'ok' as const : 'never' as const,
        target: `${projects.find(p => p.id === s.projectId)?.name ?? 'project'} board`,
      };
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [jobs, schedules, projects, targets]);

  const soon = rows.filter(r => r.next && r.next - Date.now() < 24 * 3600_000).sort((a, b) => a.next! - b.next!);
  const failing = rows.filter(r => r.status === 'failed');
  const recent = rows.filter(r => r.last).sort((a, b) => b.last! - a.last!).slice(0, 8);

  const act = (j: Job, a: 'pause' | 'resume' | 'trigger') => hermes.post(`cron/jobs/${j.id}/${a}`).then(() => { toast({ title: a === 'trigger' ? `Running ${j.name ?? j.id} now` : a === 'pause' ? `Paused ${j.name ?? j.id}` : `Resumed ${j.name ?? j.id}` }); load(); }, toastError);
  const toggleBoard = (s: Schedule) => api.patch(`/api/schedules/${s.id}`, { enabled: !s.enabled }).catch(toastError);
  const edit = (j: Job) => hermes.get<Job>(`cron/jobs/${j.id}`).then(full => setEditing({ id: j.id, name: full.name ?? '', schedule: sched(full), prompt: full.prompt ?? '', deliver: full.deliver ?? 'local', skills: (full.skills ?? []).join(', ') }), toastError);

  const Kind = ({ r }: { r: Row }) => r.kind === 'hermes'
    ? <span className="label inline-flex items-center gap-1 text-ash" data-tip="Hermes scheduled job"><Bot size={11} />hermes</span>
    : <span className="label inline-flex items-center gap-1 text-ash" data-tip="Gibbous board schedule: creates a task"><KanbanSquare size={11} />board</span>;
  const dot = (r: Row) => ({ ok: 'bg-sprout', failed: 'bg-oxide', paused: 'bg-ash', never: 'bg-tide/60' })[r.status];

  const actions = (r: Row) => r.job ? <>
    <IconButton label="Run now" onClick={() => act(r.job!, 'trigger')}><Zap size={14} /></IconButton>
    <IconButton label="Run history" onClick={() => setRuns(r.job!)}><History size={14} /></IconButton>
    <IconButton label="Edit" onClick={() => edit(r.job!)}><Pencil size={14} /></IconButton>
    <IconButton label={r.status === 'paused' ? 'Resume' : 'Pause'} onClick={() => act(r.job!, r.status === 'paused' ? 'resume' : 'pause')}>{r.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}</IconButton>
  </> : <>
    <IconButton label="Open board" onClick={() => { location.hash = `/board/${r.schedule!.projectId}`; }}><KanbanSquare size={14} /></IconButton>
    <IconButton label={r.status === 'paused' ? 'Resume' : 'Pause'} onClick={() => toggleBoard(r.schedule!)}>{r.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}</IconButton>
  </>;

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Automations">
        <span className="ml-auto"><Button size="sm" tone="primary" onClick={() => setEditing({ name: '', schedule: 'every weekday 9am', prompt: '', deliver: 'local', skills: '' })}><Plus size={14} />New job</Button></span>
      </PageHeader>
      <div className="flex-1 overflow-y-auto"><div className="mx-auto max-w-3xl p-4 sm:p-6 space-y-8 pb-16">
        {!jobs ? <div className="grid place-items-center py-20"><MoonLoader size={40} label="Loading automations" /></div> : <>
          <div className="grid grid-cols-3 gap-3">
            {[[rows.filter(r => r.status !== 'paused').length, 'active'], [soon.length, 'next 24h'], [failing.length, failing.length === 1 ? 'needs a look' : 'need a look']].map(([n, l], i) => (
              <div key={i} className="surface rounded-2xl px-4 py-3"><p className={`text-[26px] font-bold leading-tight tabular-nums ${i === 2 && n ? 'text-oxide' : ''}`}>{n}</p><p className="text-[12px] text-dust">{l}</p></div>
            ))}
          </div>

          {failing.length > 0 && <section className="space-y-2">
            <h2 className="label flex items-center gap-1.5 text-oxide"><AlertTriangle size={12} />Last run failed</h2>
            {failing.map(r => (
              <div key={r.key} className="rounded-xl border border-oxide/30 bg-oxide/5 px-4 py-3 flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="flex-1 min-w-[min(14rem,80%)]"><p className="font-bold text-sm">{r.name}</p><p className="text-[12.5px] text-oxide/90 line-clamp-2">{r.error ?? 'The last run reported an error.'}</p><p className="text-[11.5px] text-ash">{at(r.last)} · {r.target}</p></div>
                <div className="flex items-center ml-auto -mr-1">{actions(r)}</div>
              </div>
            ))}
          </section>}

          <section className="space-y-2">
            <h2 className="label">Next 24 hours</h2>
            {!soon.length ? <p className="text-sm text-dust">Nothing scheduled in the next day.</p> : <ol className="relative border-l border-line ml-1.5 space-y-0.5">
              {soon.map(r => (
                <li key={r.key} className="relative pl-5 py-1.5">
                  <span className={`absolute -left-[4.5px] top-3.5 size-2 rounded-full ring-4 ring-basalt ${r.status === 'failed' ? 'bg-oxide' : 'bg-tide'}`} />
                  <div className="flex flex-wrap items-baseline gap-x-2.5">
                    <span className="font-mono text-[12.5px] text-moon tabular-nums w-[7.5rem] flex-none whitespace-nowrap">{new Date(r.next!).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}<span className="text-ash"> · {until(r.next!)}</span></span>
                    <span className="text-sm flex-1 min-w-0 truncate">{r.name}</span><span className="hidden sm:inline"><Kind r={r} /></span>
                  </div>
                </li>
              ))}
            </ol>}
          </section>

          <section className="space-y-2">
            <h2 className="label flex items-center gap-1.5"><CalendarClock size={12} />All automations · {rows.length}</h2>
            {!rows.length ? <p className="text-sm text-dust">Nothing scheduled yet.</p> :
              <ul className="divide-y divide-line">{[...rows].sort((a, b) => Number(a.status === 'paused') - Number(b.status === 'paused') || (a.next ?? Infinity) - (b.next ?? Infinity)).map(r => (
                <li key={r.key} className={`py-3 flex flex-wrap items-start gap-x-3 gap-y-1 ${r.status === 'paused' ? 'opacity-60' : ''}`}>
                  <span className={`mt-1.5 size-2 rounded-full flex-none ${dot(r)}`} data-tip={{ ok: 'Last run ok', failed: 'Last run failed', paused: 'Paused', never: 'Not run yet' }[r.status]} />
                  <div className="flex-1 min-w-[min(14rem,75%)]">
                    <p className="flex items-center gap-2"><span className="font-bold text-sm truncate">{r.name}</span><Kind r={r} /></p>
                    <p className="text-[12.5px] text-dust">{r.when} → {r.target}</p>
                    <p className="text-[11.5px] text-ash">{r.status === 'paused' ? 'paused' : r.next ? `next ${at(r.next)}` : 'no next run'}{r.last ? ` · last ${ago(r.last)}${r.status === 'failed' ? ' (failed)' : ''}` : ''}</p>
                  </div>
                  <div className="flex items-center ml-auto -mr-1">{actions(r)}</div>
                </li>
              ))}</ul>}
          </section>

          {recent.length > 0 && <section className="space-y-2">
            <h2 className="label">Recently ran</h2>
            <ul className="space-y-1">{recent.map(r => (
              <li key={r.key} className="flex items-center gap-2.5 text-[13px]"><span className={`size-1.5 rounded-full flex-none ${dot(r)}`} /><span className="flex-1 min-w-0 truncate">{r.name}</span><span className="text-ash text-[12px] tabular-nums">{ago(r.last!)}</span></li>
            ))}</ul>
          </section>}
        </>}
      </div></div>
      {editing && <JobEditor draft={editing} onClose={() => setEditing(null)} onDone={load} />}
      {runs && <Runs job={runs} onClose={() => setRuns(null)} />}
    </div>
  );
}
