import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu, Folder, FolderPlus, Paperclip, ArrowUp, CornerLeftUp, GitBranch, ChevronDown, Server, KanbanSquare, History, CalendarClock, Users, Gauge } from 'lucide-react';
import { api, type Project, type Thread } from './api';
import { useStore, toastError, NONE } from './store';
import { useAttachments, AttachmentChips, filesFrom, handOff } from './attachments';
import { useCompletions } from './thread/completions';
import { EffortPicker, ModelPicker, type ModelDraft } from './thread/ModelPicker';
import { Button, IconButton, Modal, Moon, Switch, inputCls, go, ago, sourceLabel, useDraft, NO_PREDICT } from './ui';
import { haptic } from './iosBridge';
import { useUsage } from './useUsage';
import { activeSpace, inSpace } from '../../server/spaces';
import { glance } from './usage';

// The old single shared Home draft held already-sent text (its clear was dropped on unmount).
localStorage.removeItem('gibbous.draft.home');

// Native <select> styled as a chip: keeps keyboard/screen-reader behaviour for free.
// A <select> is as wide as its longest option (a long branch name pushed the chip off a phone screen): cap it and
// let the chosen value ellipsize.
function SelectChip({ icon, value, onChange, children, label }: { icon: React.ReactNode; value: string; onChange(v: string): void; children: React.ReactNode; label: string }) {
  return (
    <label className="press relative inline-flex items-center gap-2 h-8 pl-2.5 pr-7 max-w-full min-w-0 rounded-lg bg-ridge/60 shadow-[inset_0_1px_0_var(--surface-hi),0_1px_2px_rgb(0_0_0/.15)] hover:bg-ridge hover:border-ash/40 text-[13px]">
      <span className="text-dust flex-none">{icon}</span>
      <select value={value} onChange={e => onChange(e.target.value)} aria-label={label} className="appearance-none bg-transparent focus:outline-none min-w-0 max-w-56 text-ellipsis">{children}</select>
      <ChevronDown size={12} className="absolute right-2.5 text-ash pointer-events-none" />
    </label>
  );
}

const PLACES: [string, string, typeof KanbanSquare][] = [['#/kanban', 'Kanban', KanbanSquare], ['#/sessions', 'Sessions', History], ['#/automations', 'Automations', CalendarClock], ['#/rooms', 'Rooms', Users], ['#/settings/usage', 'Usage', Gauge]];

