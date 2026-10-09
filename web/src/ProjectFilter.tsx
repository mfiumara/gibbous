// ⌘K → "Filter projects": walk the project list with the keyboard and show/hide each one in the sidebar.
// The palette stays open, so you can toggle several in a row. Same state as the sidebar's filter menu.
// Vim-style: focus starts on the list (j/k, gg/G, space/↵ toggle, o = only this one); / or any other letter types
// into the search box, and Esc there goes back to the list.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ListFilter } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './store';
import { Kbd } from './ui';

type Row = { id: string; label: string; on?: boolean; count?: number; run(): void; solo?(): void };

export function ProjectFilter({ onBack, onClose }: { onBack?(): void; onClose(): void }) {
  const { projects, threads, hidden, setHidden } = useStore(useShallow(s => ({ projects: s.projects, threads: s.threads, hidden: s.hiddenProjects, setHidden: s.setHiddenProjects })));
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), lastG = useRef(0);
  useEffect(() => { box.current?.focus(); }, []);
  const live = (id: string) => threads.filter(t => t.projectId === id && t.status !== 'archived').length;
  const rows = useMemo<Row[]>(() => {
    const needle = q.toLowerCase().trim();
    const list: Row[] = projects.filter(p => !needle || p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle)).map(p => {
      const on = !hidden.includes(p.id);
      return { id: p.id, label: p.name, on, count: live(p.id),
        run: () => setHidden(on ? [...hidden, p.id] : hidden.filter(x => x !== p.id)),
        solo: () => setHidden(projects.filter(x => x.id !== p.id).map(x => x.id)) };
    });
    if (needle) return list;
    return [
      { id: '_all', label: 'Show all projects', run: () => setHidden([]) },
      ...(projects.length > 2 ? [{ id: '_busy', label: 'Hide projects with no threads', run: () => setHidden(projects.filter(p => !live(p.id)).map(p => p.id)) }] : []),
      ...list,
    ];
  }, [q, projects, threads, hidden]);
  const cur = Math.min(sel, Math.max(0, rows.length - 1));
  const move = (d: number) => setSel(s => rows.length ? (Math.min(s, rows.length - 1) + d + rows.length) % rows.length : 0);
  const toggle = (solo: boolean) => { const r = rows[cur]; if (r) (solo && r.solo ? r.solo() : r.run()); };
  useEffect(() => { box.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); }, [cur]);
  // Keys on the list (focus outside the search box).
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.target === input.current || e.metaKey && e.key !== 'Enter') return;
    const k = e.key, now = performance.now();
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'j' || k === 'ArrowDown' || (k === 'Tab' && !e.shiftKey) || (e.ctrlKey && k === 'n')) { handled(); move(1); }
    else if (k === 'k' || k === 'ArrowUp' || (k === 'Tab' && e.shiftKey) || (e.ctrlKey && k === 'p')) { handled(); move(-1); }
    else if (k === 'G') { handled(); setSel(rows.length - 1); }
    else if (k === 'g') { handled(); if (now - lastG.current < 500) setSel(0); lastG.current = now; }
    else if (k === ' ' || k === 'x' || k === 'Enter') { handled(); toggle(k === 'Enter' && (e.metaKey || e.ctrlKey || e.altKey)); }
    else if (k === 'o') { handled(); toggle(true); }
    else if (k === 'Escape') { handled(); if (q) setQ(''); else (onBack ?? onClose)(); }
    else if (k === '/') { handled(); input.current?.focus(); }
    else if (k.length === 1 && !e.ctrlKey && !e.altKey) { handled(); setQ(x => x + k); setSel(0); input.current?.focus(); }
  };
  const shown = projects.length - hidden.filter(id => projects.some(p => p.id === id)).length;
  return (
    <div className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-[3px] flex justify-center pt-[12vh] px-3 animate-fade" onClick={onClose}>
      <div ref={box} tabIndex={-1} onKeyDown={onListKey} role="dialog" aria-label="Filter projects" className="pop w-full max-w-xl h-fit rounded-2xl overflow-hidden outline-none" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 border-b border-line">
          {onBack ? <button onClick={onBack} aria-label="Back to search" className="press -ml-1 size-7 flex-none grid place-items-center rounded-md text-ash hover:text-moon"><ChevronLeft size={16} /></button>
            : <ListFilter size={16} className="text-ash flex-none" />}
          <input ref={input} className="flex-1 min-w-0 bg-transparent py-3.5 text-[15px] placeholder:text-ash focus:outline-none" placeholder="Filter projects in the sidebar…" value={q}
            onChange={e => { setQ(e.target.value); setSel(0); }}
            onKeyDown={e => {
              const k = e.key;
              if (k === 'ArrowDown' || (k === 'Tab' && !e.shiftKey) || (e.ctrlKey && k === 'n')) { e.preventDefault(); move(1); }
              else if (k === 'ArrowUp' || (k === 'Tab' && e.shiftKey) || (e.ctrlKey && k === 'p')) { e.preventDefault(); move(-1); }
              else if (k === 'Enter') { e.preventDefault(); const r = rows[cur]; if (!r) return; (e.metaKey || e.ctrlKey || e.altKey) && r.solo ? r.solo() : r.run(); }
              else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); box.current?.focus(); }  // back to the list (j/k)
              e.stopPropagation();
            }} />
          <span className="label text-ash tabular-nums flex-none" data-tip="Projects shown in the sidebar">{shown}/{projects.length}</span>
        </div>
        <ul role="listbox" aria-multiselectable="true" className="max-h-[52vh] overflow-y-auto p-1.5">
          {rows.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === cur} aria-checked={r.on}>
              <button onMouseMove={() => setSel(i)} onClick={e => (e.metaKey || e.altKey) && r.solo ? r.solo() : r.run()}
                className={`w-full flex items-center gap-3 px-3 py-2 pointer-coarse:py-3 rounded-lg text-left text-sm transition-colors duration-100 ${i === cur ? 'bg-ridge text-moon' : 'text-moon/85'}`}>
                <span className={`size-4 flex-none grid place-items-center rounded-[5px] border ${r.on === undefined ? 'border-transparent' : r.on ? 'border-tide/60 bg-tide/15 text-tide' : 'border-line text-transparent'}`}>
                  {r.on !== undefined && <Check size={11} strokeWidth={2.6} />}
                </span>
                <span className={`truncate flex-1 ${r.on === false ? 'text-ash' : ''}`}>{r.label}</span>
                {r.count != null && <span className="label text-ash tabular-nums">{r.count ? `${r.count} thread${r.count > 1 ? 's' : ''}` : 'empty'}</span>}
              </button>
            </li>
          ))}
          {!rows.length && <li className="px-3 py-2 text-[13px] text-ash">No project matches “{q}”.</li>}
        </ul>
        <div className="flex items-center gap-3 px-4 py-2 border-t border-line text-[11.5px] text-ash pointer-coarse:hidden">
          <span><Kbd>j k</Kbd> move</span><span><Kbd>␣</Kbd> show / hide</span><span><Kbd>o</Kbd> only this one</span><span><Kbd>/</Kbd> search</span><span className="ml-auto"><Kbd>esc</Kbd> {onBack ? 'back' : 'close'}</span>
        </div>
      </div>
    </div>
  );
}
