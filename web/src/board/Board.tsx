import { useMemo, useState } from 'react';
import { Menu, Plus, Sparkles, Play, Settings2, Trash2, Columns3, Network, CalendarClock, Coins } from 'lucide-react';
import { api, type Task, type TaskStatus, type Project } from '../api';
import { useStore, toastError } from '../store';
import { Button, IconButton, Modal, Field, Segmented, inputCls, Empty, go, fmtUsd } from '../ui';
import { TaskCard } from './TaskCard';
import { PlanReview } from './PlanReview';
import { Graph } from './Graph';
import { SchedulesDialog } from './Schedules';

const COLUMNS: { title: string; statuses: TaskStatus[]; drop?: TaskStatus; hint: string }[] = [
  { title: 'Backlog', statuses: ['backlog'], drop: 'backlog', hint: 'Not started. Queue tasks when they look right.' },
  { title: 'Up next', statuses: ['queued'], drop: 'queued', hint: 'Starts automatically when a slot frees up and dependencies are merged.' },
  { title: 'Working', statuses: ['running', 'reviewing', 'testing'], hint: 'An agent is coding, a reviewer is checking it, or the test gate is running.' },
  { title: 'Needs you', statuses: ['review', 'failed'], hint: 'Reviewed and waiting for you to merge, or failed.' },
  { title: 'Done', statuses: ['done'], hint: 'Merged or opened as a pull request.' },
];

