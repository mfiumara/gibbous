// Dependency graph of one kanban board (parent → child, left to right). Layout is pure (graphLayout.ts) and memoized
// on the task/link set; pan and zoom only touch one CSS transform on the canvas, so polling and hovering stay cheap.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { AlertTriangle, Ban, GitBranch, ZoomIn, ZoomOut, Maximize, CircleCheckBig } from 'lucide-react';
import type { KanbanCard, KanbanStatus } from '../api';
import { IconButton, Moon, MoonLoader, Elapsed } from '../ui';
import { LABEL, agoS } from './board';
import { layoutGraph, edgePath, lineage, DEFAULTS, type Link } from './graphLayout';

const { nodeW: W, nodeH: H } = DEFAULTS;
// Open work first (it seeds the layer order and leads the no-dependencies grid), finished last.
const RANK: Record<KanbanStatus, number> = { running: 0, blocked: 1, review: 2, ready: 3, todo: 4, triage: 5, scheduled: 6, done: 7, archived: 8 };
const MIN_K = 0.08, MAX_K = 2;
// The first view fits the graph when that stays legible; a bigger one opens at a readable zoom on the running work.
const startK = (w: number) => w < 640 ? 0.62 : 0.78;

type View = { x: number; y: number; k: number };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function GraphView({ tasks, links, now, hideDone, onHideDone, doneCount, fitKey, onOpen }: {
  tasks: KanbanCard[]; links: Link[]; now: number; hideDone: boolean; onHideDone(v: boolean): void; doneCount: number;
  fitKey: string; onOpen(id: string): void;
}) {
  const sorted = useMemo(() => tasks.map((t, i) => [t, i] as const).sort((a, b) => RANK[a[0].status] - RANK[b[0].status] || a[1] - b[1]).map(x => x[0]), [tasks]);
  // Re-layout only when the shape changes, not on every poll that returns the same tasks and links.
  const shape = sorted.map(t => t.id).join(' ') + '|' + links.map(l => `${l.parent}>${l.child}`).join(' ');
  const layout = useMemo(() => layoutGraph(sorted.map(t => t.id), links), [shape]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const shown = useMemo(() => layout.edges.map(e => ({ parent: e.parent, child: e.child })), [layout]);
  const paths = useMemo(() => layout.edges.map(e => ({ ...e, d: edgePath(e.points), key: `${e.parent}>${e.child}` })), [layout]);

  const outer = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null), hotG = useRef<SVGGElement>(null);
  // Hover/keyboard focus lights a task's ancestors and descendants. Done straight on the DOM (attributes + a cloned
  // top layer of edges), not through React state: re-rendering 400 cards and 300 edges per hover is what stutters.
  const hover = useRef<string | null>(null);
  const highlight = useCallback((id: string | null) => {
    hover.current = id;
    const o = outer.current, g = hotG.current;
    if (!o || !g) return;
    for (const el of o.querySelectorAll('[data-lit]')) el.removeAttribute('data-lit');
    g.replaceChildren();
    if (!id) { o.removeAttribute('data-hovering'); return; }
    const lit = lineage(id, shown);
    o.setAttribute('data-hovering', '');
    for (const el of o.querySelectorAll<HTMLElement>('[data-node]')) if (lit.has(el.dataset.node!)) el.setAttribute('data-lit', el.dataset.node === id ? 'focus' : '');
    for (const p of o.querySelectorAll<SVGPathElement>('path[data-p]')) if (lit.has(p.dataset.p!) && lit.has(p.dataset.c!)) {
      const c = p.cloneNode() as SVGPathElement; c.setAttribute('class', 'graph-edge hot'); g.appendChild(c);
    }
  }, [shown]);
  const setHover = highlight;
  useLayoutEffect(() => { if (hover.current) highlight(byId.has(hover.current) ? hover.current : null); });

  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const apply = useCallback(() => {
    const { x, y, k } = view.current, gr = grid.current;
    if (inner.current) inner.current.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
    // The dot grid is its own layer, moved by less than one cell, so panning never repaints it (zooming does).
    if (gr) {
      let c = 24 * k; while (c < 12) c *= 2;
      const size = `${c.toFixed(2)}px ${c.toFixed(2)}px`;
      if (gr.style.backgroundSize !== size) gr.style.backgroundSize = size;
      gr.style.transform = `translate3d(${(((x % c) + c) % c).toFixed(1)}px, ${(((y % c) + c) % c).toFixed(1)}px, 0)`;
    }
  }, []);
  const fitScale = useCallback(() => {
    const r = outer.current?.getBoundingClientRect();
    if (!r || !layout.width) return 1;
    return clamp(Math.min((r.width - 48) / layout.width, (r.height - 96) / layout.height), MIN_K, 1);
  }, [layout]);
  const fit = useCallback((start = false) => {
    const r = outer.current?.getBoundingClientRect();
    if (!r) return;
    const k = Math.max(start ? Math.min(1, startK(r.width)) : MIN_K, fitScale());
    const w = layout.width * k, h = layout.height * k;
    const v = { k, x: w <= r.width - 48 ? (r.width - w) / 2 : 24, y: h <= r.height - 96 ? Math.max(24, (r.height - 72 - h) / 2) : 24 };
    if (start && (w > r.width - 48 || h > r.height - 96)) {
      // Too big to fit legibly: centre on the first running task (else the first open one), clamped to the canvas.
      const f = layout.nodes.find(n => byId.get(n.id)?.status === 'running') ?? layout.nodes.find(n => !/^(done|archived)$/.test(byId.get(n.id)?.status ?? '')) ?? layout.nodes[0] ?? layout.loose[0];
      if (f) {
        if (w > r.width - 48) v.x = clamp(r.width / 2 - (f.x + W / 2) * k, r.width - 24 - w, 24);
        if (h > r.height - 96) v.y = clamp((r.height - 48) / 2 - (f.y + H / 2) * k, r.height - 72 - h, 24);
      }
    }
    view.current = v;
    apply();
  }, [layout, byId, fitScale, apply]);
  const zoomAt = useCallback((px: number, py: number, k: number) => {
    const v = view.current, nk = clamp(k, Math.min(MIN_K, fitScale()), MAX_K);
    view.current = { k: nk, x: px - (px - v.x) * nk / v.k, y: py - (py - v.y) * nk / v.k };
    apply();
  }, [apply, fitScale]);
  const zoomBy = (f: number) => { const r = outer.current!.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, view.current.k * f); };

  // Fit on open and whenever the user changes what's in view (filter, archived, hide done); polls keep the view.
  const fitted = useRef<string | null>(null);
  useLayoutEffect(() => { if (fitted.current !== fitKey && layout.width) { fitted.current = fitKey; fit(true); } else apply(); }, [fitKey, layout, fit, apply]);

  // Wheel: scroll pans, pinch (ctrl+wheel, Chrome/Firefox) or ⌘/ctrl+wheel zooms; Safari's trackpad pinch is gesture*.
  useEffect(() => {
    const o = outer.current!;
    let g0 = 1;
    const local = (e: { clientX: number; clientY: number }) => { const r = o.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? o.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) { const [x, y] = local(e); zoomAt(x, y, view.current.k * Math.exp(-e.deltaY * unit * 0.0075)); return; }
      view.current.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
      view.current.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
      apply();
    };
    const gs = (e: any) => { e.preventDefault(); g0 = view.current.k; };
    const gc = (e: any) => { e.preventDefault(); if (touches.current < 2) { const [x, y] = local(e); zoomAt(x, y, g0 * e.scale); } };
    o.addEventListener('wheel', wheel, { passive: false });
    o.addEventListener('gesturestart', gs); o.addEventListener('gesturechange', gc); o.addEventListener('gestureend', gc);
    const ro = new ResizeObserver(() => apply()); ro.observe(o);
    return () => { o.removeEventListener('wheel', wheel); o.removeEventListener('gesturestart', gs); o.removeEventListener('gesturechange', gc); o.removeEventListener('gestureend', gc); ro.disconnect(); };
  }, [apply, zoomAt]);

  // Drag (mouse or one finger) pans once it moves past a few px, so a tap still opens a card; two fingers pinch.
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const touches = useRef(0);
  const gesture = useRef<{ sx: number; sy: number; v: View; moved: boolean; d?: number; mx?: number; my?: number } | null>(null);
  const swallow = useRef(false);
  const begin = () => {
    const p = [...pts.current.values()], r = outer.current!.getBoundingClientRect();
    if (p.length >= 2) {
      const [a, b] = p;
      gesture.current = { sx: 0, sy: 0, v: { ...view.current }, moved: true, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
    } else if (p.length === 1) gesture.current = { sx: p[0].x, sy: p[0].y, v: { ...view.current }, moved: gesture.current?.moved ?? false };
    else gesture.current = null;
  };
  const down = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    touches.current = [...pts.current.keys()].length;
    if (pts.current.size === 1) gesture.current = null;
    begin();
    if (pts.current.size >= 2) for (const id of pts.current.keys()) try { outer.current!.setPointerCapture(id); } catch { /* gone */ }
  };
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!pts.current.has(e.pointerId) || !g) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.d) {
      const [a, b] = [...pts.current.values()], r = outer.current!.getBoundingClientRect();
      const k = clamp(g.v.k * Math.hypot(a.x - b.x, a.y - b.y) / g.d, Math.min(MIN_K, fitScale()), MAX_K);
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      view.current = { k, x: mx - (g.mx! - g.v.x) * k / g.v.k, y: my - (g.my! - g.v.y) * k / g.v.k };
      apply(); return;
    }
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 5) return;
    if (!g.moved) { g.moved = true; try { outer.current!.setPointerCapture(e.pointerId); } catch { /* gone */ } outer.current!.dataset.grabbing = ''; setHover(null); }
    view.current = { ...g.v, x: g.v.x + dx, y: g.v.y + dy };
    apply();
  };
  const up = (e: React.PointerEvent) => {
    if (!pts.current.delete(e.pointerId)) return;
    touches.current = pts.current.size;
    const moved = gesture.current?.moved;
    if (pts.current.size) { begin(); return; }
    gesture.current = null;
    delete outer.current!.dataset.grabbing;
    if (moved) { swallow.current = true; setTimeout(() => { swallow.current = false; }, 0); }
  };

  // Keyboard (j/k walk the cards): bring the focused card into view; undo any scroll the browser does on its own.
  const reveal = (e: React.FocusEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-node]');
    if (!el || !outer.current || !el.matches(':focus-visible')) return;
    const o = outer.current.getBoundingClientRect(), r = el.getBoundingClientRect(), m = 24;
    let dx = 0, dy = 0;
    if (r.left < o.left + m) dx = o.left + m - r.left; else if (r.right > o.right - m) dx = Math.max(o.right - m - r.right, o.left + m - r.left);
    if (r.top < o.top + m) dy = o.top + m - r.top; else if (r.bottom > o.bottom - 64) dy = Math.max(o.bottom - 64 - r.bottom, o.top + m - r.top);
    if (dx || dy) { view.current.x += dx; view.current.y += dy; apply(); }
    setHover(el.dataset.node!);
  };

  const enter = useCallback((id: string | null) => { if (!gesture.current?.moved) highlight(id); }, [highlight]);
  const open = useCallback((id: string) => { if (!swallow.current) onOpen(id); }, [onOpen]);
  const empty = !layout.nodes.length && !layout.loose.length;

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={outer} data-vim-list onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onFocus={reveal}
        onBlur={() => setHover(null)} onScroll={e => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; }}
        className="graph-canvas absolute inset-0 overflow-hidden touch-none select-none">
        <div ref={grid} aria-hidden className="graph-grid absolute -inset-16 pointer-events-none will-change-transform" />
        <div ref={inner} className="absolute left-0 top-0 origin-top-left will-change-transform" style={{ width: layout.width, height: layout.height }}>
          <svg width={layout.width} height={layout.height} className="absolute inset-0 overflow-visible pointer-events-none" aria-hidden>
            {paths.map(p => {
              const done = byId.get(p.parent)?.status === 'done' || byId.get(p.parent)?.status === 'archived';
              return <path key={p.key} d={p.d} data-p={p.parent} data-c={p.child} className={`graph-edge ${done ? 'resolved' : ''} ${p.back ? 'back' : ''}`} vectorEffect="non-scaling-stroke" />;
            })}
            <g ref={hotG} />
          </svg>
          {layout.looseTop != null && <p className="absolute left-0 label text-ash whitespace-nowrap" style={{ top: layout.looseTop }}>No dependencies · {layout.loose.length}</p>}
          {[...layout.nodes, ...layout.loose].map(n => { const t = byId.get(n.id); return t && <Node key={n.id} t={t} x={n.x} y={n.y} now={now} onOpen={open} onHover={enter} />; })}
        </div>
      </div>
      {empty && <div className="absolute inset-0 grid place-items-center pointer-events-none"><p className="text-[13px] text-ash">{hideDone && doneCount ? 'Nothing open. Show done tasks to see the finished graph.' : 'No tasks match'}</p></div>}
      <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-xl surface p-1 shadow-[var(--shadow-pop)]">
        {doneCount > 0 && <IconButton label={hideDone ? `Show done tasks (${doneCount} hidden)` : 'Hide done tasks (keeps the ones next to open work)'} aria-pressed={hideDone} onClick={() => onHideDone(!hideDone)}><CircleCheckBig size={15} /></IconButton>}
        <IconButton label="Zoom out" onClick={() => zoomBy(1 / 1.25)}><ZoomOut size={15} /></IconButton>
        <IconButton label="Zoom in" onClick={() => zoomBy(1.25)}><ZoomIn size={15} /></IconButton>
        <IconButton label="Fit the whole graph on screen" onClick={() => fit()}><Maximize size={15} /></IconButton>
      </div>
    </div>
  );
}

