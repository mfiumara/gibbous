import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu, Folder, Paperclip, ArrowUp, CornerLeftUp, GitBranch, ChevronDown, Server } from 'lucide-react';
import { api, type Project, type Thread } from './api';
import { useStore, toastError, NONE } from './store';
import { useAttachments, AttachmentChips, filesFrom, handOff } from './attachments';
import { useCompletions } from './thread/completions';
import { Button, IconButton, Modal, Moon, Switch, inputCls, go, ago, sourceLabel, useDraft } from './ui';

// The old single shared Home draft held already-sent text (its clear was dropped on unmount).
localStorage.removeItem('gibbous.draft.home');

// Native <select> styled as a chip: keeps keyboard/screen-reader behaviour for free.
// A <select> is as wide as its longest option (a long branch name pushed the chip off a phone screen): cap it and
// let the chosen value ellipsize.
function SelectChip({ icon, value, onChange, children, label }: { icon: React.ReactNode; value: string; onChange(v: string): void; children: React.ReactNode; label: string }) {
  return (
    <label className="press relative inline-flex items-center gap-2 h-8 pl-2.5 pr-7 max-w-full min-w-0 rounded-lg bg-ridge/60 shadow-[inset_0_1px_0_var(--surface-hi),0_1px_2px_rgb(0_0_0/.15)] hover:bg-ridge hover:border-ash/40 text-[13px] cursor-pointer">
      <span className="text-dust flex-none">{icon}</span>
      <select value={value} onChange={e => onChange(e.target.value)} aria-label={label} className="appearance-none bg-transparent focus:outline-none cursor-pointer min-w-0 max-w-56 text-ellipsis">{children}</select>
      <ChevronDown size={12} className="absolute right-2.5 text-ash pointer-events-none" />
    </label>
  );
}