function PlaybookSelect({ value, onChange, label = 'Playbook' }: { value?: string; onChange(v: string | undefined): void; label?: string }) {
  const playbooks = useStore(s => s.playbooks);
  const pb = playbooks.find(p => p.id === value);
  return (
    <Field label={label} hint={pb ? pb.description : 'Uses the review settings from Settings → General.'}>
      <select className={inputCls} value={value ?? ''} onChange={e => onChange(e.target.value || undefined)}>
        <option value="">No playbook</option>
        {playbooks.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </Field>
  );
}

export function Board({ projectId }: { projectId: string }) {
  const project = useStore(s => s.projects.find(p => p.id === projectId));
  const allTasks = useStore(s => s.tasks);
  const allPlans = useStore(s => s.plans);
  const threads = useStore(s => s.threads);
  const settings = useStore(s => s.settings);
  const [q, setQ] = useState('');
  const projectTasks = useMemo(() => allTasks.filter(t => t.projectId === projectId), [allTasks, projectId]);
  const tasks = useMemo(() => { const n = q.trim().toLowerCase(); return n ? projectTasks.filter(t => `${t.title} ${t.prompt}`.toLowerCase().includes(n)) : projectTasks; }, [projectTasks, q]);
  const plans = allPlans.filter(p => p.projectId === projectId);
  const [editing, setEditing] = useState<Partial<Task> | null>(null);
  const [planning, setPlanning] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [view, setView] = useState<'columns' | 'graph'>(() => (localStorage.getItem('gibbous.boardView') as 'graph') ?? 'columns');

  if (!project) return <Empty title="Project not found" />;
  const working = tasks.filter(t => t.status === 'running' || t.status === 'reviewing' || t.status === 'testing').length;
  const backlog = tasks.filter(t => t.status === 'backlog');
  const spent = threads.filter(t => t.projectId === projectId && t.taskId).reduce((n, t) => n + (t.usage?.costUsd ?? 0), 0);
  const patch = (t: Task, body: Partial<Task>) => api.patch(`/api/tasks/${t.id}`, body).catch(toastError);
  const changeView = (v: 'columns' | 'graph') => { setView(v); localStorage.setItem('gibbous.boardView', v); };

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-2 px-3 h-12 border-b border-line flex-none">
        <IconButton label="Open sidebar" className="lg:hidden" onClick={() => useStore.setState({ sidebar: true })}><Menu size={17} /></IconButton>
        <h1 className="font-bold truncate">{project.name}</h1>
        <span className="hidden sm:inline label">{working}/{settings?.maxConcurrent ?? 3} working</span>
        {spent > 0 && <span className="hidden md:inline-flex items-center gap-1 label" data-tip="Spent on this board's task agents"><Coins size={11} />{fmtUsd(spent)}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden sm:block"><Segmented label="View" value={view} onChange={changeView} options={[{ value: 'columns', label: <><Columns3 size={13} /><span className="sr-only">Columns</span></>, tip: 'Columns' }, { value: 'graph', label: <><Network size={13} /><span className="sr-only">Dependency graph</span></>, tip: 'Dependency graph' }]} /></span>
          <IconButton label="Schedules" onClick={() => setScheduling(true)}><CalendarClock size={16} /></IconButton>
          <IconButton label="Project settings" onClick={() => setConfiguring(true)}><Settings2 size={16} /></IconButton>
          {backlog.length > 0 && <Button size="sm" aria-label="Queue all" onClick={() => backlog.forEach(t => patch(t, { status: 'queued' }))}><Play size={13} /><span className="hidden sm:inline">Queue all</span></Button>}
          <Button size="sm" aria-label="Plan" onClick={() => setPlanning(true)}><Sparkles size={13} /><span className="hidden sm:inline">Plan</span></Button>
          <Button size="sm" tone="primary" onClick={() => setEditing({ worktree: true, deps: [] })}><Plus size={14} />Task</Button>
        </div>
      </header>
      {projectTasks.length > 5 && <div className="px-3 pt-3 flex-none"><input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQ('')} placeholder={`Filter ${projectTasks.length} tasks`} aria-label="Filter tasks"
        className={inputCls + ' max-w-sm py-1.5'} /></div>}

      {plans.length > 0 && <div className="flex-none max-h-[60%] overflow-y-auto p-3 space-y-3 border-b border-line">{plans.map(p => <PlanReview key={p.id} draft={p} />)}</div>}

      {!projectTasks.length && !plans.length ? (
        <Empty title="No tasks yet">
                    <div className="flex justify-center gap-2"><Button tone="primary" onClick={() => setPlanning(true)}><Sparkles size={14} />Plan a goal</Button><Button onClick={() => setEditing({ worktree: true, deps: [] })}>Add a task</Button></div>
        </Empty>
      ) : view === 'graph' ? (
        <div className="flex-1 min-h-0"><Graph tasks={tasks} onOpen={t => t.threadId ? go(`/t/${t.threadId}`) : setEditing(t)} /></div>
      ) : (
        <div className="flex-1 min-h-0 overflow-x-auto snap-x snap-mandatory lg:snap-none">
          <div className="flex gap-3 p-3 h-full min-w-max lg:min-w-0">
            {COLUMNS.map(col => {
              const list = tasks.filter(t => col.statuses.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
              return (
                <section key={col.title} aria-label={col.title}
                  onDragOver={e => { if (col.drop && dragging) e.preventDefault(); }}
                  onDrop={() => { const t = tasks.find(x => x.id === dragging); if (t && col.drop && (t.status === 'backlog' || t.status === 'queued')) patch(t, { status: col.drop }); setDragging(null); }}
                  className={`snap-start w-[82vw] sm:w-[300px] flex-none lg:flex-1 lg:w-auto lg:min-w-[220px] flex flex-col rounded-2xl bg-crater/45 border transition-colors ${dragging && col.drop ? 'border-dashed border-ash' : 'border-transparent'}`}>
                  <div className="flex items-center gap-2 px-3 pt-3 pb-2" data-tip={col.hint}>
                    <h2 className="label text-moon/80">{col.title}</h2><span className="label text-ash">{list.length}</span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-2">
                    {list.map(t => <TaskCard key={t.id} t={t} all={tasks} onEdit={() => setEditing(t)} onDrag={setDragging} />)}
                    {!list.length && <p className="px-1.5 py-2 text-[12.5px] text-ash">{col.hint}</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <TaskEditor project={project} task={editing} all={tasks} onClose={() => setEditing(null)} />
      <PlanDialog project={project} open={planning} onClose={() => setPlanning(false)} />
      <ProjectSettings project={project} open={configuring} onClose={() => setConfiguring(false)} />
      <SchedulesDialog project={project} open={scheduling} onClose={() => setScheduling(false)} />
    </div>
  );
}

function TaskEditor({ project, task, all, onClose }: { project: Project; task: Partial<Task> | null; all: Task[]; onClose(): void }) {
  const [draft, setDraft] = useState<Partial<Task>>({});
  const [lastTask, setLastTask] = useState(task);
  if (task !== lastTask) { setLastTask(task); setDraft(task ?? {}); }
  const set = (p: Partial<Task>) => setDraft(d => ({ ...d, ...p }));
  const save = async (queue: boolean) => {
    try {
      const body = { title: draft.title, prompt: draft.prompt, deps: draft.deps ?? [], worktree: draft.worktree ?? true, playbookId: draft.playbookId ?? project.playbookId };
      if (draft.id) await api.patch(`/api/tasks/${draft.id}`, body);
      else await api.post('/api/tasks', { ...body, projectId: project.id, status: queue ? 'queued' : 'backlog' });
      onClose();
    } catch (e) { toastError(e); }
  };
  const others = all.filter(t => t.id !== draft.id && t.status !== 'done');
  return (
    <Modal open={!!task} onClose={onClose} title={draft.id ? 'Edit task' : 'New task'} wide>
      <Field label="Title"><input className={inputCls} value={draft.title ?? ''} onChange={e => set({ title: e.target.value })} autoFocus /></Field>
      <Field label="Instructions"><textarea className={inputCls + ' min-h-40 font-mono text-[13px]'} value={draft.prompt ?? ''} onChange={e => set({ prompt: e.target.value })} /></Field>
      {others.length > 0 && <Field label="Waits for">
        <div className="flex flex-wrap gap-1.5">{others.map(o => {
          const on = draft.deps?.includes(o.id);
          return <button key={o.id} type="button" aria-pressed={on} onClick={() => set({ deps: on ? draft.deps!.filter(d => d !== o.id) : [...(draft.deps ?? []), o.id] })}
            className={`rounded-md border px-2 py-1 text-[12.5px] ${on ? 'border-tide text-moon bg-tide/10' : 'border-line text-dust'}`}>{o.title}</button>;
        })}</div>
      </Field>}
      <PlaybookSelect value={draft.playbookId ?? project.playbookId} onChange={v => set({ playbookId: v })} />
      {project.baseBranch && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-tide" checked={draft.worktree ?? true} onChange={e => set({ worktree: e.target.checked })} />Run in its own worktree (recommended for parallel tasks)</label>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        {!draft.id && <Button onClick={() => save(false)} disabled={!draft.title || !draft.prompt}>Add to backlog</Button>}
        <Button tone="primary" onClick={() => save(!draft.id)} disabled={!draft.title || !draft.prompt}>{draft.id ? 'Save task' : 'Add and queue'}</Button>
      </div>
    </Modal>
  );
}

function PlanDialog({ project, open, onClose }: { project: Project; open: boolean; onClose(): void }) {
  const [goal, setGoal] = useState('');
  const [playbookId, setPlaybookId] = useState<string | undefined>(project.playbookId);
  const start = async () => {
    try { await api.post('/api/plan', { projectId: project.id, goal, playbookId }); setGoal(''); onClose(); }
    catch (e) { toastError(e); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Plan in ${project.name}`}>
      <p className="text-sm text-dust">You review the tasks before anything runs.</p>
      <textarea className={inputCls + ' min-h-32'} value={goal} onChange={e => setGoal(e.target.value)} placeholder="e.g. Add OAuth login with GitHub and Google, with tests" autoFocus />
      <PlaybookSelect value={playbookId} onChange={setPlaybookId} />
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!goal.trim()} onClick={start}><Sparkles size={14} />Start planning</Button></div>
    </Modal>
  );
}

function ProjectSettings({ project, open, onClose }: { project: Project; open: boolean; onClose(): void }) {
  const [name, setName] = useState(project.name);
  const [base, setBase] = useState(project.baseBranch ?? '');
  const [setup, setSetup] = useState(project.setupScript ?? '');
  const [scripts, setScripts] = useState(project.scripts ?? []);
  const [playbookId, setPlaybookId] = useState(project.playbookId);
  const save = async () => { await api.patch(`/api/projects/${project.id}`, { name, baseBranch: base || undefined, setupScript: setup || undefined, scripts: scripts.filter(s => s.name.trim() && s.command.trim()), playbookId }).catch(toastError); onClose(); };
  const remove = async () => { if (!confirm(`Remove ${project.name} from Gibbous? Its tasks are deleted; files and threads stay.`)) return; await api.del(`/api/projects/${project.id}`).catch(toastError); go('/'); };
  const detect = async () => {
    const found = await api.get<{ name: string; command: string }[]>(`/api/projects/${project.id}/scripts/detect`).catch(toastError);
    if (found) setScripts(s => [...s, ...found.filter(f => !s.some(x => x.name === f.name))]);
  };
  const setScript = (i: number, patch: Partial<{ name: string; command: string }>) => setScripts(s => s.map((x, j) => j === i ? { ...x, ...patch } : x));
  return (
    <Modal open={open} onClose={onClose} title="Project settings" wide>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Name"><input className={inputCls} value={name} onChange={e => setName(e.target.value)} /></Field>
        {project.baseBranch !== undefined && <Field label="Base branch" hint="Worktrees branch from here; merges land here."><input className={inputCls + ' font-mono'} value={base} onChange={e => setBase(e.target.value)} /></Field>}
      </div>
      <p className="text-xs text-dust font-mono">{project.path}</p>
      <PlaybookSelect value={playbookId} onChange={setPlaybookId} label="Default playbook" />
      <Field label="Worktree setup script" hint="Runs in each new worktree, e.g. pnpm install."><textarea className={inputCls + ' font-mono text-[13px] min-h-16'} value={setup} onChange={e => setSetup(e.target.value)} placeholder="pnpm install" /></Field>
      <div className="space-y-2">
        <div className="flex items-center"><span className="label flex-1">Scripts</span><Button size="sm" onClick={detect}>Detect from package.json / Makefile</Button><Button size="sm" className="ml-1.5" onClick={() => setScripts(s => [...s, { name: '', command: '' }])}><Plus size={12} />Add</Button></div>
        <p className="text-xs text-dust">Buttons in the Terminal panel.</p>
        {scripts.map((sc, i) => <div key={i} className="flex gap-2">
          <input className={inputCls + ' w-36 font-mono text-[13px]'} placeholder="name" value={sc.name} onChange={e => setScript(i, { name: e.target.value })} />
          <input className={inputCls + ' font-mono text-[13px]'} placeholder="command" value={sc.command} onChange={e => setScript(i, { command: e.target.value })} />
          <IconButton label="Remove script" onClick={() => setScripts(s => s.filter((_, j) => j !== i))}><Trash2 size={13} /></IconButton>
        </div>)}
      </div>
      <div className="flex gap-2 pt-2"><Button tone="danger" onClick={remove}>Remove project</Button><span className="flex-1" /><Button onClick={onClose}>Cancel</Button><Button tone="primary" onClick={save}>Save</Button></div>
    </Modal>
  );
}
