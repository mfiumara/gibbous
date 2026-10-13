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
  return <button role="checkbox" aria-checked={done} aria-label={`${done ? 'Reopen' : 'Complete'} task: ${task.text}`} disabled={busy} onClick={async () => { setBusy(true); try { await api.patch(`/api/threads/${thread.id}/human-tasks/${task.id}`, { done: !done }); } catch (e) { toastError(e); } finally { setBusy(false); } }} className="press group/ck flex-none grid place-items-center size-6 -ml-1 pointer-coarse:size-9 rounded-full">
    <span className={`size-[15px] grid place-items-center rounded-full border transition-all duration-200 ${done ? 'bg-tide border-tide text-basalt' : 'border-ash/55 group-hover/ck:border-tide group-hover/ck:bg-tide/10'}`}><Check size={9} strokeWidth={3.2} className={`transition-opacity ${done ? 'opacity-100' : 'opacity-0 group-hover/ck:opacity-60 group-hover/ck:text-tide'}`} /></span>
  </button>;
}

// Agents write tasks like "#1796 test 2: Paste the seed SQL …": the lead becomes a small tag, the rest the task.
const LEAD = /^((?:#\d+|[A-Z][\w-]*)(?:\s+[\w#.-]+){0,2}):\s+(.+)$/s;
export const splitTask = (text: string) => { const m = LEAD.exec(text.trim()); return m && m[1].length <= 24 ? { tag: m[1], body: m[2] } : { tag: '', body: text.trim() }; };
// Links and long tokens (URLs, ENV_NAMES) shown short and clickable instead of wrapping the card into a column.
function TaskText({ text }: { text: string }) {
  return <>{text.split(/(https?:\/\/\S+|(?:github\.com|[\w-]+\.vercel\.app)\/\S+)/g).map((part, i) => {
    if (!(i % 2)) return <span key={i} className="[overflow-wrap:anywhere]">{part}</span>;
    const url = part.replace(/[).,;]+$/, ''), tail = part.slice(url.length);
    return <span key={i}><a href={url.startsWith('http') ? url : `https://${url}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-tide hover:underline break-all">{url.replace(/^https?:\/\//, '').replace(/^github\.com\/[^/]+\/[^/]+\//, '').slice(0, 32)}</a>{tail}</span>;
  })}</>;
}

function TaskRow({ thread, task }: { thread: Thread; task: HumanTask }) {
  const [edit, setEdit] = useState(false); const [text, setText] = useState(task.text); const [open, setOpen] = useState(false);
  const save = async () => { if (!text.trim()) return; try { await api.patch(`/api/threads/${thread.id}/human-tasks/${task.id}`, { text }); setEdit(false); } catch (e) { toastError(e); } };
  const done = task.doneAt != null, { tag, body } = splitTask(task.text);
  return <li id={`human-task-${task.id}`} tabIndex={-1} className="group/task relative flex items-start gap-2 px-3 py-2 focus:outline-none focus:bg-ridge/50 hover:bg-ridge/30 transition-colors">
    <span className="pt-px"><TaskCheck thread={thread} task={task} /></span>
    {edit ? <form className="flex-1 min-w-0" onSubmit={e => { e.preventDefault(); save(); }}>
        <textarea {...NO_PREDICT} autoFocus aria-label="Edit task" value={text} maxLength={1000} rows={3} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEdit(false); setText(task.text); } }}
          onBlur={save} className="w-full resize-none bg-well rounded-md border border-line px-2 py-1 text-[12.5px] leading-snug text-moon focus:outline-none focus:border-tide/50" />
      </form>
      : <button type="button" onClick={() => setOpen(!open)} onDoubleClick={() => { setText(task.text); setEdit(true); }} aria-expanded={open} title={open ? undefined : task.text}
          className={`flex-1 min-w-0 text-left text-[12.5px] leading-[1.45] select-text ${done ? 'text-ash line-through' : 'text-moon/90'}`}>
          {tag && <span className="block mb-0.5 font-mono text-[10.5px] tracking-tight text-ash">{tag}</span>}
          <span className={open ? '' : 'line-clamp-2'}><TaskText text={body} /></span>
        </button>}
    {!edit && <div className="absolute right-1.5 top-1.5 flex rounded-md bg-basalt/95 shadow-[0_0_0_1px_var(--color-line)] opacity-0 group-hover/task:opacity-100 group-focus-within/task:opacity-100 pointer-coarse:hidden transition-opacity">
      <button aria-label={`Edit task: ${task.text}`} onClick={() => { setText(task.text); setEdit(true); }} className="press size-6 grid place-items-center text-ash hover:text-moon"><Pencil size={11} /></button>
      <button aria-label={`Remove task: ${task.text}`} onClick={() => api.del(`/api/threads/${thread.id}/human-tasks/${task.id}`).catch(toastError)} className="press size-6 grid place-items-center text-ash hover:text-oxide"><X size={12} /></button>
    </div>}
  </li>;
}

// The thread's "For me" checklist. `rail`: a card in the right gutter under the pull requests (wide screens);
// otherwise a slim card above the conversation. Gone when nothing is left to do.
const SHOWN = 4, SHOWN_INLINE = 2;  // above the chat it stays short so the conversation keeps the room
export function HumanTaskCard({ thread, rail = false }: { thread: Thread; rail?: boolean }) {
  const tasks = humanTasks(thread); const [all, setAll] = useState(false); const [showDone, setShowDone] = useState(false); const [adding, setAdding] = useState(false); const [text, setText] = useState('');
  const open = tasks.filter(task => task.doneAt == null), done = tasks.filter(task => task.doneAt != null);
  if (!open.length && !adding) return null;
  const cap = rail ? SHOWN : SHOWN_INLINE, visible = all ? open : open.slice(0, cap), more = open.length - visible.length;
  const submit = async () => { if (!text.trim()) return; try { await api.post(`/api/threads/${thread.id}/human-tasks`, { text }); setText(''); setAdding(false); } catch (e) { toastError(e); } };
  const card = <div className="rounded-xl surface bg-basalt overflow-hidden">
    <div className="flex items-center gap-2 pl-3.5 pr-2 h-10 text-[12px] text-dust">
      <UserCheck size={13} className="text-tide" /><span className="flex-1">For me</span>
      <span className="text-ash tabular-nums" data-tip={`${done.length} of ${tasks.length} done`}>{open.length} left</span>
      <button aria-label="Add a task for me" data-tip="Add a task" onClick={() => setAdding(true)} className="press size-6 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-ridge"><Plus size={13} /></button>
    </div>
    {/* Progress: how much of this thread's list is done. */}
    <div className="mx-3.5 h-px bg-line relative"><span className="absolute inset-y-0 left-0 bg-tide/70 transition-[width] duration-500" style={{ width: `${tasks.length ? done.length / tasks.length * 100 : 0}%` }} /></div>
    <ol aria-label="Open tasks" className={`py-1 ${rail ? 'max-h-[55dvh]' : 'max-h-[32dvh]'} overflow-y-auto`}>
      {visible.map(task => <TaskRow key={task.id} task={task} thread={thread} />)}
      {showDone && done.map(task => <TaskRow key={task.id} task={task} thread={thread} />)}
    </ol>
    {adding && <form className="px-3 pb-2" onSubmit={e => { e.preventDefault(); submit(); }}><input {...NO_PREDICT} autoFocus value={text} onChange={e => setText(e.target.value)} maxLength={1000} aria-label="New task" placeholder="Something for me to do…" onBlur={() => { if (!text.trim()) setAdding(false); }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(false); } }} className="w-full h-8 rounded-lg bg-well border border-line px-2.5 text-[12.5px] text-moon focus:outline-none focus:border-tide/50" /></form>}
    {(more > 0 || all && open.length > cap || done.length > 0) && <div className="flex items-center gap-3 px-3.5 h-8 border-t border-line text-[11.5px] text-ash">
      {more > 0 ? <button onClick={() => setAll(true)} className="press hover:text-moon">{more} more</button> : open.length > cap && <button onClick={() => setAll(false)} className="press hover:text-moon">Show less</button>}
      <span className="flex-1" />
      {done.length > 0 && <button onClick={() => setShowDone(!showDone)} aria-expanded={showDone} className="press hover:text-moon">{showDone ? 'Hide done' : `${done.length} done`}</button>}
    </div>}
  </div>;
  if (rail) return <section aria-label="For me tasks" className="w-full animate-fade">{card}</section>;
  return <section aria-label="For me tasks" data-inline-tasks className="mx-auto w-full max-w-3xl px-4 pt-3 flex-none animate-fade">{card}</section>;
}