export function Home({ projectId, host: hostParam, onAddProject }: { projectId?: string; host?: string; onAddProject(): void }) {
  const projects = useStore(s => s.projects);
  const threads = useStore(s => s.threads);
  const hosts = useStore(s => s.hosts);
  const snippets = useStore(s => s.settings?.snippets ?? NONE);
  const att = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const [host, setHost] = useState(hostParam ?? '');
  const [pid, setPid] = useState(projectId ?? localStorage.getItem('gibbous.lastProject') ?? '');
  const project = projects.find(p => p.id === pid);
  const [worktree, setWorktree] = useState(() => localStorage.getItem('gibbous.worktree') !== '0');
  const [base, setBase] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  useEffect(() => { if (hostParam) setHost(hostParam); }, [hostParam]);
  // Each "New" entry point (a project's +, a host's +, the plain New thread) keeps its own unsent text.
  const [text, setText] = useDraft(`home:${hostParam ? `h:${hostParam}` : projectId ?? 'none'}`);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const completions = useCompletions(text, setText, ta);

  useEffect(() => { if (projectId) setPid(projectId); }, [projectId]);
  useEffect(() => { localStorage.setItem('gibbous.lastProject', pid); setBase(''); setBranches([]); if (project?.baseBranch) api.get<string[]>(`/api/projects/${pid}/branches`).then(setBranches).catch(() => {}); }, [pid, project?.baseBranch]);
  useEffect(() => { localStorage.setItem('gibbous.worktree', worktree ? '1' : '0'); }, [worktree]);
  // Focus the box when the user asked for a new thread (#/new…: ⌘N, New thread, a project's +). Plain Home (launch, or k
  // past the first thread) leaves focus outside so j/k keep walking threads; Enter jumps into the box.
  useEffect(() => {
    const f = () => { if (location.hash.startsWith('#/new') && !matchMedia('(pointer: coarse)').matches) ta.current?.focus(); };
    f();
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  // Autosize before paint (an effect drew the old height for a frame on every new line), and keep the page's scroll
  // position: the momentary height:auto collapse otherwise clamps it and the page jumps while you type.
  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    const sc = el.closest<HTMLElement>('.overflow-y-auto'), top = sc?.scrollTop;
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 360) + 'px';
    if (sc && top != null) sc.scrollTop = top;
  }, [text]);

  const isRepo = !!project?.baseBranch;
  // A repository with no commits has no branches yet, and a worktree needs something to branch from.
  const canWorktree = isRepo && branches.length > 0;
  const recent = threads.filter(t => t.status !== 'archived').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
  const start = async () => {
    if ((!text.trim() && !att.files.length) || busy) return;
    setBusy(true);
    const sent = text;
    try {
      // With attachments or a /command the thread is created empty and its own composer sends it (one upload path, slash.exec).
      const files = att.files, viaComposer = files.length > 0 || text.trimStart().startsWith('/'), title = (text.split('\n')[0] || files[0]?.name || 'New thread').slice(0, 70);
      const t = await api.post<Thread>('/api/threads', { projectId: host ? undefined : project?.id, host: host || undefined, prompt: viaComposer ? undefined : text, worktree: !host && canWorktree && worktree, base: base || undefined, title, autoTitle: true });
      if (viaComposer) { handOff(t.id, text, files); att.clear(); }
      setText(t => t === sent ? '' : t); // keep anything typed while it was sending
      go(`/t/${t.id}`);
    } catch (e) { toastError(e); setBusy(false); }
  };

  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      <header className="relative flex items-center h-12 px-3 lg:hidden"><IconButton label="Open sidebar" onClick={() => useStore.setState({ sidebar: true })}><Menu size={17} /></IconButton></header>
      <div className="relative flex-1 overflow-y-auto overflow-x-hidden grid grid-cols-[minmax(0,1fr)] place-items-center px-4 pb-[10vh]">
        <div className="w-full min-w-0 max-w-2xl space-y-6 animate-rise">
          <h1 className="text-[32px] sm:text-[38px] leading-[1.08] font-bold tracking-[-.02em]">What should Hermes work on?</h1>

          <div className="flex flex-wrap items-center gap-2">
            {hosts.length > 0 && <SelectChip icon={<Server size={13} />} label="Host" value={host} onChange={setHost}>
              <option value="">This Mac</option>
              {hosts.map(h => <option key={h.id} value={h.id}>{h.name}{h.connected ? '' : ' (connecting)'}</option>)}
            </SelectChip>}
            {!host && <SelectChip icon={<Folder size={14} />} label="Project" value={pid} onChange={v => v === '__add' ? onAddProject() : setPid(v)}>
              <option value="">No project (home folder)</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="__add">+ Add project…</option>
            </SelectChip>}
            {!host && canWorktree && <>
              <label className="press inline-flex items-center gap-2 h-8 px-2.5 rounded-lg bg-ridge/60 shadow-[inset_0_1px_0_var(--surface-hi),0_1px_2px_rgb(0_0_0/.15)] text-[13px] cursor-pointer select-none">
                <Switch label="Isolated worktree" checked={worktree} onChange={setWorktree} />Worktree
              </label>
              {worktree && <SelectChip icon={<GitBranch size={13} />} label="Base branch" value={base} onChange={setBase}>
                <option value="">{project!.baseBranch}</option>
                {branches.filter(b => b !== project!.baseBranch && !b.startsWith('gibbous/')).map(b => <option key={b} value={b}>{b}</option>)}
              </SelectChip>}
            </>}
          </div>

          <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); att.add(filesFrom(e.dataTransfer)); }}
            className="relative surface moonlit rounded-2xl">
            {completions.list('top-full mt-2 [--origin:top]')}
            <AttachmentChips files={att.files} onRemove={att.remove} />
            <textarea ref={ta} value={text} onChange={e => setText(e.target.value)} rows={3}
              onPaste={e => { const fs = filesFrom(e.clipboardData), t = e.clipboardData.getData('text/plain'); if (fs.length && (!t || fs.some(f => f.type.startsWith('image/')))) { e.preventDefault(); att.add(fs); } }}
              onKeyDown={e => { if (completions.onKey(e)) return; if (e.key === 'Escape') { e.preventDefault(); ta.current?.blur(); return; } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !matchMedia('(pointer: coarse)').matches))) { e.preventDefault(); start(); } }}
              placeholder="Describe the task"
              aria-label="First message" className="block w-full resize-none bg-transparent px-4.5 pt-4 pb-2 text-[15.5px] leading-relaxed placeholder:text-ash focus:outline-none" />
            <div className="flex items-center gap-2 px-3 pb-3 text-[12px] text-ash">
              <>
                <input ref={fileInput} type="file" multiple hidden onChange={e => { if (e.target.files) att.add(e.target.files); e.target.value = ''; }} />
                <button aria-label="Attach files" data-tip="Attach files, or paste a screenshot" onClick={() => fileInput.current?.click()} className="press size-8 pointer-coarse:size-10 -ml-1 grid place-items-center rounded-lg text-dust hover:text-moon hover:bg-ridge flex-none"><Paperclip size={16} /></button>
              </>
              <span className="truncate font-mono">{project ? (canWorktree && worktree ? `new branch off ${base || project.baseBranch}` : project.path) : '~'}</span>
              <button onClick={start} disabled={(!text.trim() && !att.files.length) || busy} aria-label="Start thread" data-kbd="↵" data-tip="Start thread"
                className="press ml-auto size-9 grid place-items-center rounded-full bg-moon text-basalt disabled:opacity-25 shadow-[inset_0_1px_0_rgb(255_255_255/.35)] hover:shadow-[inset_0_1px_0_rgb(255_255_255/.35),0_0_0_5px_color-mix(in_srgb,var(--color-moon)_14%,transparent)]"><ArrowUp size={18} strokeWidth={2.5} /></button>
            </div>
          </div>

          {snippets.length > 0 && <div className="flex flex-wrap gap-1.5 -mt-2">{snippets.slice(0, 8).map(x => (
            <button key={x.name} onClick={() => { setText(x.text); ta.current?.focus(); }} data-tip={x.text.slice(0, 160)}
              className="press h-7 pointer-coarse:h-9 px-2.5 tile rounded-full text-[12.5px] text-dust hover:text-moon font-mono">;{x.name}</button>
          ))}</div>}
          {recent.length > 0 && <div className="space-y-2 pt-2">
            <p className="label">Pick up where you left off</p>
            <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-2 gap-2">{recent.map((t, i) => (
              <a key={t.id} href={`#/t/${t.id}`} style={{ animationDelay: `${60 + i * 40}ms` }}
                className="press animate-rise group flex items-center gap-2.5 tile rounded-xl px-3 py-2.5">
                <Moon thread={t.status} size={9} />
                <span className="flex-1 min-w-0"><span className="block truncate text-[13.5px]">{t.title}</span><span className="block truncate text-[11.5px] text-ash">{projects.find(p => p.id === t.projectId)?.name ?? (t.readOnly ? sourceLabel(t.source) : 'chat')} · {ago(t.updatedAt)}</span></span>
              </a>
            ))}</div>
          </div>}
        </div>
      </div>
    </div>
  );
}

