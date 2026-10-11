import { useEffect, useRef, useState } from 'react';
import { Menu as MenuIcon, Server, GitBranch, MoreHorizontal, GitFork, Archive, Trash2, ArchiveRestore, FileDown, Link2, FileCode, LayoutGrid } from 'lucide-react';
import { api, type Thread } from '../api';
import { useStore, toastError, archiveWithUndo, deleteWithUndo } from '../store';
import { Moon, IconButton, Menu, MenuItem, Elapsed } from '../ui';
import type { Timeline } from './timeline';
import { thisMachine } from '../paths';
import { editHumanTask } from '../HumanTask';
import { UserCheck as CheckTaskIcon } from 'lucide-react';
import { openHumanTask } from '../../../server/humanTasks';

export interface PanelDef { id: string; label: string; icon: React.ComponentType<{ size?: number }> }

const EXTRA = new Set(['preview', 'processes', 'screen']);

function Title({ thread }: { thread: Thread }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(thread.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.select(); else setV(thread.title); }, [editing, thread.title]);
  const save = () => { setEditing(false); if (v.trim() && v.trim() !== thread.title) api.patch(`/api/threads/${thread.id}`, { title: v.trim() }).catch(toastError); };
  if (editing) return <input ref={ref} value={v} onChange={e => setV(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
    aria-label="Thread title" className="font-bold bg-transparent border-b border-tide/60 focus:outline-none min-w-0 flex-1 max-w-md" />;
  return <button onClick={() => setEditing(true)} className="font-bold truncate min-w-[5rem] shrink text-left pointer-coarse:py-2 hover:text-moon/80 transition-colors" data-tip="Rename">{thread.title}</button>;
}

export function ThreadHeader({ thread, tl, panels, panel, setPanel, onBranch, onExport }: {
  thread: Thread; tl: Timeline; panels: PanelDef[]; panel: string | null; setPanel(p: string | null): void; onBranch(): void; onExport(kind: 'md' | 'html' | 'share'): void;
}) {
  const [menu, setMenu] = useState(false);
  const [more, setMore] = useState(false);
  const archive = async () => {
    setMenu(false);
    // Removing a worktree can't be undone, so that one still asks; a plain archive gets an Undo toast.
    const removeWorktree = !!thread.worktree && confirm('Also remove this thread\'s worktree? Uncommitted changes there will be lost.');
    if (removeWorktree) await api.post(`/api/threads/${thread.id}/archive`, { removeWorktree }).then(() => { location.hash = '/'; }, toastError);
    else archiveWithUndo(thread);
  };
  const remove = () => {
    setMenu(false);
    const removeWorktree = !!thread.worktree && confirm('Also remove its worktree? Uncommitted changes there will be lost. Cancel keeps the files.');
    deleteWithUndo(thread, removeWorktree);
  };
  return (<>
    <header data-drag-window className="relative z-20 flex items-center gap-2 px-3 h-12 border-b border-line flex-none bg-basalt/85">
      <IconButton label="Open sidebar" className="lg:hidden" onClick={() => useStore.setState({ sidebar: true })}><MenuIcon size={17} /></IconButton>
      <Moon thread={thread.status} size={11} />
      <Title thread={thread} />
      {tl.running && tl.turnStartedAt && <Elapsed since={tl.turnStartedAt} className="flex-none text-[12px] text-tide font-mono" />}
      {thread.host && <HostChip id={thread.host} />}
      {thread.worktree && <span className={`hidden ${panel ? '2xl:inline-flex' : 'lg:inline-flex'} items-center gap-1 font-mono text-[12px] text-ash px-1.5 truncate min-w-0 whitespace-nowrap`} data-tip={`Worktree off ${thread.worktree.base}`}><GitBranch size={12} />{thread.worktree.branch.replace(/^gibbous\//, '')}</span>}
      <div className="ml-auto flex items-center gap-0.5 flex-none">
        {/* Everyday panels as icons; the rest (preview, processes, screen) behind one menu. Phones: all of them in the menu. */}
        <span className="hidden sm:contents">{panels.filter(p => !EXTRA.has(p.id) || p.id === panel).map(p => (
          <IconButton key={p.id} label={p.label} kbd={p.id === 'changes' ? '⌘\\' : undefined} aria-pressed={panel === p.id} onClick={() => setPanel(panel === p.id ? null : p.id)}><p.icon size={16} /></IconButton>
        ))}</span>
        <div className="relative">
          <IconButton label="Panels" aria-expanded={more} onClick={() => setMore(!more)}><LayoutGrid size={15} /></IconButton>
          <Menu open={more} onClose={() => setMore(false)}>{panels.map(p => <div key={p.id} className={EXTRA.has(p.id) ? '' : 'sm:hidden'}><MenuItem icon={<p.icon />} onClick={() => { setMore(false); setPanel(p.id); }}>{p.label}</MenuItem></div>)}</Menu>
        </div>
        <div className="relative">
          <IconButton label="More" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={17} /></IconButton>
          <Menu open={menu} onClose={() => setMenu(false)}>
            <MenuItem icon={<CheckTaskIcon />} onClick={() => { setMenu(false); editHumanTask(thread); }}>{openHumanTask(thread) ? 'Edit my task…' : 'Add a task for me…'}</MenuItem>
            <MenuItem icon={<GitFork />} onClick={() => { setMenu(false); onBranch(); }}>Branch conversation</MenuItem>
            <MenuItem icon={<FileDown />} onClick={() => { setMenu(false); onExport('md'); }}>Export as Markdown</MenuItem>
            <MenuItem icon={<FileCode />} onClick={() => { setMenu(false); onExport('html'); }}>Export as HTML</MenuItem>
            <MenuItem icon={<Link2 />} onClick={() => { setMenu(false); onExport('share'); }}>Share read-only link</MenuItem>
            {thread.status === 'archived'
              ? <MenuItem icon={<ArchiveRestore />} onClick={() => { setMenu(false); api.patch(`/api/threads/${thread.id}`, { status: 'idle' }).catch(toastError); }}>Unarchive</MenuItem>
              : <MenuItem icon={<Archive />} onClick={archive}>Archive</MenuItem>}
            <div className="my-1 h-px bg-line" />
            <MenuItem icon={<Trash2 />} tone="danger" onClick={remove}>Delete</MenuItem>
          </Menu>
        </div>
      </div>
    </header>
  </>
  );
}

// Remote threads always say where they run, at every width.
export function HostChip({ id }: { id: string }) {
  const h = useStore(s => s.hosts.find(x => x.id === id));
  return (
    <span className="flex-none inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-tide/30 bg-tide/10 text-[12px] text-tide" data-tip={h ? `Runs on ${h.name} (${h.ssh}), not ${thisMachine(useStore.getState().service)}` : 'This host was removed'}>
      <Server size={12} />{h?.name ?? 'removed host'}{h && !h.connected && <span className="size-1.5 rounded-full bg-halo animate-pulse" />}
    </span>
  );
}