const Node = memo(function Node({ t, x, y, now, onOpen, onHover }: { t: KanbanCard; x: number; y: number; now: number; onOpen(id: string): void; onHover(id: string | null): void }) {
  const done = t.status === 'done' || t.status === 'archived';
  return (
    <button data-vim-item data-node={t.id} onClick={() => onOpen(t.id)}
      onPointerEnter={e => { if (e.pointerType === 'mouse') onHover(t.id); }} onPointerLeave={e => { if (e.pointerType === 'mouse') onHover(null); }}
      aria-label={`${t.title} · ${LABEL[t.status]}`}
      className={`graph-node absolute flex flex-col justify-between rounded-xl px-2.5 py-2 text-left ${done ? 'is-done' : ''} ${t.status === 'running' ? 'is-running' : ''}`}
      style={{ left: x, top: y, width: W, height: H }}>
      <span className="flex items-start gap-1.5 min-w-0">
        <span className="mt-[3px] flex-none grid place-items-center size-3">{t.status === 'running' ? <MoonLoader size={12} label="Running" /> : <Moon kanban={t.status} size={8} />}</span>
        <span className={`flex-1 min-w-0 text-[12.5px] leading-[1.3] line-clamp-2 ${done ? 'text-dust' : 'text-moon'}`}>{t.title}</span>
        {t.priority > 0 && <span className="label text-halo flex-none !text-[9.5px]">P{t.priority}</span>}
      </span>
      <span className="flex items-center gap-x-2 pl-[18px] text-[11px] text-ash min-w-0 whitespace-nowrap">
        {t.assignee ? <span className="text-dust truncate min-w-0">{t.assignee}</span> : <span className="truncate">{LABEL[t.status]}</span>}
        {t.status === 'running' && t.runStartedAt ? <span className="text-tide flex-none"><Elapsed since={t.runStartedAt * 1000} /></span> : null}
        {t.progress && <span className="inline-flex items-center gap-0.5 flex-none tabular-nums"><GitBranch size={10} />{t.progress.done}/{t.progress.total}</span>}
        {t.status === 'blocked' && <span className="inline-flex items-center gap-0.5 text-halo flex-none min-w-0"><Ban size={10} />{t.blockKind ?? 'blocked'}</span>}
        {t.warnings > 0 && <span className="inline-flex items-center gap-0.5 text-oxide flex-none"><AlertTriangle size={10} />{t.warnings}</span>}
        {done && t.completedAt ? <span className="ml-auto flex-none">{agoS(t.completedAt, now)}</span> : null}
      </span>
    </button>
  );
});
