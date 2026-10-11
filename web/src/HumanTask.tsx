import { useEffect, useState } from 'react';
import { Check, UserCheck } from 'lucide-react';
import { api, type Thread } from './api';
import { useStore, toastError } from './store';
import { Modal, NO_PREDICT } from './ui';
import { openHumanTask } from '../../server/humanTasks';

export const editHumanTask = (t: Thread) => dispatchEvent(new CustomEvent('gibbous:humanTask', { detail: t.id }));
export function HumanTaskEditor() {
  const [id, setId] = useState<string>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const edit = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const t = useStore.getState().threads.find(t => t.id === id);
      if (!t) return;
      setText(openHumanTask(t) ? t.humanTask!.text : ''); setId(id);
    };
    addEventListener('gibbous:humanTask', edit); return () => removeEventListener('gibbous:humanTask', edit);
  }, []);
  const save = async () => {
    if (!id || !text.trim() || busy) return;
    setBusy(true);
    try { await api.put(`/api/threads/${id}/human-task`, { text }); setId(undefined); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return <Modal open={!!id} onClose={() => setId(undefined)} title="A task for me">
    <form onSubmit={e => { e.preventDefault(); save(); }} className="space-y-4">
      <label className="block text-sm text-dust">What do you need to do?
        <textarea {...NO_PREDICT} aria-label="Task for me" value={text} onChange={e => setText(e.target.value)} maxLength={1000} rows={3}
          placeholder="Plug in the device and check its display."
          className="mt-2 w-full resize-none rounded-xl border border-line bg-well p-3 text-moon focus:outline-none focus:border-tide/60" />
      </label>
      <div className="flex justify-end gap-2"><button type="button" onClick={() => setId(undefined)} className="press px-3 h-9 rounded-lg text-dust">Cancel</button>
        <button disabled={!text.trim() || busy} className="press px-4 h-9 rounded-lg bg-ridge text-moon disabled:opacity-40">Save task</button></div>
    </form>
  </Modal>;
}
export function TaskCheck({ thread, label }: { thread: Thread; label?: string }) {
  const [done, setDone] = useState(false);
  const finish = async () => {
    if (done) return;
    setDone(true);
    // Let the moon fill before the server broadcast removes the row.
    await new Promise(r => setTimeout(r, 180));
    try { await api.post(`/api/threads/${thread.id}/human-task/done`); }
    catch (e) { setDone(false); toastError(e); }
  };
  return <button role="checkbox" aria-checked={done} aria-label={`Complete task: ${thread.title}`} onClick={finish}
    className="press flex-none flex items-center gap-2 rounded-lg min-h-9 pointer-coarse:min-h-11 pointer-coarse:min-w-9 px-1 text-dust hover:text-moon">
    <span className={`size-5 grid place-items-center rounded-full border transition-all duration-200 ${done ? 'bg-tide border-tide text-basalt scale-110' : 'border-ash/60 hover:border-tide shadow-[inset_3px_0_0_var(--color-ridge)]'}`}><Check size={12} className={`transition-all duration-200 ${done ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`} /></span>{label}
  </button>;
}
export function HumanTaskCard({ thread }: { thread: Thread }) {
  if (!openHumanTask(thread)) return null;
  return <section aria-label="For me task" className="mx-auto w-full max-w-3xl px-4 pt-3 flex-none animate-fade">
    <div className="rounded-xl border border-tide/20 bg-crater/75 px-3.5 py-2.5">
      <p className="flex items-center gap-2 label text-tide"><UserCheck size={13} />For me</p>
      <p className="mt-1.5 text-sm text-moon whitespace-pre-wrap select-text break-words">{thread.humanTask!.text}</p>
      <div className="mt-1 flex items-center gap-3 text-[12.5px]"><TaskCheck thread={thread} label="Done" />
        <button className="press rounded-lg min-h-9 pointer-coarse:min-h-11 px-1 text-dust hover:text-moon" onClick={() => editHumanTask(thread)}>Edit</button>
        <button className="press rounded-lg min-h-9 pointer-coarse:min-h-11 px-1 text-ash hover:text-moon" onClick={() => api.del(`/api/threads/${thread.id}/human-task`).catch(toastError)}>Remove</button>
      </div>
    </div>
  </section>;
}
