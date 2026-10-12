import { useEffect, useState } from 'react';
import { Check, UserCheck, X, Pencil, Plus } from 'lucide-react';
import { api, type Thread } from './api';
import { toastError } from './store';
import { Modal, NO_PREDICT } from './ui';
import { humanTasks, type HumanTask } from '../../server/humanTasks';

export const editHumanTask = (t: Thread) => dispatchEvent(new CustomEvent('gibbous:humanTask', { detail: t.id }));
export const replyTaskText = (text: string) => {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (plain.length <= 140) return plain;
  const cut = plain.slice(0, 139); return cut.slice(0, cut.lastIndexOf(' ') > 100 ? cut.lastIndexOf(' ') : 139) + '…';
};
export const addReplyTask = (thread: string, text: string) => api.post(`/api/threads/${thread}/human-tasks`, { text: replyTaskText(text) }).catch(toastError);
export function focusHumanTask(id: string) {
  let tries = 0;
  const seek = () => { const el = document.getElementById(`human-task-${id}`); if (!el && tries++ < 20) return setTimeout(seek, 100); if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el.focus({ preventScroll: true }); el.animate([{ backgroundColor: 'var(--color-ridge)' }, { backgroundColor: 'transparent' }], { duration: 1800 }); } };
  setTimeout(seek, 100);
}
export function HumanTaskEditor() {
  const [id, setId] = useState<string>(); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { const edit = (e: Event) => { setText(''); setId((e as CustomEvent<string>).detail); }; addEventListener('gibbous:humanTask', edit); return () => removeEventListener('gibbous:humanTask', edit); }, []);
  const save = async () => { if (!id || !text.trim() || busy) return; setBusy(true); try { await api.post(`/api/threads/${id}/human-tasks`, { text }); setId(undefined); } catch (e) { toastError(e); } finally { setBusy(false); } };
  return <Modal open={!!id} onClose={() => setId(undefined)} title="A task for me"><form onSubmit={e => { e.preventDefault(); save(); }} className="space-y-4">
    <label className="block text-sm text-dust">What do you need to do?<textarea {...NO_PREDICT} aria-label="Task for me" value={text} onChange={e => setText(e.target.value)} maxLength={1000} rows={3} placeholder="Plug in the device and check its display." className="mt-2 w-full resize-none rounded-xl border border-line bg-well p-3 text-moon focus:outline-none focus:border-tide/60" /></label>
    <div className="flex justify-end gap-2"><button type="button" onClick={() => setId(undefined)} className="press px-3 h-9 rounded-lg text-dust">Cancel</button><button disabled={!text.trim() || busy} className="press px-4 h-9 rounded-lg bg-ridge text-moon disabled:opacity-40">Save task</button></div>
  </form></Modal>;
}
export function TaskCheck({ thread, task }: { thread: Thread; task: HumanTask }) {
  const [busy, setBusy] = useState(false); const done = task.doneAt != null;
  return <button role="checkbox" aria-checked={done} aria-label={`${done ? 'Reopen' : 'Complete'} task: ${task.text}`} disabled={busy} onClick={async () => { setBusy(true); try { await api.patch(`/api/threads/${thread.id}/human-tasks/${task.id}`, { done: !done }); } catch (e) { toastError(e); } finally { setBusy(false); } }} className="press flex-none grid place-items-center rounded-lg min-h-8 min-w-8 pointer-coarse:min-h-11 text-dust hover:text-moon">
    <span className={`size-4 grid place-items-center rounded-full border transition-all ${done ? 'bg-tide border-tide text-basalt' : 'border-ash/60 hover:border-tide'}`}><Check size={10} strokeWidth={3} className={done ? 'opacity-100' : 'opacity-0'} /></span>
  </button>;
}
function TaskRow({ thread, task }: { thread: Thread; task: HumanTask }) {
  const [edit, setEdit] = useState(false); const [text, setText] = useState(task.text);
  const save = async () => { if (!text.trim()) return; try { await api.patch(`/api/threads/${thread.id}/human-tasks/${task.id}`, { text }); setEdit(false); } catch (e) { toastError(e); } };
  return <div id={`human-task-${task.id}`} tabIndex={-1} className="group/task flex items-start gap-1 rounded-lg focus:outline-none focus:bg-ridge/50">
    <TaskCheck thread={thread} task={task} />
    {edit ? <form className="flex-1 min-w-0 py-1" onSubmit={e => { e.preventDefault(); save(); }}><input {...NO_PREDICT} autoFocus aria-label="Edit task" value={text} maxLength={1000} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEdit(false); setText(task.text); } }} className="w-full bg-well rounded-md border border-line px-2 py-1 text-sm text-moon" /><button className="text-xs text-tide py-1">Save</button><button type="button" onClick={() => setEdit(false)} className="text-xs text-ash px-2">Cancel</button></form>
      : <span onDoubleClick={() => { setText(task.text); setEdit(true); }} className={`flex-1 min-w-0 py-2 text-[13px] leading-snug select-text break-words ${task.doneAt != null ? 'text-ash line-through' : 'text-moon'}`}>{task.text}</span>}
    {!edit && <div className="flex flex-none opacity-0 group-hover/task:opacity-100 group-focus-within/task:opacity-100 pointer-coarse:opacity-100"><button aria-label={`Edit task: ${task.text}`} onClick={() => { setText(task.text); setEdit(true); }} className="press size-8 pointer-coarse:h-11 grid place-items-center text-ash hover:text-moon"><Pencil size={12} /></button><button aria-label={`Remove task: ${task.text}`} onClick={() => api.del(`/api/threads/${thread.id}/human-tasks/${task.id}`).catch(toastError)} className="press size-8 pointer-coarse:h-11 grid place-items-center text-ash hover:text-moon"><X size={13} /></button></div>}
  </div>;
}
// The thread's "For me" checklist. `rail`: a card in the right gutter under the pull requests (wide screens);
// otherwise a slim strip above the conversation. Gone when nothing is left to do (done ones live in the sidebar's history).
export function HumanTaskCard({ thread, rail = false }: { thread: Thread; rail?: boolean }) {
  const tasks = humanTasks(thread); const [expanded, setExpanded] = useState(false); const [adding, setAdding] = useState(false); const [text, setText] = useState('');
  const open = tasks.filter(task => task.doneAt == null), done = tasks.filter(task => task.doneAt != null);
  if (!open.length && !adding) return null;
  const add = adding ? <form className="flex gap-2 px-1 py-1" onSubmit={async e => { e.preventDefault(); if (!text.trim()) return; try { await api.post(`/api/threads/${thread.id}/human-tasks`, { text }); setText(''); setAdding(false); } catch (e) { toastError(e); } }}><input {...NO_PREDICT} autoFocus value={text} onChange={e => setText(e.target.value)} maxLength={1000} aria-label="New task" placeholder="Something for me to do…" onBlur={() => { if (!text.trim()) setAdding(false); }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(false); } }} className="flex-1 min-w-0 h-8 rounded-lg bg-well border border-line px-2 text-[13px] text-moon" /></form> : null;
  const head = <div className="flex items-center gap-2 px-3.5 pt-3 pb-1 text-[12px] text-dust">
    <UserCheck size={13} className="text-tide" /><span className="flex-1">For me</span><span className="text-ash tabular-nums">{open.length}</span>
    <button aria-label="Add a task for me" data-tip="Add a task" onClick={() => setAdding(true)} className="press size-6 -mr-1.5 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-ridge"><Plus size={13} /></button>
  </div>;
  const body = <div className="px-1.5 pb-1.5">
    {open.map(task => <TaskRow key={task.id} task={task} thread={thread} />)}
    {add}
    {done.length > 0 && <><button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="press text-[11.5px] text-ash hover:text-dust h-7 px-2">{done.length} done {expanded ? '⌃' : '⌄'}</button>{expanded && done.map(task => <TaskRow key={task.id} task={task} thread={thread} />)}</>}
  </div>;
  if (rail) return <section aria-label="For me tasks" className="w-full rounded-xl surface bg-basalt overflow-hidden animate-fade max-h-[45dvh] overflow-y-auto">{head}{body}</section>;
  return <section aria-label="For me tasks" data-inline-tasks className="mx-auto w-full max-w-3xl px-4 pt-3 flex-none animate-fade"><div className="rounded-xl surface bg-basalt max-h-[35dvh] overflow-y-auto">{head}{body}</div></section>;
}
