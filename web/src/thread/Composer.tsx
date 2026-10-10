import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Navigation, Square, Paperclip, CornerDownLeft, Layers, MessageCircleQuestion, Mic, Headphones, Clock, X, Pencil, Play, Pause } from 'lucide-react';
import { canDictate, dictate, handsFree, setHandsFree } from '../voice';
import { Menu, MenuItem, MoonLoader, useDraft, NO_PREDICT } from '../ui';
import { useAttachments, AttachmentChips, filesFrom, takeHandoff } from '../attachments';
import { useRpc, isStaleSession, type RpcError } from '../rpc';
import { useCompletions } from './completions';
import { ModelPicker, ApprovalChip, ContextMeter } from './ModelPicker';
import type { SessionLiveInfo, Usage } from '../hermes/contract';
import { toastError, useStore, NONE } from '../store';
import { api, type Thread } from '../api';

type Queued = NonNullable<Thread['queue']>[number];

export interface EditTarget { rowId?: number; text: string }

interface Props {
  draftKey?: string;  // where the unsent text is kept (the thread id)
  sid?: string; running: boolean; autoFocus?: boolean;
  edit?: EditTarget; onCancelEdit(): void;
  onNotice(text: string): void;
  placeholder?: string;
  insert?: { text: string; n: number }; // text to append (e.g. an @file mention from the Files panel)
  dropped?: { files: File[]; n: number }; // files dropped anywhere on the thread
  onStale(): void; // Hermes reaped the live session: the view re-attaches
  onEditLast?(): void; // ↑ in an empty composer
  todos?: Record<string, unknown>[];
  onSide?(taskId: string, mode: 'btw' | 'background', text: string): void;
  onSent?(text: string): void; // shown in the timeline right away; Hermes only echoes it on resume
  info?: SessionLiveInfo; // live model/reasoning/approvals for the picker; omit to hide them
  usage?: Usage;
  compacting?: boolean;
}


const touch = matchMedia('(pointer: coarse)').matches;

