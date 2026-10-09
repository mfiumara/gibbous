// Review a planner's draft before anything lands on the board: edit, split, merge, re-link, re-plan.
import { useEffect, useState } from 'react';
import { Sparkles, Split, Merge, Trash2, Plus, Play, ListPlus, MessageSquare, X } from 'lucide-react';
import { api, type PlanDraft } from '../api';
import { useStore, toastError } from '../store';
import { Moon, Button, IconButton, inputCls, go } from '../ui';
import { Markdown } from '../thread/Items';

type DraftTask = PlanDraft['tasks'][number];

export function PlanReview({ draft }: { draft: PlanDraft }) {
  const [tasks, setTasks] = useState<DraftTask[]>(draft.tasks);
  const [feedback, setFeedback] = useState('');
  const [replanning, setReplanning] = useState(false);
  const planner = useStore(s => s.threads.find(t => t.id === draft.threadId));
  useEffect(() => { setTasks(draft.tasks); }, [draft.tasks, draft.updatedAt]);

  const set = (i: number, patch: Partial<DraftTask>) => setTasks(ts => ts.map((t, j) => j === i ? { ...t, ...patch } : t));
  const remove = (i: number) => setTasks(ts => { const key = ts[i].key; return ts.filter((_, j) => j !== i).map(t => ({ ...t, deps: t.deps.filter(d => d !== key) })); });
  const split = (i: number) => setTasks(ts => { const t = ts[i]; const key = `${t.key}b`; return [...ts.slice(0, i + 1), { key, title: `${t.title} (part 2)`, prompt: '', deps: [t.key] }, ...ts.slice(i + 1)]; });
  const mergeNext = (i: number) => setTasks(ts => {
    const a = ts[i], b = ts[i + 1];
    if (!b) return ts;
    const merged = { key: a.key, title: `${a.title} + ${b.title}`, prompt: `${a.prompt}\n\nThen also:\n${b.prompt}`, deps: [...new Set([...a.deps, ...b.deps])].filter(d => d !== a.key && d !== b.key) };
    return [...ts.slice(0, i), merged, ...ts.slice(i + 2)].map(t => ({ ...t, deps: [...new Set(t.deps.map(d => d === b.key ? a.key : d))].filter(d => d !== t.key) }));
  });
  const toggleDep = (i: number, key: string) => set(i, { deps: tasks[i].deps.includes(key) ? tasks[i].deps.filter(d => d !== key) : [...tasks[i].deps, key] });
  const accept = async (queue: boolean) => { try { await api.post(`/api/plans/${draft.id}/accept`, { tasks, queue }); useStore.getState().toast({ title: `${tasks.length} tasks added${queue ? ' and queued' : ''}` }); } catch (e) { toastError(e); } };
  const replan = async () => { try { await api.patch(`/api/plans/${draft.id}`, { tasks }); await api.post(`/api/plans/${draft.id}/replan`, { feedback }); setFeedback(''); setReplanning(false); } catch (e) { toastError(e); } };

  if (draft.status === 'drafting') return (
    <div className="surface rounded-2xl p-4 flex items-center gap-3 animate-rise">
      <Moon thread="running" size={11} />
      <div className="flex-1 min-w-0"><p className="font-bold text-sm">Planning: {draft.goal.slice(0, 120)}</p><p className="text-[12.5px] text-dust">The planner is reading the code.</p></div>
      <Button size="sm" onClick={() => go(`/t/${draft.threadId}`)}>Watch</Button>
      <IconButton label="Discard plan" onClick={() => api.post(`/api/plans/${draft.id}/discard`).catch(toastError)}><X size={14} /></IconButton>
    </div>
  );

  return (
    <section className="surface rounded-2xl p-4 space-y-4 animate-rise" aria-label="Plan review">
      <div className="flex items-start gap-3">
        <Sparkles size={16} className="text-halo mt-0.5" />
        <div className="flex-1 min-w-0"><p className="font-bold">Review the plan · {tasks.length} task{tasks.length === 1 ? '' : 's'}</p><p className="text-[13px] text-dust">{draft.goal}</p></div>
        <Button size="sm" onClick={() => api.post(`/api/plans/${draft.id}/discard`).catch(toastError)}>Discard</Button>
      </div>
      {draft.error && <p className="rounded-lg border border-oxide/40 bg-oxide/5 px-3 py-2 text-[13px] text-oxide">The planner's reply couldn't be read ({draft.error}). Re-plan with feedback, or add tasks by hand.</p>}
      {draft.summary && <details className="text-[13px] text-dust"><summary className="cursor-pointer label">Planner's summary</summary><div className="mt-2"><Markdown text={draft.summary} /></div></details>}
      <ol className="space-y-2.5">
        {tasks.map((t, i) => (
          <li key={t.key} className="group rounded-xl border border-line bg-basalt p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-ash w-6">{i + 1}.</span>
              <input value={t.title} onChange={e => set(i, { title: e.target.value })} aria-label="Task title" className="flex-1 bg-transparent font-bold text-sm focus:outline-none border-b border-transparent focus:border-tide/50" />
              <span className="flex gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                <IconButton label="Split into two tasks" onClick={() => split(i)}><Split size={13} /></IconButton>
                {i < tasks.length - 1 && <IconButton label="Merge with the next task" onClick={() => mergeNext(i)}><Merge size={13} /></IconButton>}
                <IconButton label="Remove task" onClick={() => remove(i)}><Trash2 size={13} /></IconButton>
              </span>
            </div>
            <textarea value={t.prompt} onChange={e => set(i, { prompt: e.target.value })} rows={3} aria-label="Instructions" className={inputCls + ' text-[13px]'} />
            {tasks.length > 1 && <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="label mr-1">After</span>
              {tasks.filter(o => o.key !== t.key).map(o => <button key={o.key} onClick={() => toggleDep(i, o.key)} aria-pressed={t.deps.includes(o.key)}
                className={`press rounded-md border px-1.5 py-0.5 ${t.deps.includes(o.key) ? 'border-tide/60 bg-tide/10 text-moon' : 'border-line text-ash hover:text-dust'}`}>{o.title.slice(0, 30)}</button>)}
            </div>}
          </li>
        ))}
      </ol>
      <button onClick={() => setTasks(ts => [...ts, { key: `n${Date.now()}`, title: 'New task', prompt: '', deps: [] }])} className="press inline-flex items-center gap-1.5 text-[13px] text-dust hover:text-moon"><Plus size={13} />Add a task</button>
      {replanning ? (
        <div className="space-y-2 animate-fade">
          <textarea autoFocus value={feedback} onChange={e => setFeedback(e.target.value)} rows={3} placeholder="What should the planner change? e.g. fewer tasks, keep the API stable, start with tests" className={inputCls + ' text-[13px]'} />
          <div className="flex justify-end gap-2"><Button size="sm" onClick={() => setReplanning(false)}>Cancel</Button><Button size="sm" tone="primary" disabled={!feedback.trim()} onClick={replan}>Send to planner</Button></div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-line">
          <Button size="sm" className="mt-3" onClick={() => setReplanning(true)}><MessageSquare size={12} />Re-plan with feedback</Button>
          {planner && <Button size="sm" className="mt-3" onClick={() => go(`/t/${planner.id}`)}>Planner thread</Button>}
          <span className="flex-1" />
          <Button size="sm" className="mt-3" onClick={() => accept(false)} disabled={!tasks.length}><ListPlus size={12} />Add to backlog</Button>
          <Button size="sm" tone="primary" className="mt-3" onClick={() => accept(true)} disabled={!tasks.length}><Play size={12} />Add and start</Button>
        </div>
      )}
    </section>
  );
}
