// Recurring tasks: on schedule, a fresh task is queued on the board with the chosen playbook.
import { useEffect, useMemo, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { api, type Project, type Schedule } from '../api';
import { useStore, toastError } from '../store';
import { Button, IconButton, Modal, Field, Switch, inputCls } from '../ui';

const PRESETS = [['Weekdays 9:00', '0 9 * * 1-5'], ['Every morning 8:00', '0 8 * * *'], ['Mondays 9:00', '0 9 * * 1'], ['Every 6 hours', 'every 6h'], ['Nightly 2:00', '0 2 * * *']];

function NextRun({ cron }: { cron: string }) {
  const [r, setR] = useState<{ next?: number; error?: string }>({});
  useEffect(() => { const h = setTimeout(() => api.get<typeof r>(`/api/schedules/next?cron=${encodeURIComponent(cron)}`).then(setR, () => {}), 250); return () => clearTimeout(h); }, [cron]);
  return <span className={`text-xs ${r.error ? 'text-oxide' : 'text-dust'}`}>{r.error ?? (r.next ? `Next: ${new Date(r.next).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '')}</span>;
}

export function SchedulesDialog({ project, open, onClose }: { project: Project; open: boolean; onClose(): void }) {
  const all = useStore(s => s.schedules);
  const schedules = useMemo(() => all.filter(x => x.projectId === project.id), [all, project.id]);
  const playbooks = useStore(s => s.playbooks);
  const [draft, setDraft] = useState<Partial<Schedule> | null>(null);
  const save = async () => {
    try {
      if (draft!.id) await api.patch(`/api/schedules/${draft!.id}`, draft);
      else await api.post('/api/schedules', { ...draft, projectId: project.id });
      setDraft(null);
    } catch (e) { toastError(e); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Schedules · ${project.name}`} wide>
      <p className="text-sm text-dust">Each run queues a task. Times are this Mac's time.</p>
      {!draft && <>
        <ul className="divide-y divide-line">{schedules.map(sc => (
          <li key={sc.id} className="flex items-center gap-3 py-2.5">
            <Switch label={`Enable ${sc.title}`} checked={sc.enabled} onChange={v => api.patch(`/api/schedules/${sc.id}`, { enabled: v }).catch(toastError)} />
            <button onClick={() => setDraft(sc)} className="flex-1 min-w-0 text-left">
              <span className="block text-sm font-bold truncate">{sc.title}</span>
              <span className="block font-mono text-[11.5px] text-dust">{sc.cron}{sc.lastRun ? ` · last ran ${new Date(sc.lastRun).toLocaleString()}` : ''}</span>
            </button>
            <IconButton label="Delete schedule" onClick={() => confirm(`Delete "${sc.title}"?`) && api.del(`/api/schedules/${sc.id}`).catch(toastError)}><Trash2 size={13} /></IconButton>
          </li>
        ))}</ul>
        {!schedules.length && <p className="text-sm text-ash">No schedules yet.</p>}
        <div className="flex justify-between"><Button onClick={() => setDraft({ cron: '0 9 * * 1-5', title: '', prompt: '' })}><Plus size={13} />New schedule</Button><Button tone="primary" onClick={onClose}>Done</Button></div>
      </>}
      {draft && <div className="space-y-3 animate-fade">
        <Field label="Title"><input className={inputCls} value={draft.title ?? ''} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="Weekly dependency check" autoFocus /></Field>
        <Field label="Instructions"><textarea className={inputCls + ' min-h-28'} value={draft.prompt ?? ''} onChange={e => setDraft({ ...draft, prompt: e.target.value })} placeholder="Check for outdated dependencies and upgrade the safe ones…" /></Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="When" hint={<NextRun cron={draft.cron ?? ''} />}>
            <input className={inputCls + ' font-mono'} value={draft.cron ?? ''} onChange={e => setDraft({ ...draft, cron: e.target.value })} />
          </Field>
          <Field label="Playbook"><select className={inputCls} value={draft.playbookId ?? ''} onChange={e => setDraft({ ...draft, playbookId: e.target.value || undefined })}>
            <option value="">Project default</option>{playbooks.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></Field>
        </div>
        <div className="flex flex-wrap gap-1.5">{PRESETS.map(([label, cron]) => <button key={cron} onClick={() => setDraft({ ...draft, cron })} className={`press h-7 px-2.5 rounded-md border text-[12px] ${draft.cron === cron ? 'border-tide/60 bg-tide/10' : 'border-line text-dust hover:text-moon'}`}>{label}</button>)}</div>
        <div className="flex justify-end gap-2"><Button onClick={() => setDraft(null)}>Back</Button><Button tone="primary" onClick={save} disabled={!draft.title?.trim() || !draft.prompt?.trim()}>Save schedule</Button></div>
      </div>}
    </Modal>
  );
}
