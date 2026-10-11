import { useEffect, useRef, useState } from 'react';
import { Plus, MoreHorizontal, Pencil, Trash2, Check, ChevronLeft } from 'lucide-react';
import { api, type Project } from './api';
import { useStore, toastError, NONE } from './store';
import { Menu, MenuItem } from './ui';
import { activeSpace, type Space } from '../../server/spaces';

export function editSpace(space?: Space, projectId?: string) {
  useStore.setState({ sidebar: innerWidth < 1024 || useStore.getState().sidebar });
  dispatchEvent(new CustomEvent('gibbous:space-edit', { detail: { space, projectId } }));
}
export async function moveToSpace(projectId: string, space: string | null) {
  const project = await api.patch<Project>(`/api/projects/${projectId}`, { space });
  useStore.setState({ projects: useStore.getState().projects.map(p => p.id === project.id ? project : p) });
}
export async function deleteSpace(s: Space) {
  if (!confirm(`Delete “${s.name}”? Its projects stay in All, without a space.`)) return;
  await api.del(`/api/spaces/${s.id}`); await useStore.getState().load();
}
export function SpaceItems({ project, onClose }: { project: Project; onClose(): void }) {
  const spaces = useStore(s => s.settings?.spaces ?? NONE);
  const move = (id: string | null) => { moveToSpace(project.id, id).catch(toastError); onClose(); };
  return <>
    <p className="label px-2.5 pt-1.5 pb-1">Move to space</p>
    {spaces.map(s => <MenuItem key={s.id} icon={project.space === s.id ? <Check className="text-tide" /> : undefined} onClick={() => move(s.id)}>{s.name}</MenuItem>)}
    <MenuItem icon={!project.space ? <Check className="text-tide" /> : undefined} onClick={() => move(null)}>None</MenuItem>
    <div className="my-1 h-px bg-line" />
    <MenuItem icon={<Plus />} onClick={() => { onClose(); editSpace(undefined, project.id); }}>New space…</MenuItem>
  </>;
}
export function SpaceSwitcher() {
  const spaces = useStore(s => s.settings?.spaces ?? NONE);
  const stored = useStore(s => s.activeSpace), setActive = useStore(s => s.setActiveSpace);
  const active = activeSpace(stored, spaces);
  const loaded = useStore(s => s.loaded);
  useEffect(() => { if (loaded && stored !== active) setActive(active); }, [loaded, stored, active, setActive]);
  const [menu, setMenu] = useState(false);
  const [editor, setEditor] = useState<{ space?: Space; projectId?: string } | null>(null);
  const [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const start = (detail: { space?: Space; projectId?: string }) => { setMenu(false); setEditor(detail); setName(detail.space?.name ?? ''); setError(''); };
  useEffect(() => {
    const onEdit = (e: Event) => start((e as CustomEvent).detail);
    addEventListener('gibbous:space-edit', onEdit);
    return () => removeEventListener('gibbous:space-edit', onEdit);
  }, []);
  const selected = useRef<HTMLButtonElement>(null);
  useEffect(() => { selected.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!editor || busy) return; setBusy(true); setError('');
    try {
      const s = editor.space ? await api.patch<Space>(`/api/spaces/${editor.space.id}`, { name }) : await api.post<Space>('/api/spaces', { name });
      await useStore.getState().load();
      if (editor.projectId) await moveToSpace(editor.projectId, s.id);
      if (!editor.space) setActive(s.id);
      setEditor(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async (s: Space) => {
    try { await deleteSpace(s); } catch (e) { toastError(e); }
    setMenu(false);
  };
  if (!spaces.length && !editor) return null;
  return <div className="px-2 pb-2 flex-none" data-space-controls>
    {spaces.length > 0 && <div className="relative flex gap-1 items-center" onContextMenu={e => { e.preventDefault(); setMenu(true); }}>
      <div role="group" aria-label="Project spaces" className="flex flex-1 min-w-0 gap-0.5 p-1 overflow-x-auto rounded-lg bg-ridge/45">
        {[{ id: '', name: 'All' }, ...spaces].map(s => <button key={s.id} ref={active === s.id ? selected : undefined} aria-pressed={active === s.id}
          data-space={s.id} onClick={() => setActive(s.id)} data-tip={`Show ${s.id ? s.name + ' projects' : 'all projects and chats'} · [ / ] to switch spaces`}
          onDragOver={e => { if (s.id) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
          onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (s.id && useStore.getState().projects.some(p => p.id === id)) moveToSpace(id, s.id).catch(toastError); }}
          className={`press flex-1 shrink-0 min-w-fit max-w-40 truncate rounded-md px-3 h-7 pointer-coarse:h-10 text-[12px] transition-colors ${active === s.id ? 'bg-ridge text-moon shadow-sm' : 'text-ash hover:text-moon'}`}>{s.name}</button>)}
      </div>
      <button aria-label="Manage spaces" onClick={() => setMenu(!menu)} className="press size-7 pointer-coarse:size-10 flex-none grid place-items-center rounded-md text-ash hover:text-moon"><MoreHorizontal size={14} /></button>
      <Menu open={menu} onClose={() => setMenu(false)} align="left">
        <MenuItem icon={<Plus />} onClick={() => start({})}>New space…</MenuItem>
        {spaces.map(s => <MenuItem key={s.id} icon={<Pencil />} onClick={() => start({ space: s })}>Rename {s.name}…</MenuItem>)}
        {spaces.map(s => <MenuItem key={'delete:' + s.id} icon={<Trash2 />} onClick={() => remove(s)}>Delete {s.name}…</MenuItem>)}
      </Menu>
    </div>}
    {editor && <form onSubmit={save} className="mt-1 p-2 rounded-lg well">
      <p className="text-[11.5px] text-dust mb-2">{editor.space ? 'Rename space' : 'Group projects in a space'}</p>
      <div className="flex gap-1">
        <input aria-label="Space name" placeholder="Private, Work…" value={name} maxLength={40} onChange={e => setName(e.target.value)}
          autoFocus={!matchMedia('(pointer: coarse)').matches} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); setEditor(null); } }}
          className="min-w-0 flex-1 rounded-md bg-basalt px-2 h-9 text-[13px] outline-none border border-line focus:border-tide/60" />
        <button disabled={busy || !name.trim()} aria-label="Save space" className="press size-9 text-tide rounded-md hover:bg-ridge disabled:opacity-40 grid place-items-center"><Check size={15} /></button>
        <button type="button" aria-label="Cancel space edit" onClick={() => setEditor(null)} className="press size-9 text-ash grid place-items-center"><ChevronLeft size={15} /></button>
      </div>
      {error && <p role="alert" className="text-[12px] text-oxide mt-2 select-text">{error}</p>}
    </form>}
  </div>;
}