export function Home({ projectId, host: hostParam, onAddProject }: { projectId?: string; host?: string; onAddProject(): void }) {
  const projects = useStore(s => s.projects);
  const threads = useStore(s => s.threads);
  const spaces = useStore(s => s.settings?.spaces ?? NONE);
  const storedSpace = useStore(s => s.activeSpace);
  const space = activeSpace(storedSpace, spaces);
  const scopedProjects = projects.filter(p => inSpace(p, space));
  const hosts = useStore(s => s.hosts);
  const snippets = useStore(s => s.settings?.snippets ?? NONE);
  const att = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const [host, setHost] = useState(hostParam ?? '');
  const [pid, setPid] = useState(() => {
    const last = localStorage.getItem('gibbous.lastProject') ?? '';
    return projectId ?? (scopedProjects.some(p => p.id === last) ? last : space ? scopedProjects[0]?.id ?? '' : '');
  });
  const previousSpace = useRef(space);
  useEffect(() => {
    if (previousSpace.current !== space && projectId == null) setPid(scopedProjects[0]?.id ?? '');
    previousSpace.current = space;
  }, [space, projectId, scopedProjects]);
  const project = projects.find(p => p.id === pid);
  const [worktree, setWorktree] = useState(() => localStorage.getItem('gibbous.worktree') !== '0');
  // Model + effort for the new thread; the last pick sticks on this device (empty = Hermes' default).
  const [mdv, setMdv] = useState<Omit<ModelDraft, 'set'>>(() => { try { return JSON.parse(localStorage.getItem('gibbous.newModel') ?? '{}'); } catch { return {}; } });
  const md: ModelDraft = { ...mdv, set: p => setMdv(v => { const n = { ...v, ...p }; localStorage.setItem('gibbous.newModel', JSON.stringify(n)); return n; }) };
  const [base, setBase] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  useEffect(() => { if (hostParam) setHost(hostParam); }, [hostParam]);
  // Each "New" entry point (a project's +, a host's +, the plain New thread) keeps its own unsent text.
  const [text, setText] = useDraft(`home:${hostParam ? `h:${hostParam}` : projectId || 'none'}`);
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const completions = useCompletions(text, setText, ta);

  useEffect(() => { if (projectId != null) setPid(projectId); }, [projectId]);
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
  const recent = threads.filter(t => t.status !== 'archived' && inSpace(projects.find(p => p.id === t.projectId), space)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
  const start = async () => {
    if ((!text.trim() && !att.files.length) || busy) return;
    haptic('send');
    setBusy(true);
    const sent = text;
    try {
      // With attachments or a /command the thread is created empty and its own composer sends it (one upload path, slash.exec).
      const files = att.files, viaComposer = files.length > 0 || text.trimStart().startsWith('/'), title = (text.split('\n')[0] || files[0]?.name || 'New thread').slice(0, 70);
      const t = await api.post<Thread>('/api/threads', { ...(host ? {} : { model: md.model, provider: md.provider, effort: md.effort }), projectId: host ? undefined : project?.id, space: project ? undefined : useStore.getState().activeSpace || undefined, host: host || undefined, prompt: viaComposer ? undefined : text, worktree: !host && canWorktree && worktree, base: base || undefined, title, autoTitle: true });
      if (viaComposer) { handOff(t.id, text, files); att.clear(); }
      setText(t => t === sent ? '' : t); // keep anything typed while it was sending
      go(`/t/${t.id}`);
    } catch (e) { toastError(e); setBusy(false); }
  };

  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      <header data-drag-window className="relative flex items-center h-12 px-3 lg:hidden"><IconButton label="Open sidebar" onClick={() => useStore.setState({ sidebar: true })}><Menu size={17} /></IconButton></header>
      <div className="relative flex-1 overflow-y-auto overflow-x-hidden grid grid-cols-[minmax(0,1fr)] place-items-center px-4 pb-[10vh]">
        <div className="w-full min-w-0 max-w-2xl space-y-6 animate-rise">
          <h1 className="text-[32px] sm:text-[38px] leading-[1.08] font-bold tracking-[-.02em]">What should we work on?</h1>

          <div className="flex flex-wrap items-center gap-2">
            {hosts.length > 0 && <SelectChip icon={<Server size={13} />} label="Host" value={host} onChange={setHost}>
              <option value="">This Mac</option>
              {hosts.map(h => <option key={h.id} value={h.id}>{h.name}{h.connected ? '' : ' (connecting)'}</option>)}
            </SelectChip>}
            {!host && <SelectChip icon={<Folder size={14} />} label="Project" value={pid} onChange={v => v === '__add' ? onAddProject() : setPid(v)}>
              <option value="">No project (home folder)</option>
              {scopedProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              {space && projects.some(p => !inSpace(p, space)) && <optgroup label="Other spaces">
                {projects.filter(p => !inSpace(p, space)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>}
              <option value="__add">+ Add project…</option>
            </SelectChip>}
            {!host && canWorktree && <>
              <label className="press inline-flex items-center gap-2 h-8 px-2.5 rounded-lg bg-ridge/60 shadow-[inset_0_1px_0_var(--surface-hi),0_1px_2px_rgb(0_0_0/.15)] text-[13px] select-none">
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
            <textarea ref={ta} value={text} onChange={e => setText(e.target.value)} rows={3} {...NO_PREDICT}
              onPaste={e => { const fs = filesFrom(e.clipboardData), t = e.clipboardData.getData('text/plain'); if (fs.length && (!t || fs.some(f => f.type.startsWith('image/')))) { e.preventDefault(); att.add(fs); } }}
              onKeyDown={e => { if (completions.onKey(e)) return; if (e.key === 'Escape') { e.preventDefault(); ta.current?.blur(); return; } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !matchMedia('(pointer: coarse)').matches))) { e.preventDefault(); start(); } }}
              placeholder="Describe the task"
              aria-label="First message" className="block w-full resize-none bg-transparent px-4.5 pt-4 pb-2 text-[15.5px] leading-relaxed placeholder:text-ash focus:outline-none" />
            <div className="flex items-center gap-2 px-3 pb-3 text-[12px] text-ash">
              <>
                <input ref={fileInput} type="file" multiple hidden onChange={e => { if (e.target.files) att.add(e.target.files); e.target.value = ''; }} />
                <button aria-label="Attach files" data-tip="Attach files, or paste a screenshot" onClick={() => fileInput.current?.click()} className="press size-8 pointer-coarse:size-10 -ml-1 grid place-items-center rounded-lg text-dust hover:text-moon hover:bg-ridge flex-none"><Paperclip size={16} /></button>
              </>
              {!host && <><ModelPicker draft={md} /><EffortPicker draft={md} /></>}
              <span className="truncate font-mono">{project ? (canWorktree && worktree ? `new branch off ${base || project.baseBranch}` : project.path) : '~'}</span>
              <button onClick={start} disabled={(!text.trim() && !att.files.length) || busy} aria-label="Start thread" data-kbd="↵" data-tip="Start thread"
                className="press ml-auto size-9 grid place-items-center rounded-full bg-moon text-basalt disabled:opacity-25 shadow-[inset_0_1px_0_rgb(255_255_255/.35)] hover:shadow-[inset_0_1px_0_rgb(255_255_255/.35),0_0_0_5px_color-mix(in_srgb,var(--color-moon)_14%,transparent)]"><ArrowUp size={18} strokeWidth={2.5} /></button>
            </div>
          </div>

          {snippets.length > 0 && <div className="flex flex-wrap gap-1.5 -mt-2">{snippets.slice(0, 8).map(x => (
            <button key={x.name} onClick={() => { setText(x.text); ta.current?.focus(); }} data-tip={x.text.slice(0, 160)}
              className="press h-7 pointer-coarse:h-9 px-2.5 tile rounded-full text-[12.5px] text-dust hover:text-moon font-mono">;{x.name}</button>
          ))}</div>}
          {/* Places: everything the sidebar corner may not show (it's configurable), one tap away. */}
          <nav aria-label="Places" className="flex flex-wrap gap-1.5 pt-1">{PLACES.map(([href, label, Icon]) => (
            <a key={href} href={href} className="press inline-flex items-center gap-1.5 h-7 pointer-coarse:h-9 px-2.5 tile rounded-full text-[12.5px] text-dust hover:text-moon"><Icon size={13} />{label}</a>
          ))}</nav>
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
      <UsageGlance />
    </div>
  );
}

// One quiet line pinned to the bottom of the screen (outside the centred column, so it never moves the composer),
// linking to Settings → Usage. Hidden when there's nothing to say or the window is short (phone keyboard open).
function UsageGlance() {
  const g = glance(useUsage('7'));
  if (!g) return null;
  return <a href="#/settings/usage" data-tip="Open usage"
    className="press animate-fade absolute bottom-[max(.9rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 max-w-[calc(100%-2rem)] truncate whitespace-nowrap px-3 py-1 rounded-full text-[12px] text-ash hover:text-dust tabular-nums [@media(max-height:560px)]:hidden">
    {g.tokens}{g.model && <span className="hidden sm:inline"> · {g.model}</span>}{g.cost && <> · {g.cost}</>}
  </a>;
}

export function AddProjectDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<{ path: string; parent: string; entries: string[]; repo: boolean }>();
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState<string | null>(null); // null: not naming a new folder
  const mkdir = () => {
    const name = newName?.trim();
    if (!listing || !name) return setNewName(null);
    api.post<{ path: string }>('/api/fs/mkdir', { path: listing.path, name }).then(r => { setNewName(null); browse(r.path); }).catch(toastError);
  };
  const browse = (p?: string) => api.get<NonNullable<typeof listing>>(`/api/fs/ls${p ? `?path=${encodeURIComponent(p)}` : ''}`).then(l => { setListing(l); setPath(l.path); }).catch(toastError);
  useEffect(() => { if (open) browse(); }, [open]);
  const add = async () => {
    setBusy(true);
    try {
      const p = await api.post<Project>('/api/projects', { path });
      const s = useStore.getState();
      const space = activeSpace(s.activeSpace, s.settings?.spaces ?? []);
      if (space && !p.space) await api.patch(`/api/projects/${p.id}`, { space });
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
          <li className="flex items-center gap-1">
            <button onClick={() => browse(listing.parent)} className="press flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-dust hover:bg-ridge"><CornerLeftUp size={13} />..</button>
            <button onClick={() => setNewName('')} className="press flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-dust hover:text-moon hover:bg-ridge"><FolderPlus size={13} />New folder</button>
          </li>
          {newName !== null && <li className="flex items-center gap-2 px-2.5 py-1">
            <FolderPlus size={13} className="text-tide flex-none" />
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="Folder name" aria-label="New folder name"
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); mkdir(); } if (e.key === 'Escape') { e.stopPropagation(); setNewName(null); } }}
              onBlur={() => !newName?.trim() && setNewName(null)}
              className="flex-1 min-w-0 h-7 px-2 rounded-md bg-transparent border border-tide/50 focus:outline-none text-[13px]" />
            <Button onClick={mkdir} disabled={!newName.trim()}>Create</Button>
          </li>}
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