export function AddProjectDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<{ path: string; parent: string; entries: string[]; repo: boolean }>();
  const [busy, setBusy] = useState(false);
  const browse = (p?: string) => api.get<NonNullable<typeof listing>>(`/api/fs/ls${p ? `?path=${encodeURIComponent(p)}` : ''}`).then(l => { setListing(l); setPath(l.path); }).catch(toastError);
  useEffect(() => { if (open) browse(); }, [open]);
  const add = async () => {
    setBusy(true);
    try {
      const p = await api.post<Project>('/api/projects', { path });
      localStorage.setItem('gibbous.lastProject', p.id);
      onClose();
      go(`/new/${p.id}`);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add project">
      <input className={inputCls + ' font-mono text-[13px]'} value={path} onChange={e => setPath(e.target.value)} onKeyDown={e => e.key === 'Enter' && browse(path)} aria-label="Folder path" />
      {listing && (
        <ul className="h-64 overflow-y-auto well rounded-xl p-1 text-[13px]">
          <li><button onClick={() => browse(listing.parent)} className="press w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-dust hover:bg-ridge"><CornerLeftUp size={13} />..</button></li>
          {listing.entries.map(e => <li key={e}><button onClick={() => browse(`${listing.path}/${e}`)} className="press w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-ridge text-left"><Folder size={13} className="text-dust" />{e}</button></li>)}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <span className="text-xs text-dust flex-1">{listing?.repo ? 'Git repository: threads can use worktrees.' : 'Not a git repository: threads work in place.'}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" onClick={add} disabled={!path || busy}>Add project</Button>
      </div>
    </Modal>
  );
}
