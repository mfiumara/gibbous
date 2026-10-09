// Dependency graph of a project's tasks: layered left→right, critical path highlighted.
// Drag from a task's right edge onto another task to make that task wait for it.
import { useMemo, useRef, useState } from 'react';
import { api, type Task } from '../api';
import { toastError } from '../store';
import { Moon } from '../ui';

import { layout, W, H } from './layout';

export function Graph({ tasks, onOpen }: { tasks: Task[]; onOpen(t: Task): void }) {
  const { pos, critical, width, height } = useMemo(() => layout(tasks), [tasks]);
  const [drag, setDrag] = useState<{ from: string; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const local = (e: React.PointerEvent) => { const r = box.current!.getBoundingClientRect(); return { x: e.clientX - r.left + box.current!.scrollLeft, y: e.clientY - r.top + box.current!.scrollTop }; };
  const dropOn = async (target: Task) => {
    if (!drag || drag.from === target.id || target.deps.includes(drag.from)) return;
    try { await api.patch(`/api/tasks/${target.id}`, { deps: [...target.deps, drag.from] }); } catch (e) { toastError(e); }
  };
  const unlink = (t: Task, dep: string) => api.patch(`/api/tasks/${t.id}`, { deps: t.deps.filter(d => d !== dep) }).catch(toastError);

  return (
    <div ref={box} className="relative h-full overflow-auto" onPointerMove={e => drag && setDrag({ ...drag, ...local(e) })} onPointerUp={() => setDrag(null)}>
      <svg width={width} height={height} className="absolute inset-0 pointer-events-none overflow-visible">
        <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--color-ash)" /></marker></defs>
        {tasks.flatMap(t => t.deps.filter(d => pos.has(d)).map(d => {
          const a = pos.get(d)!, b = pos.get(t.id)!;
          const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
          const hot = critical.has(t.id) && critical.has(d);
          return <path key={`${d}-${t.id}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`} fill="none" markerEnd="url(#arrow)"
            stroke={hot ? 'var(--color-halo)' : 'var(--color-line)'} strokeWidth={hot ? 2 : 1.5} className="pointer-events-auto cursor-pointer hover:stroke-oxide" onClick={() => confirm('Remove this dependency?') && unlink(t, d)} />;
        }))}
        {drag && (() => { const a = pos.get(drag.from)!; return <path d={`M${a.x + W},${a.y + H / 2} L${drag.x},${drag.y}`} stroke="var(--color-tide)" strokeWidth={2} strokeDasharray="4 4" fill="none" />; })()}
      </svg>
      <div style={{ width, height }} className="relative">
        {tasks.map(t => {
          const p = pos.get(t.id)!;
          return (
            <div key={t.id} style={{ left: p.x, top: p.y, width: W, height: H }} onPointerUp={() => dropOn(t)}
              className={`absolute rounded-xl border bg-crater px-3 py-2 flex items-center gap-2.5 transition-[border-color,box-shadow] shadow-[inset_0_1px_0_var(--surface-hi)] ${critical.has(t.id) ? 'border-halo/50' : 'border-line'} ${drag && drag.from !== t.id ? 'hover:border-tide hover:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-tide)_20%,transparent)]' : ''}`}>
              <Moon task={t.status} size={10} />
              <button onClick={() => onOpen(t)} className="flex-1 min-w-0 text-left">
                <span className="block text-[13px] font-bold truncate">{t.title}</span>
                <span className="block label text-[9px]">{t.status}</span>
              </button>
              <span onPointerDown={e => { e.preventDefault(); setDrag({ from: t.id, ...local(e) }); }} data-tip="Drag onto a task to make it wait for this one"
                className="absolute -right-1.5 top-1/2 -translate-y-1/2 size-3 rounded-full border-2 border-crater bg-ash hover:bg-tide cursor-crosshair" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