export function Composer({ sid, running, autoFocus, edit, onCancelEdit, onNotice, placeholder, insert, onStale, onEditLast, todos, onSide, onSent, draftKey, dropped, info, usage, compacting }: Props) {
  const rpc = useRpc();
  const [mode, setMode] = useState<'send' | 'steer' | 'btw' | 'background'>('send');
  const [modeMenu, setModeMenu] = useState(false);
  const [listening, setListening] = useState(false);
  const [hf, setHf] = useState(handsFree.on);
  const stopDictation = useRef<() => void>(undefined);
  const submitRef = useRef<() => void>(() => {});
  const openTodos = (todos ?? []).filter((t: any) => t.status !== 'completed' && t.status !== 'cancelled');
  const todoDone = (todos ?? []).length - openTodos.length;
  // Editing a past message borrows the box; the draft underneath is kept separately.
  const [draft, setDraft] = useDraft(`t:${draftKey ?? sid ?? 'none'}`);
  const [editText, setEditText] = useState<string | null>(null);
  const text = editText ?? draft;
  const setText = (v: string | ((t: string) => string)) => { const next = typeof v === 'function' ? v(text) : v; editText !== null ? setEditText(next) : setDraft(next); };
  const att = useAttachments();
  const { files, setFiles } = att;
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useStore(s => s.toast);

  useEffect(() => { setEditText(edit ? edit.text : null); if (edit) ta.current?.focus(); }, [edit]);
  useEffect(() => { if (dropped?.files.length) { att.add(dropped.files); ta.current?.focus(); } }, [dropped]);
  useEffect(() => { if (insert) { setText(t => (t && !t.endsWith(' ') ? t + ' ' : t) + insert.text); ta.current?.focus(); } }, [insert]);
  // Never steal focus from a field you are already typing in (e.g. renaming this thread in the sidebar).
  useEffect(() => { const busy = document.activeElement?.matches("input, textarea, select, [contenteditable]"); if (autoFocus && !touch && !busy) ta.current?.focus(); }, [autoFocus, sid]);

  // Autosize is pure CSS (.grow-wrap mirrors the text into an invisible twin that sizes the grid row). The old
  // JS version collapsed the box to height:auto on every keystroke, which yanked the thread's scroll position.

  const completions = useCompletions(text, setText, ta, sid);

  const addFiles = att.add;

  // Offline (or the session isn't attached yet): hold the message and send it the moment we're back.
  const connected = useStore(s => s.connected);
  const [waiting, setWaiting] = useState(false);
  // Messages typed while a turn runs wait on the Gibbous server (server/queue.ts), editable, and go out one turn at a
  // time when a turn ends, tab open or not. A Stop pauses the line. Image messages can't wait there (images attach to
  // the session), so they go into Hermes' own queue at once and show as a fixed card until the turn ends.
  const tid = draftKey;
  const queued = useStore(s => s.threads.find(t => t.id === tid)?.queue) ?? NONE as Queued[];
  const paused = useStore(s => !!s.threads.find(t => t.id === tid)?.queuePaused);
  const [withAgent, setWithAgent] = useState<{ id: number; shown: string }[]>([]);
  const [qEdit, setQEdit] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (!sid || !withAgent.length) return;
    // The running turn ended: Hermes starts the image message now; show it as sent.
    return rpc.onSession(sid, ev => { if (ev.type === 'message.complete') { const ms = withAgent; setWithAgent([]); setTimeout(() => ms.forEach(m => onSent?.(m.shown))); } });
  }, [sid, withAgent]);
  useEffect(() => { if (qEdit && !queued.some(q => q.id === qEdit.id)) setQEdit(null); }, [queued]); // sent or removed meanwhile
  const qUrl = (q?: Queued, verb = '') => `/api/threads/${tid}/queue${q ? `/${q.id}` : ''}${verb}`;
  const qClosing = useRef(false); // Enter/Esc already closed the inline edit: the blur that follows must not save again
  const editQueued = (q: Queued) => { qClosing.current = false; setQEdit({ id: q.id, text: q.shown }); };
  const closeQueued = () => { qClosing.current = true; setQEdit(null); ta.current?.focus(); };
  // Attached @file refs lead the text Hermes gets; you edit what you typed and they stay.
  const saveQueued = (q: Queued, text: string) => {
    closeQueued();
    const refs = q.text.endsWith(q.shown) ? q.text.slice(0, q.text.length - q.shown.length) : '';
    return text.trim() && text !== q.shown ? api.patch(qUrl(q), { text: refs + text, shown: text }) : Promise.resolve();
  };
  useEffect(() => { if (!running && mode === 'steer') setMode('send'); }, [running]);
  // A first message started on Home (with attachments) arrives here and goes out as soon as the session is up.
  useEffect(() => { const h = draftKey ? takeHandoff(draftKey) : undefined; if (h) { setDraft(h.text); setFiles(h.files); setWaiting(true); } }, [draftKey]);
  useEffect(() => { if (waiting && connected && sid && !busy) { setWaiting(false); submitRef.current(); } }, [waiting, connected, sid, busy]);

  // Send now: the server stops a running turn first and sends this one right after it (then the rest, in order).
  // Mid-edit, what's in the box is what goes.
  const sendNow = (q: Queued) => (qEdit?.id === q.id ? saveQueued(q, qEdit.text) : Promise.resolve()).then(() => api.post(qUrl(q, '/now'))).catch(toastError);

  async function submit() {
    const body = text.trim();
    if ((!body && !files.length) || busy) return;
    if (!sid || !useStore.getState().connected) { setWaiting(true); return; }
    setBusy(true);
    try {
      if ((mode === 'btw' || mode === 'background') && !edit) {
        const r = await rpc.call(mode === 'btw' ? 'prompt.btw' : 'prompt.background', { session_id: sid, text: body });
        onSide?.(r.task_id, mode, body);
        setMode('send');
      } else if (body.startsWith('/') && !files.length && !edit) {
        const r = await rpc.call('slash.exec', { session_id: sid, command: body });
        const out = r.output || r.message || r.notice || r.display || r.warning;
        if (out) onNotice(out);
        if (r.type === 'send' && r.message) await rpc.call('prompt.submit', { session_id: sid, text: r.message });
      } else {
        // Images queue themselves on the session; files come back as @file: refs that must lead the message.
        const refs: string[] = [];
        for (const f of files) {
          if (f.kind === 'image') {
            const r = await rpc.call('image.attach_bytes', { session_id: sid, content_base64: f.dataUrl.split(',')[1], filename: f.name });
            if (!r.attached) throw new Error(`Couldn't attach ${f.name}`);
          } else {
            const r = await rpc.call('file.attach', { session_id: sid, data_url: f.dataUrl, name: f.name });
            if (!r.attached || !r.ref_text) throw new Error(`Couldn't attach ${f.name}`);
            refs.push(r.ref_text);
          }
        }
        const message = [refs.join('\n'), body].filter(Boolean).join('\n\n') || (files.some(f => f.kind === 'image') ? 'What do you see in this image?' : '');
        const images = files.some(f => f.kind === 'image'), shown = body || files.map(f => f.name).join(', ');
        // Mid-turn text waits in Gibbous' line (queue.ts), handed to Hermes one at a time: Hermes would merge queued
        // text into a single prompt. Images already sit on the session, so those go to Hermes now.
        if (running && mode !== 'steer' && !edit && !images && tid) {
          await api.post(qUrl(), { text: message, shown });
          setText(''); setFiles([]); completions.clear();
          return;
        }
        // Mid-turn messages queue for after the turn by default; Hermes' own default would redirect the running turn.
        // "Steer now" opts into that (Hermes' busy_input_mode decides between steer and redirect).
        const params = { session_id: sid, text: message, ...(edit?.rowId != null ? { truncate_before_row_id: edit.rowId, confirm_truncate: true } : { queued: mode !== 'steer' }) };
        // A rewind refuses while a turn runs (4009): stop it and retry, like Desktop does.
        for (let i = 0; ; i++) {
          try {
            const r = await rpc.call('prompt.submit', params);
            if (r.status === 'queued') setWithAgent(w => [...w, { id: Date.now(), shown }]);
            else if (!edit) onSent?.(shown);
            if (r.status === 'steered' || r.status === 'redirected') toast({ title: r.status === 'steered' ? 'Sent as guidance to the running turn' : 'Redirected the running turn' });
            if (mode === 'steer') setMode('send');
            break;
          } catch (e) {
            if ((e as RpcError).code !== 4009 || i > 20) throw e;
            if (i === 0) await rpc.call('session.interrupt', { session_id: sid }).catch(() => {});
            await new Promise(r => setTimeout(r, 300));
          }
        }
      }
      setText(''); setFiles([]); completions.clear();
      if (edit) onCancelEdit();
    } catch (e) {
      if (isStaleSession(e)) { onStale(); toast({ title: 'Reconnected to the session', body: 'Send your message again.' }); }
      else toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const stop = () => sid && rpc.call('session.interrupt', { session_id: sid }).catch(toastError);
  submitRef.current = submit;
  const listen = () => {
    if (listening) { stopDictation.current?.(); return; }
    const before = text ? text + ' ' : '';
    let finalText = '';
    setListening(true);
    stopDictation.current = dictate((t, final) => { setText(before + t); if (final) finalText = t; }, () => {
      setListening(false);
      // Hands-free: what you said goes straight to Hermes.
      if (handsFree.on && finalText.trim()) setTimeout(() => submitRef.current(), 50);
    });
  };
  useEffect(() => {
    const l = () => { if (!listening) listen(); };
    const h = () => setHf(handsFree.on);
    addEventListener('gibbous:listen', l); addEventListener('gibbous:handsfree', h);
    return () => { removeEventListener('gibbous:listen', l); removeEventListener('gibbous:handsfree', h); };
  });

  const onKey = (e: React.KeyboardEvent) => {
    if (completions.onKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
    // ↑ in an empty box: edit the last queued message if any, else your last sent one.
    if (e.key === 'ArrowUp' && !text && !completions.open && !edit && queued.length) { e.preventDefault(); editQueued(queued.at(-1)!); }
    else if (e.key === 'ArrowUp' && !text && !completions.open && onEditLast) { e.preventDefault(); onEditLast(); }
    // Esc backs out one step: cancel the edit or send mode, else leave the box (so j/k and Enter work). ⌘. stops a turn.
    if (e.key === 'Escape') { e.preventDefault(); if (edit) onCancelEdit(); else if (mode !== 'send') setMode('send'); else ta.current?.blur(); }
  };

  return (
    <div className="relative">
      {completions.list()}
      {(queued.length > 0 || withAgent.length > 0) && (
        <div role="status" className={`mb-2 mx-1 rounded-xl border px-3 py-2 animate-rise ${paused ? 'border-line bg-crater/70' : 'border-tide/50 bg-tide/10'}`}>
          {queued.length > 0 && <>
            <p className={`flex items-center gap-2 text-[12.5px] font-medium ${paused ? 'text-dust' : 'text-tide'}`}>
              {paused ? <Pause size={13} /> : <Clock size={13} className="animate-pulse" />}
              <span className="flex-1 min-w-0 truncate">{paused ? 'Paused · the turn was stopped' : queued.length === 1 ? 'Queued · sends when this turn finishes' : `${queued.length} queued · each goes out as its own turn, in order`}</span>
              {paused && <button type="button" onClick={() => api.post(qUrl(undefined, '/resume')).catch(toastError)} data-tip={running ? 'Resume the queue: the next message goes out when this turn finishes' : 'Resume the queue: sends the first message now'}
                className="press -my-0.5 inline-flex items-center gap-1 h-6 px-2 rounded-full text-tide hover:bg-tide/20"><Play size={11} fill="currentColor" />Resume</button>}
            </p>
            {/* One card per prompt, numbered, so queued messages never read as one long message. */}
            <ol className="mt-1.5 space-y-1">{queued.map((q, i) => (
              <li key={q.id} className={`flex items-start gap-2 rounded-lg bg-basalt/50 border pl-2 pr-1 py-1 animate-rise ${qEdit?.id === q.id ? 'border-tide/60' : paused ? 'border-line' : 'border-tide/20'}`}>
                <span className={`mt-[3px] flex-none size-4 grid place-items-center rounded-full font-mono text-[10px] tabular-nums ${paused ? 'bg-ridge text-dust' : 'bg-tide/20 text-tide'}`}>{i + 1}</span>
                {qEdit?.id === q.id
                  ? <div className="q-wrap flex-1 min-w-0" data-value={qEdit.text}>
                      <textarea autoFocus value={qEdit.text} rows={1} aria-label={`Edit queued message ${i + 1}`} {...NO_PREDICT}
                        onFocus={e => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
                        onChange={e => setQEdit({ id: q.id, text: e.target.value })} onBlur={() => { if (qClosing.current) qClosing.current = false; else if (qEdit) saveQueued(q, qEdit.text).catch(toastError); }}
                        onKeyDown={e => {
                          e.stopPropagation();
                          if (e.key === 'Escape') { e.preventDefault(); closeQueued(); }
                          else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); saveQueued(q, qEdit.text).catch(toastError); }
                        }}
                        className="block w-full resize-none bg-transparent text-moon focus:outline-none" />
                    </div>
                  : <p onDoubleClick={() => editQueued(q)} className={`flex-1 min-w-0 text-[13px] line-clamp-2 whitespace-pre-wrap select-text ${paused ? 'text-dust' : 'text-moon'}`}>{q.shown}</p>}
                {qEdit?.id !== q.id && <button type="button" aria-label="Edit" onClick={() => editQueued(q)} data-tip="Edit this message before it goes out" data-kbd={i === queued.length - 1 && !text ? '↑' : undefined}
                  className="press flex-none size-6 grid place-items-center rounded-full text-ash hover:text-moon hover:bg-ridge"><Pencil size={12} /></button>}
                <button type="button" aria-label="Send now" onMouseDown={e => e.preventDefault()} onClick={() => sendNow(q)}
                  data-tip={running ? 'Send now: stops the current turn and sends this message right away' : 'Send this message now'}
                  className="press flex-none size-6 grid place-items-center rounded-full text-tide hover:bg-tide/20"><ArrowUp size={13} strokeWidth={2.5} /></button>
                <button type="button" aria-label="Remove" onMouseDown={e => e.preventDefault()} onClick={() => { if (qEdit?.id === q.id) closeQueued(); api.del(qUrl(q)).catch(toastError); }} data-tip="Remove this message from the queue"
                  className="press flex-none size-6 grid place-items-center rounded-full text-ash hover:text-moon hover:bg-ridge"><X size={13} /></button>
              </li>
            ))}</ol>
          </>}
          {withAgent.length > 0 && <>
            <p className={`flex items-center gap-2 text-[12.5px] font-medium text-tide ${queued.length ? 'mt-2' : ''}`}><Clock size={13} className="animate-pulse" />With the agent · runs after this turn</p>
            <ol className="mt-1.5 space-y-1">{withAgent.map(m => (
              <li key={m.id} className="flex items-start gap-2 rounded-lg bg-basalt/50 border border-tide/20 px-2 py-1 animate-rise" data-tip="Has images, so it already sits with Hermes and can't be edited">
                <Paperclip size={12} className="mt-[4px] flex-none text-tide" /><p className="flex-1 min-w-0 text-[13px] line-clamp-2 whitespace-pre-wrap select-text text-moon">{m.shown}</p>
              </li>
            ))}</ol>
          </>}
        </div>
      )}
      {!!openTodos.length && running && (
        <div className="mb-2 mx-1 rounded-xl border border-line bg-crater/70 px-3 py-2 animate-rise">
          <p className="label mb-1">Plan · {todoDone}/{todos!.length}</p>
          <ul className="space-y-0.5 text-[12.5px]">{openTodos.slice(0, 3).map((t: any, i) => (
            <li key={t.id ?? i} className={`flex gap-2 ${t.status === 'in_progress' ? 'text-moon' : 'text-dust'}`}><span className={`mt-[7px] size-1.5 flex-none rounded-full ${t.status === 'in_progress' ? 'bg-tide animate-pulse' : 'bg-ash'}`} /><span className="truncate">{String(t.content ?? t.text ?? '')}</span></li>
          ))}</ul>
        </div>
      )}
      <div className={`surface rounded-2xl ${edit ? 'shadow-[inset_0_1px_0_var(--surface-hi),0_0_0_2px_color-mix(in_srgb,var(--color-halo)_45%,transparent),var(--shadow)]' : 'moonlit'}`}>
        {edit && <div className="flex items-center gap-2 px-3.5 pt-2.5 text-xs text-halo animate-fade"><CornerDownLeft size={12} /> Editing: everything from this message on will be replaced. <button className="ml-auto text-dust hover:text-moon" onClick={onCancelEdit}>Cancel</button></div>}
        {mode !== 'send' && !edit && <div className="flex items-center gap-2 px-3.5 pt-2.5 text-xs text-tide animate-fade">{mode === 'btw' ? <MessageCircleQuestion size={12} /> : mode === 'steer' ? <Navigation size={12} /> : <Layers size={12} />}{mode === 'btw' ? 'Side question: answered separately, the main turn keeps going.' : mode === 'steer' ? 'Steer now: goes into the running turn instead of waiting for it to finish.' : 'Background task: runs on its own and reports back here.'}<button className="ml-auto text-dust hover:text-moon" onClick={() => setMode('send')}>Cancel</button></div>}
        {waiting && <p className="flex items-center gap-2 px-3 pt-2 text-[12.5px] text-halo animate-fade" role="status"><MoonLoader size={14} label="Waiting" />Waiting for the connection, sends automatically<button onClick={() => setWaiting(false)} className="press ml-auto text-dust hover:text-moon">Cancel</button></p>}
        <AttachmentChips files={files} onRemove={att.remove} />
        <div className="grow-wrap" data-value={text}>
        <textarea ref={ta} value={text} rows={1} onChange={e => setText(e.target.value)} onKeyDown={onKey} {...NO_PREDICT}
          onPaste={e => {
            // Screenshots and copied images attach; copied text (even with a file icon, e.g. from Finder) stays text.
            const fs = filesFrom(e.clipboardData);
            const text = e.clipboardData.getData('text/plain');
            if (fs.length && (!text || fs.some(f => f.type.startsWith('image/')))) { e.preventDefault(); addFiles(fs); }
          }}
          placeholder={placeholder ?? (mode === 'btw' ? 'Ask something on the side…' : mode === 'background' ? 'Describe the background task…' : mode === 'steer' ? 'Steer the running turn…' : running ? (touch ? 'Queue a follow-up…' : 'Queue a follow-up — sends when this turn finishes') : touch ? 'Message the agent' : 'Message the agent — / for commands, @ for files')}
          aria-label="Message"
          className="grow-text block w-full resize-none bg-transparent placeholder:text-ash focus:outline-none" />
        </div>
        {/* Round buttons never shrink (they went oval on a phone); the model name is what gives way. */}
        <div className="flex items-center gap-0.5 sm:gap-1 px-2 pb-2 min-w-0">
          <input ref={fileInput} type="file" multiple hidden onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          <button aria-label="Attach files" data-tip="Attach files" onClick={() => fileInput.current?.click()} className="press size-8 flex-none grid place-items-center rounded-lg text-dust hover:text-moon hover:bg-ridge"><Paperclip size={16} /></button>
          <div className="relative flex-none">
            <button aria-label="Send mode" data-tip="Side question or background task" aria-expanded={modeMenu} onClick={() => setModeMenu(!modeMenu)} className={`press size-8 flex-none grid place-items-center rounded-lg hover:bg-ridge ${mode !== 'send' ? 'text-tide' : 'text-dust hover:text-moon'}`}><Layers size={15} /></button>
            <Menu open={modeMenu} onClose={() => setModeMenu(false)} align="left" side="top">
              <MenuItem icon={<ArrowUp />} onClick={() => { setMode('send'); setModeMenu(false); }}>{running ? 'Queue for after this turn' : 'Send as the next turn'}</MenuItem>
              {running && <MenuItem icon={<Navigation />} onClick={() => { setMode('steer'); setModeMenu(false); ta.current?.focus(); }}>Steer the running turn now</MenuItem>}
              <MenuItem icon={<MessageCircleQuestion />} onClick={() => { setMode('btw'); setModeMenu(false); ta.current?.focus(); }}>Ask on the side (/btw)</MenuItem>
              <MenuItem icon={<Layers />} onClick={() => { setMode('background'); setModeMenu(false); ta.current?.focus(); }}>Run in the background</MenuItem>
              {canDictate && <><div className="my-1 h-px bg-line" /><MenuItem icon={<Headphones />} onClick={() => { setHandsFree(!hf); setModeMenu(false); }} kbd={hf ? 'on' : 'off'}>Hands-free voice</MenuItem></>}
            </Menu>
          </div>
          {sid && info !== undefined && <><ModelPicker info={info} sid={sid} /><ApprovalChip info={info} sid={sid} /></>}
          <span className="ml-auto" />
          {(usage?.context_percent != null || compacting) && <ContextMeter usage={usage} compacting={compacting} />}
          {canDictate && <button onClick={listen} aria-label={listening ? 'Stop dictation' : 'Dictate'} aria-pressed={listening} data-tip={listening ? 'Listening… click to stop' : 'Dictate'}
            className={`press relative size-8 flex-none grid place-items-center rounded-full ${listening ? 'bg-oxide/15 text-oxide' : 'text-dust hover:text-moon hover:bg-ridge'}`}>
            {listening && <span className="absolute inset-0 rounded-full border border-oxide/60 animate-pulse" />}<Mic size={16} />
          </button>}
          {running && <button onClick={stop} aria-label="Stop" data-tip="Stop" data-kbd="⌘." className="press size-8 flex-none grid place-items-center rounded-full border border-line text-moon hover:bg-ridge animate-pop"><Square size={11} fill="currentColor" /></button>}
          <button onClick={submit} disabled={!sid || busy || (!text.trim() && !files.length)} aria-label="Send" data-tip="Send" data-kbd="↵"
            className="press size-8 flex-none grid place-items-center rounded-full bg-moon text-basalt disabled:opacity-25 shadow-[inset_0_1px_0_rgb(255_255_255/.35)] hover:shadow-[inset_0_1px_0_rgb(255_255_255/.35),0_0_0_4px_color-mix(in_srgb,var(--color-moon)_14%,transparent)]"><ArrowUp size={17} strokeWidth={2.5} /></button>
        </div>
      </div>
    </div>
  );
}
