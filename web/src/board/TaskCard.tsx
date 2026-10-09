import { useState } from 'react';
import { Play, GitMerge, GitPullRequest, MessageSquareWarning, RotateCcw, Trash2, Pencil, ChevronDown, ExternalLink, ScanSearch, FlaskConical, Timer, Coins } from 'lucide-react';
import { api, type Task } from '../api';
import { useStore, toastError } from '../store';
import { Moon, Button, IconButton, Modal, inputCls, go, ago, fmtUsd, fmtDuration } from '../ui';
import { Markdown } from '../thread/Items';

const openThread = (id?: string, panel?: string) => { if (!id) return; if (panel) localStorage.setItem('gibbous.panel', panel); go(`/t/${id}`); };

function useTaskUsage(t: Task) {
  const threads = useStore(s => s.threads);
  const mine = threads.filter(x => x.taskId === t.id);
  return { tokens: mine.reduce((n, x) => n + (x.usage?.tokens ?? 0), 0), costUsd: mine.reduce((n, x) => n + (x.usage?.costUsd ?? 0), 0) };
}

export function TaskCard({ t, all, onEdit, onDrag }: { t: Task; all: Task[]; onEdit(): void; onDrag(id: string | null): void }) {
  const [open, setOpen] = useState(t.status === 'review' || t.status === 'failed');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const playbook = useStore(s => s.playbooks.find(p => p.id === t.playbookId));
  const usage = useTaskUsage(t);
  const deps = t.deps.map(d => all.find(x => x.id === d)).filter(Boolean) as Task[];
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const merge = (mode: 'merge' | 'pr') => act(() => api.post<Task>(`/api/tasks/${t.id}/merge`, { mode }));
  const draggable = t.status === 'backlog' || t.status === 'queued';
  const elapsed = t.startedAt ? (t.finishedAt ?? (t.status === 'done' ? t.updatedAt : Date.now())) - t.startedAt : undefined;

  return (
    <article draggable={draggable} onDragStart={() => onDrag(t.id)} onDragEnd={() => onDrag(null)}
      className={`press group rounded-xl border bg-basalt p-3 space-y-2 shadow-[inset_0_1px_0_var(--surface-hi)] hover:border-ash/40 ${t.status === 'review' ? 'border-halo/40' : t.status === 'failed' ? 'border-oxide/40' : 'border-line'} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}>
      <div className="flex items-start gap-2">
        <span className="mt-1.5"><Moon task={t.status} size={10} /></span>
        <button onClick={() => setOpen(!open)} className="flex-1 min-w-0 text-left text-[14px] leading-snug font-bold">{t.title}</button>
        <button onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'} className="-m-2 grid place-items-center size-8 flex-none text-ash hover:text-moon"><ChevronDown size={14} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} /></button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {t.status === 'reviewing' && <span className="label text-tide">reviewing · round {t.reviewRounds}</span>}
        {t.status === 'testing' && <span className="label text-tide inline-flex items-center gap-1"><FlaskConical size={10} />testing{t.testRuns ? ` · fix ${t.testRuns}` : ''}</span>}
        {t.verdict && t.status !== 'reviewing' && <span className={`label ${t.verdict === 'approve' ? 'text-sprout' : 'text-halo'}`}>{t.verdict === 'approve' ? 'approved' : 'changes requested'}</span>}
        {playbook && <span className="label text-ash" data-tip={playbook.description}>{playbook.name}</span>}
        {!t.worktree && <span className="label text-ash">in place</span>}
        {deps.map(d => <span key={d.id} className="inline-flex items-center gap-1 rounded-md bg-ridge px-1.5 py-0.5 text-dust" data-tip={`Waits for ${d.title}`}><Moon task={d.status} size={7} />after {d.title.slice(0, 28)}</span>)}
        <span className="ml-auto flex items-center gap-2 text-ash">
          {usage.costUsd > 0 && <span className="inline-flex items-center gap-0.5" data-tip={`${usage.tokens.toLocaleString()} tokens`}><Coins size={10} />{fmtUsd(usage.costUsd)}</span>}
          {elapsed != null && <span className="inline-flex items-center gap-0.5"><Timer size={10} />{fmtDuration(elapsed)}</span>}
          {elapsed == null && ago(t.updatedAt)}
        </span>
      </div>
      {open && <div className="space-y-2.5 animate-fade">
        <p className="text-[13px] text-dust whitespace-pre-wrap line-clamp-6">{t.prompt}</p>
        {t.reviewNotes && <div className="rounded-lg border border-line p-2.5 text-[13px] max-h-60 overflow-y-auto"><p className="label mb-1">{t.status === 'failed' ? 'Error' : 'Reviewer'}</p><Markdown text={t.reviewNotes} /></div>}
        {t.mergedAs && <p className="text-[12px] text-dust">{t.mergedAs.startsWith('http') ? <a className="text-tide underline inline-flex items-center gap-1" href={t.mergedAs} target="_blank" rel="noreferrer">Pull request <ExternalLink size={11} /></a> : <>Merged as <span className="font-mono">{t.mergedAs}</span></>}</p>}
      </div>}
      <div className="flex flex-wrap gap-1.5">
        {t.status === 'backlog' && <><Button size="sm" tone="primary" onClick={() => act(() => api.patch(`/api/tasks/${t.id}`, { status: 'queued' }))}><Play size={12} />Queue</Button><IconButton label="Edit task" onClick={onEdit}><Pencil size={13} /></IconButton></>}
        {t.status === 'queued' && <Button size="sm" onClick={() => act(() => api.patch(`/api/tasks/${t.id}`, { status: 'backlog' }))}>Back to backlog</Button>}
        {t.threadId && <Button size="sm" onClick={() => openThread(t.threadId, t.status === 'review' ? 'changes' : undefined)}>{t.status === 'review' ? 'Diff' : 'Agent'}</Button>}
        {t.reviewThreadId && <Button size="sm" onClick={() => openThread(t.reviewThreadId)}><ScanSearch size={12} />Reviewer</Button>}
        {t.status === 'review' && <>
          <Button size="sm" tone="halo" disabled={busy} onClick={() => merge('merge')} data-tip="Commit, merge into the base branch and clean up the worktree"><GitMerge size={12} />Merge</Button>
          {t.worktree && <Button size="sm" disabled={busy} onClick={() => merge('pr')} data-tip="Commit, push the branch and open a pull request"><GitPullRequest size={12} />PR</Button>}
          <Button size="sm" disabled={busy} onClick={() => setAsking(true)}><MessageSquareWarning size={12} />Request changes</Button>
          <IconButton label="Review again" disabled={busy} onClick={() => act(() => api.post(`/api/tasks/${t.id}/review`))}><ScanSearch size={13} /></IconButton>
        </>}
        {t.status === 'failed' && <Button size="sm" onClick={() => act(() => api.patch(`/api/tasks/${t.id}`, { status: 'queued' }))}><RotateCcw size={12} />Retry</Button>}
        {(t.status === 'backlog' || t.status === 'failed' || t.status === 'done') && <IconButton label="Delete task" className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => confirm(`Delete "${t.title}"?`) && act(() => api.del(`/api/tasks/${t.id}`))}><Trash2 size={13} /></IconButton>}
      </div>
      <RequestChanges task={t} open={asking} onClose={() => setAsking(false)} />
    </article>
  );
}

function RequestChanges({ task, open, onClose }: { task: Task; open: boolean; onClose(): void }) {
  const [text, setText] = useState('');
  const send = async () => {
    try {
      await api.patch(`/api/tasks/${task.id}`, { status: 'running' });
      await api.post(`/api/threads/${task.threadId}/send`, { text });
      setText(''); onClose();
    } catch (e) { toastError(e); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Request changes: ${task.title}`}>
      <textarea className={inputCls + ' min-h-32'} value={text} onChange={e => setText(e.target.value)} placeholder="What should the agent change? The result goes through review again." />
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!text.trim()} onClick={send}>Send to agent</Button></div>
    </Modal>
  );
}
