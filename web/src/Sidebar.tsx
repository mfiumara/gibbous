import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, History, Settings, ChevronDown, FolderPlus, Archive, Search, ArchiveRestore, Users, Server, Laptop, Pin, PinOff, Pencil, CalendarClock, KanbanSquare, X, ListFilter, Check, MoreHorizontal, ArrowUp, ArrowDown, EyeOff, GripVertical, GitPullRequest, GitMerge, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';
import { useStore, toastError, archiveWithUndo, deleteWithUndo, isUnread, NONE } from './store';
import { useShallow } from 'zustand/react/shallow';
import { api, type Thread, type PrBadge } from './api';
import { SpaceSwitcher, SpaceItems } from './Spaces';
import { activeSpace, inSpace } from '../../server/spaces';
import { EDGE, axis, progress, settle } from './drawer';
import { prefetch } from './thread/prefetch';
import { Moon, MoonLoader, TonightMoon, Kbd, Menu, MenuItem, ago, sourceLabel, type Route } from './ui';
import { quiet } from './screenTransition';
import { TaskCheck, editHumanTask } from './HumanTask';
import { openHumanTask } from '../../server/humanTasks';
import { haptic, inIosApp } from './iosBridge';

// Navigating from the open drawer: the drawer slides away itself, so the screen change gets no transition on top.
const close = () => { if (useStore.getState().sidebar) quiet(); useStore.setState({ sidebar: false }); };

const rowCls = (active: boolean) =>
  `press group relative flex items-center gap-2.5 rounded-lg text-[13.5px] ${active ? 'bg-ridge text-moon shadow-[inset_0_1px_0_var(--surface-hi)]' : 'text-dust hover:text-moon hover:bg-ridge/55'}`;

// A worktree thread's PR under its title: state glyph + number, CI result, diff size. Clicking it opens GitHub.
const prLook: Record<PrBadge['state'], { Icon: typeof GitPullRequest; cls: string; word?: string }> = {
  open: { Icon: GitPullRequest, cls: 'text-sprout' }, draft: { Icon: GitPullRequestDraft, cls: 'text-ash', word: 'draft' },
  merged: { Icon: GitMerge, cls: 'text-[#b8a6e0]', word: 'merged' }, closed: { Icon: GitPullRequestClosed, cls: 'text-ash', word: 'closed' },
};
const ciLook = { pass: { cls: 'text-sprout', word: 'passed' }, fail: { cls: 'text-oxide', word: 'failing' }, pending: { cls: 'text-halo', word: 'running' } };
const kNum = (n: number) => n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function PrLine({ pr }: { pr: PrBadge }) {
  const { Icon, cls, word } = prLook[pr.state];
  const live = pr.state === 'open' || pr.state === 'draft';
  const ci = live && pr.ci ? ciLook[pr.ci] : null;
  const open = (e: React.MouseEvent | React.KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); window.open(pr.url, '_blank', 'noopener'); };
  return (
    <span role="link" tabIndex={-1} onClick={open} data-tip={`Pull request #${pr.number} · ${word ?? 'open'}${ci ? ` · checks ${ci.word}` : ''}\nOpens on GitHub`}
      className="basis-full flex items-center gap-1.5 pl-[19px] h-4 text-[11px] leading-none text-ash tabular-nums hover:[&_.pr-n]:text-dust">
      <Icon size={10} strokeWidth={2.4} className={`flex-none ${cls}`} aria-hidden />
      <span className="pr-n transition-colors">{pr.number}</span>
      {word && <><span aria-hidden className="opacity-50">·</span><span className={cls}>{word}</span></>}
      {ci && <><span aria-hidden className="opacity-50">·</span>
        <span className={`inline-flex items-center gap-1 ${ci.cls}`}>
          {pr.ci === 'pending' ? <MoonLoader size={9} label="Checks running" />
            : <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                {pr.ci === 'pass' ? <path d="M1.2 4.3 3.2 6.2 6.8 1.9" /> : <path d="M1.6 1.6l4.8 4.8M6.4 1.6 1.6 6.4" />}</svg>}
          {ci.word}</span></>}
      <span className="ml-auto pl-2 flex gap-1 text-[10.5px] group-hover:opacity-0 transition-opacity">
        {pr.additions > 0 && <span className="text-sprout/85">+{kNum(pr.additions)}</span>}
        {pr.deletions > 0 && <span className="text-oxide/85">−{kNum(pr.deletions)}</span>}
      </span>
    </span>
  );
}

// Bulk select: when on, rows become checkboxes and a bar offers archive/delete for the selection.
const SelectCtx = createContext<{ on: boolean; ids: Set<string>; toggle(id: string): void }>({ on: false, ids: new Set(), toggle: () => {} });

// Memoized: a thread event re-renders only that thread's row (upsert keeps the other objects identical).
const ThreadLink = memo(function ThreadLink({ t, active }: { t: Thread; active: boolean; minute?: number }) {
  const sel = useContext(SelectCtx);
  const unread = useStore(s => !active && isUnread(t, s.seen));
  const pr = useStore(s => s.prs[t.id]);
  const archived = t.status === 'archived';
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout>>(undefined);
  const longPressed = useRef(false);
  const toggleArchive = () => { if (archived) api.patch(`/api/threads/${t.id}`, { status: 'idle' }).catch(toastError); else archiveWithUndo(t); };
  const rename = (title: string) => { setRenaming(false); if (title.trim() && title.trim() !== t.title) api.patch(`/api/threads/${t.id}`, { title: title.trim() }).catch(toastError); };
  // Phones have no hover or right-click: a long press opens the same menu.
  const touchStart = () => { prefetch(t.id); longPressed.current = false; press.current = setTimeout(() => { longPressed.current = true; setMenu(true); if (inIosApp()) haptic('longPress'); else navigator.vibrate?.(8); }, 500); };
  const touchEnd = () => clearTimeout(press.current);
  // Warm the timeline cache when the pointer rests on a row (not on a fly-by), so the click paints instantly.
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverIn = (e: { pointerType: string }) => { if (e.pointerType === 'mouse' && !active) hover.current = setTimeout(() => prefetch(t.id), 120); };
  const hoverOut = () => clearTimeout(hover.current);
  if (sel.on) return (
    <label className={`${rowCls(false)} pl-3 pr-2 py-[5px] pointer-coarse:py-2`}>
      <input type="checkbox" className="accent-tide size-3.5" checked={sel.ids.has(t.id)} onChange={() => sel.toggle(t.id)} aria-label={`Select ${t.title}`} />
      <span className="truncate flex-1">{t.title}</span><span className="text-[11px] text-ash">{ago(t.updatedAt)}</span>
    </label>
  );
  if (renaming) return (
    <input autoFocus defaultValue={t.title} aria-label="Thread title" onBlur={e => rename(e.target.value)} onFocus={e => e.target.select()}
      onKeyDown={e => { if (e.key === 'Enter') rename(e.currentTarget.value); if (e.key === 'Escape') setRenaming(false); }}
      className="w-full h-8 px-3 rounded-lg bg-basalt border border-tide/60 text-[13.5px] text-moon focus:outline-none" />
  );
  return (
    <div className="group relative" onContextMenu={e => { e.preventDefault(); setMenu(true); }}>
      <a href={`#/t/${t.id}`} onClick={e => { if (longPressed.current) { e.preventDefault(); longPressed.current = false; return; } close(); }}
        onDoubleClick={e => { e.preventDefault(); setRenaming(true); }} onTouchStart={touchStart} onTouchEnd={touchEnd} onTouchMove={touchEnd} onPointerEnter={hoverIn} onPointerLeave={hoverOut}
        aria-current={active ? 'page' : undefined}
        className={`${rowCls(active)} pl-3 pr-2 py-[5px] pointer-coarse:py-2 select-none [-webkit-touch-callout:none] ${pr ? 'flex-wrap gap-y-[3px]' : ''}`}>
        <Moon thread={t.status} size={9} />
        <span className={`truncate flex-1 ${unread ? 'font-bold text-moon' : ''}`}>{t.title}</span>
        {unread && <span className="size-1.5 rounded-full bg-tide flex-none"><span className="sr-only">unread</span></span>}
        {t.pinned && <Pin size={11} className="text-ash flex-none" aria-label="pinned" />}
        <span className="text-[11px] text-ash group-hover:opacity-0 transition-opacity">{ago(t.updatedAt)}</span>
        {pr && <PrLine pr={pr} />}
      </a>
      <button onClick={toggleArchive} aria-label={archived ? `Unarchive ${t.title}` : `Archive ${t.title}`} data-tip={archived ? 'Unarchive' : 'Archive'}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 size-6 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-line/60 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity pointer-coarse:hidden">
        {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
      </button>
      <Menu open={menu} onClose={() => setMenu(false)} align="left">
        <MenuItem icon={<Check />} onClick={() => { setMenu(false); editHumanTask(t); }}>{openHumanTask(t) ? 'Edit my task…' : 'Add a task for me…'}</MenuItem>
        <MenuItem icon={<Pencil />} onClick={() => { setMenu(false); setRenaming(true); }}>Rename</MenuItem>
        <MenuItem icon={t.pinned ? <PinOff /> : <Pin />} onClick={() => { setMenu(false); api.patch(`/api/threads/${t.id}`, { pinned: !t.pinned }).catch(toastError); }}>{t.pinned ? 'Unpin' : 'Pin to top'}</MenuItem>
        <MenuItem icon={archived ? <ArchiveRestore /> : <Archive />} onClick={() => { setMenu(false); toggleArchive(); }}>{archived ? 'Unarchive' : 'Archive'}</MenuItem>
      </Menu>
    </div>
  );
});

// With `href` (a project), the title opens that page and only the chevron folds the section.
interface Drag { onStart(): void; onOver(): void; onDrop(): void; onEnd(): void; over: 'above' | 'below' | null; dragging: boolean }

function Section({ id, title, count, accent, collapsed, toggle, actions, icon, href, active, onNavigate, onMenu, drag, children }: {
  id: string; title: string; count?: number; accent?: number; collapsed: boolean; toggle(id: string): void; actions?: React.ReactNode; icon?: React.ReactNode;
  href?: string; active?: boolean; onNavigate?(): void; onMenu?(): void; drag?: Drag; children: React.ReactNode;
}) {
  const press = useRef<ReturnType<typeof setTimeout>>(undefined), longPressed = useRef(false);
  useEffect(() => () => clearTimeout(press.current), []);
  const chevron = <ChevronDown size={12} className={`text-ash transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`} />;
  const label = <>{icon}<span className={`label truncate ${active ? 'text-tide' : 'text-moon/75'}`}>{title}</span>
    {count != null && <span className="label text-ash">{count}</span>}
    {!!accent && <span className="label text-tide whitespace-nowrap flex-none">{accent} live</span>}</>;
  return (
    <section className={`relative transition-opacity ${drag?.dragging ? 'opacity-40' : ''}`}
      onDragOver={drag ? e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; drag.onOver(); } : undefined}
      onDrop={drag ? e => { e.preventDefault(); drag.onDrop(); } : undefined}>
      {drag?.over && <span aria-hidden className={`absolute inset-x-2 h-0.5 rounded-full bg-tide pointer-events-none ${drag.over === 'above' ? '-top-2' : '-bottom-2'}`} />}
      <div className={`group/s relative flex items-center gap-1 pl-2 pr-1 h-7 pointer-coarse:h-10 ${drag ? 'cursor-grab active:cursor-grabbing' : ''}`}
        onContextMenu={onMenu ? e => { e.preventDefault(); onMenu(); } : undefined}
        onTouchStart={onMenu ? e => { if ((e.target as HTMLElement).closest('button')) return; longPressed.current = false; press.current = setTimeout(() => { longPressed.current = true; onMenu(); }, 500); } : undefined}
        onTouchEnd={() => clearTimeout(press.current)} onTouchMove={() => clearTimeout(press.current)} onTouchCancel={() => clearTimeout(press.current)}
        onClickCapture={e => { if (longPressed.current && e.currentTarget.contains(e.target as Node)) { e.preventDefault(); e.stopPropagation(); longPressed.current = false; } }}
        draggable={!!drag} onDragStart={drag ? e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); drag.onStart(); } : undefined}
        onDragEnd={drag?.onEnd}>
        {drag && <GripVertical size={11} aria-hidden className="absolute -left-1 text-ash opacity-0 group-hover/s:opacity-60 pointer-coarse:hidden" />}
        {href ? <>
          <button onClick={() => toggle(id)} aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`} className="press grid place-items-center size-4 -ml-0.5">{chevron}</button>
          <a href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined} data-tip="Open the project's kanban board" className="flex items-center gap-1.5 min-w-0 flex-1 hover:[&>.label]:text-moon">{label}</a>
        </> : <button onClick={() => toggle(id)} aria-expanded={!collapsed} className="flex items-center gap-1.5 min-w-0 flex-1 text-left">{chevron}{label}</button>}
        {actions && <span className="flex opacity-0 group-hover/s:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">{actions}</span>}
      </div>
      <div className={`grid transition-[grid-template-rows] duration-250 [transition-timing-function:var(--ease-out)] ${collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}>
        {/* Collapsed rows stay mounted for the animation but are inert: no Tab stops, and j/k skip them. */}
        <div className="overflow-hidden" inert={collapsed}><div className="mt-0.5 space-y-px">{children}</div></div>
      </div>
    </section>
  );
}

// Desktop: drag the sidebar's right edge to resize it (double-click resets). Phones keep the fixed drawer width.
const SB_DEFAULT = 276, SB_MIN = 200, SB_MAX = 520;
const clampW = (w: number) => Math.round(Math.min(SB_MAX, Math.max(SB_MIN, w)));
function useSidebarWidth() {
  const [w, setW] = useState(() => clampW(Number(localStorage.getItem('gibbous.sidebarWidth')) || SB_DEFAULT));
  const save = (v: number) => { setW(v); localStorage.setItem('gibbous.sidebarWidth', String(v)); };
  const [dragging, setDragging] = useState(false);
  const handle = {
    onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      e.preventDefault(); setDragging(true);
      const x0 = e.clientX, w0 = w;
      const move = (ev: PointerEvent) => setW(clampW(w0 + ev.clientX - x0));
      const up = (ev: PointerEvent) => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); setDragging(false); save(clampW(w0 + ev.clientX - x0)); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    },
    onDoubleClick() { save(SB_DEFAULT); },
    onKeyDown(e: React.KeyboardEvent) { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); save(clampW(w + (e.key === 'ArrowLeft' ? -16 : 16))); } },
  };
  return { w, dragging, handle };
}

export function Sidebar({ route, onAddProject }: { route: Route; onAddProject(): void }) {
  const { projects, threads, connected, hermesReady, missing, sidebar, hosts } = useStore(useShallow(s => ({ projects: s.projects, threads: s.threads, connected: s.serverUp || s.connected, hermesReady: s.hermesReady, missing: s.hermes?.installed === false, sidebar: s.sidebar, hosts: s.hosts })));
  const width = useSidebarWidth();
  // Rows are memoized: a minute tick keeps their "5m" ages current.
  const [minute, setMinute] = useState(0);
  useEffect(() => { const h = setInterval(() => setMinute(m => m + 1), 60_000); return () => clearInterval(h); }, []);
  // The phone drawer closes whenever you land somewhere (palette, back swipe, links) and on Escape.
  const where = JSON.stringify(route);
  useEffect(close, [where]);
  // Phones: the drawer follows your finger, like a native one. Drag in from the left edge to open; with it open, drag
  // it (or the dimmed page) left to close. On release a flick decides, otherwise it snaps to the nearer side
  // (drawer.ts). It used to wait for the finger to lift and then jump, and any leftward swipe anywhere closed it.
  const navRef = useRef<HTMLElement>(null), scrimRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let g: { x0: number; y0: number; t0: number; open: boolean; lock: 'x' | 'y' | null; w: number; lastX: number; lastT: number; vx: number } | null = null;
    // Sideways scrollers (code blocks, tables, the subagent pager, chip rows) keep their own horizontal swipes.
    const inScroller = (el: EventTarget | null) => {
      for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
        if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
      }
      return false;
    };
    const paint = (p: number | null) => {
      const nav = navRef.current, scrim = scrimRef.current;
      if (!nav || !scrim) return;
      if (p == null) { nav.style.translate = nav.style.transition = scrim.style.opacity = scrim.style.transition = scrim.style.pointerEvents = ''; return; }
      nav.style.transition = scrim.style.transition = 'none';
      nav.style.translate = `${(p - 1) * 100}% 0`; // Tailwind's translate-x-* use the `translate` property, not transform
      scrim.style.opacity = String(p); scrim.style.pointerEvents = 'auto';
    };
    const start = (e: TouchEvent) => {
      if (innerWidth >= 1024 || e.touches.length > 1) { g = null; return; }
      const t = e.touches[0], open = useStore.getState().sidebar;
      const onDrawer = !!navRef.current?.contains(e.target as Node) || e.target === scrimRef.current;
      // A drag from the left edge always opens the drawer, on every screen (back is the header's button).
      if ((e.target as HTMLElement).closest('[data-space-controls]')) { g = null; return; }
      if (open ? !onDrawer : t.clientX > EDGE || inScroller(e.target)) { g = null; return; }
      g = { x0: t.clientX, y0: t.clientY, t0: e.timeStamp, open, lock: null, w: navRef.current?.offsetWidth || 276, lastX: t.clientX, lastT: e.timeStamp, vx: 0 };
    };
    const move = (e: TouchEvent) => {
      if (!g) return;
      const t = e.touches[0], dx = t.clientX - g.x0;
      if (!g.lock) { g.lock = axis(dx, t.clientY - g.y0); if (g.lock === 'y') { g = null; return; } if (!g.lock) return; }
      if (g.open && inScroller(e.target) && dx > 0) return;
      e.preventDefault(); // we own this gesture: no page scroll, no iOS back-swipe
      const dt = e.timeStamp - g.lastT;
      if (dt > 0) g.vx = .7 * ((t.clientX - g.lastX) / dt) + .3 * g.vx;
      g.lastX = t.clientX; g.lastT = e.timeStamp;
      paint(progress(g.open, dx, g.w));
    };
    const end = (e: TouchEvent) => {
      if (!g) return;
      const was = g; g = null;
      if (was.lock !== 'x') return;
      const dx = (e.changedTouches[0]?.clientX ?? was.lastX) - was.x0;
      const open = settle(was.open, dx, e.timeStamp - was.lastT > 80 ? 0 : was.vx, was.w);
      // Hand back to the CSS transition from where the finger left it.
      const nav = navRef.current, scrim = scrimRef.current;
      if (nav && scrim) { nav.style.transition = scrim.style.transition = ''; void nav.offsetWidth; nav.style.translate = open ? '0 0' : '-100% 0'; scrim.style.opacity = open ? '1' : '0'; }
      if (open && !was.open) haptic('snap');
      useStore.setState({ sidebar: open });
      setTimeout(() => paint(null), 320);
    };
    addEventListener('touchstart', start, { passive: true });
    addEventListener('touchmove', move, { passive: false });
    addEventListener('touchend', end, { passive: true }); addEventListener('touchcancel', end, { passive: true });
    return () => { removeEventListener('touchstart', start); removeEventListener('touchmove', move); removeEventListener('touchend', end); removeEventListener('touchcancel', end); };
  }, []);
  useEffect(() => {
    if (!sidebar) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [sidebar]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('gibbous.collapsed') ?? '{}'));
  const [showArchived, setShowArchived] = useState(false);
  const [more, setMore] = useState(() => localStorage.getItem('gibbous.sidebarMore') === '1');
  const toggle = (id: string) => setCollapsed(c => { const n = { ...c, [id]: !c[id] }; localStorage.setItem('gibbous.collapsed', JSON.stringify(n)); return n; });
  const [q, setQ] = useState('');
  // Projects: order lives on the server (same on every device); which ones are hidden is per device.
  // Shared with the ⌘K project filter (ProjectFilter.tsx), so both stay in sync.
  const hidden = useStore(s => s.hiddenProjects), setHidden = useStore(s => s.setHiddenProjects);
  const spaces = useStore(s => s.settings?.spaces ?? NONE);
  const storedSpace = useStore(s => s.activeSpace);
  const space = activeSpace(storedSpace, spaces);
  const belongs = (t: Thread) => inSpace(projects.find(p => p.id === t.projectId), space);
  const shown = projects.filter(p => !hidden.includes(p.id) && inSpace(p, space));
  const [filterMenu, setFilterMenu] = useState(false);
  const [spaceMenu, setSpaceMenu] = useState(false);
  const [projMenu, setProjMenu] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over?: string; where?: 'above' | 'below' } | null>(null);
  const reorder = (ids: string[]) => {
    const byId = new Map(projects.map(p => [p.id, p]));
    useStore.setState({ projects: ids.map(id => byId.get(id)!).filter(Boolean) });
    api.post('/api/projects/order', { ids }).catch(toastError);
  };
  const place = (id: string, target: string, where: 'above' | 'below') => {
    if (id === target) return;
    const ids = projects.map(p => p.id).filter(x => x !== id);
    ids.splice(ids.indexOf(target) + (where === 'below' ? 1 : 0), 0, id);
    reorder(ids);
  };
  // Up/down step over hidden projects, so a move is always visible.
  const move = (id: string, d: -1 | 1) => {
    const i = shown.findIndex(p => p.id === id), n = shown[i + d];
    if (n) place(id, n.id, d < 0 ? 'above' : 'below');
  };
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const selCtx = useMemo(() => ({ on: selecting, ids: picked, toggle: (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }) }), [selecting, picked]);
  const endSelect = () => { setSelecting(false); setPicked(new Set()); };
  const all = useMemo(() => threads.filter(t => showArchived ? t.status === 'archived' : t.status !== 'archived').sort((a, b) => b.updatedAt - a.updatedAt), [threads, showArchived]);
  const otherAttention = space ? threads.filter(t => t.status === 'needs_input' && !belongs(t)) : [];
  const scoped = all.filter(belongs);
  const pinned = scoped.filter(t => t.pinned);
  const visible = scoped.filter(t => !t.pinned);   // pinned threads live only in the Pinned section
  // The filter matches thread titles and the project (name or id) a thread belongs to.
  const needle = q.trim().toLowerCase();
  const projectHit = (t: Thread) => { const p = projects.find(x => x.id === t.projectId); return !!p && (p.name.toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle)); };
  const matches = needle ? scoped.filter(t => t.title.toLowerCase().includes(needle) || projectHit(t)) : null;
  // Threads on other machines live in their own per-host sections; everything else is this Mac.
  const local = visible.filter(t => !t.host);
  const loose = local.filter(t => !t.readOnly && (!t.projectId || !projects.some(p => p.id === t.projectId)));
  // Imported conversations (Discord, Telegram, CLI…) get one section per source.
  const bySource = useMemo(() => {
    const m = new Map<string, Thread[]>();
    for (const t of visible) if (t.readOnly && !t.host) m.set(t.source ?? 'other', [...(m.get(t.source ?? 'other') ?? []), t]);
    return [...m.entries()];
  }, [visible]);
  const activeId = route.name === 'thread' ? route.id : undefined;
  const status = !connected ? { cls: 'bg-oxide', text: 'Reconnecting' } : !hermesReady ? { cls: 'bg-halo animate-pulse', text: missing ? 'Hermes not installed' : 'Hermes starting' } : null;

  const nav = (href: string, icon: React.ReactNode, label: string, active: boolean, badge?: number) => (
    <a href={href} onClick={close} aria-current={active ? 'page' : undefined} className={`${rowCls(active)} px-3 py-1.5 pointer-coarse:py-2.5`}>
      {icon}<span className="flex-1">{label}</span>
      {!!badge && <span className="min-w-5 h-5 px-1.5 grid place-items-center rounded-full bg-halo text-[#1a1408] text-[11px] font-bold animate-pop">{badge}</span>}
    </a>
  );

  return <>
    <div ref={scrimRef} onClick={close} className={`fixed inset-0 z-40 bg-black/50 lg:hidden transition-opacity duration-300 ${sidebar ? 'opacity-100 backdrop-blur-[2px]' : 'opacity-0 pointer-events-none'}`} />
    <nav ref={navRef} aria-label="Threads" data-pane="nav" data-drag-window="self" style={{ '--sb-w': `${width.w}px` } as React.CSSProperties}
      className={`fixed lg:relative inset-y-0 left-0 z-50 w-[276px] lg:w-[var(--sb-w)] max-w-[85vw] flex-none flex flex-col pt-[env(safe-area-inset-top)] bg-crater lg:bg-transparent edge-r transition-transform duration-300 [transition-timing-function:var(--ease-out)] lg:translate-x-0 ${sidebar ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`}>
      <div data-drag-window className="flex items-center gap-2.5 px-4 h-12 flex-none">
        <TonightMoon size={18} />
        <span className="font-label text-[12.5px] tracking-[0.2em] lowercase text-moon/90">gibbous</span>
        {status && <span className="ml-auto flex items-center gap-1.5 rounded-full border border-line px-2 h-5 text-[10.5px] text-dust animate-fade"><span className={`size-1.5 rounded-full ${status.cls}`} />{status.text}</span>}
      </div>

      <SpaceSwitcher />
      <div className="px-2 space-y-1 flex-none">
        <button onClick={() => useStore.setState({ palette: true })}
          className="press w-full flex items-center gap-2 px-2.5 h-8 pointer-coarse:h-10 well rounded-lg text-[13px] text-ash hover:text-dust hover:border-ash/40">
          <Search size={14} /><span className="flex-1 text-left">Search or jump to…</span><Kbd>⌘K</Kbd>
        </button>
        <a href="#/new" onClick={close} className="press flex items-center gap-2.5 px-3 py-1.5 pointer-coarse:py-2.5 rounded-lg text-[13.5px] text-moon hover:bg-ridge/55">
          <Plus size={15} /><span className="flex-1">New thread</span><span className="font-mono text-[10.5px] text-ash pointer-coarse:hidden">⌘N</span>
        </a>
      </div>

      {(threads.length > 6 || projects.length > 1) && <div className="px-2 pt-3 flex-none flex items-center gap-1">
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQ('')} placeholder="Filter" aria-label="Filter threads"
          className="flex-1 min-w-0 h-7 pointer-coarse:h-9 px-2.5 rounded-md bg-transparent border border-transparent hover:border-line focus:border-tide/60 text-[13px] placeholder:text-ash focus:outline-none" />
        {projects.length > 1 && <div className="relative">
          <button onClick={() => setFilterMenu(!filterMenu)} aria-expanded={filterMenu} aria-label="Choose which projects to show"
            data-tip={hidden.length ? `${hidden.length} project${hidden.length > 1 ? 's' : ''} hidden` : 'Show or hide projects'}
            className={`press h-7 pointer-coarse:h-9 px-1.5 rounded-md inline-flex items-center gap-1 text-[12px] hover:text-moon ${hidden.length ? 'text-tide' : 'text-ash'}`}>
            <ListFilter size={14} />{hidden.length > 0 && <span className="tabular-nums">{projects.length - hidden.length}/{projects.length}</span>}
          </button>
          <Menu open={filterMenu} onClose={() => setFilterMenu(false)} align="right" className="w-60">
            <p className="label px-2.5 pt-1.5 pb-1">Projects in the sidebar</p>
            {projects.map(p => {
              const on = !hidden.includes(p.id);
              return <MenuItem key={p.id} icon={on ? <Check className="text-tide" /> : <span className="inline-block size-[15px]" />}
                onClick={() => setHidden(on ? [...hidden, p.id] : hidden.filter(x => x !== p.id))} kbd={p.id.slice(-6)}>{p.name}</MenuItem>;
            })}
            <div className="my-1 h-px bg-line" />
            <MenuItem icon={<Check />} onClick={() => { setHidden([]); setFilterMenu(false); }}>Show all</MenuItem>
            <MenuItem icon={<Search />} onClick={() => { setFilterMenu(false); useStore.setState({ palette: 'projects' }); }} kbd="⌘K">Filter with the keyboard</MenuItem>
            {projects.length > 2 && <MenuItem icon={<EyeOff />} onClick={() => { setHidden(projects.filter(p => !threads.some(t => t.projectId === p.id && t.status !== 'archived')).map(p => p.id)); setFilterMenu(false); }}>Hide projects with no threads</MenuItem>}
          </Menu>
        </div>}
        <button onClick={() => selecting ? endSelect() : setSelecting(true)} aria-pressed={selecting} className="press h-7 pointer-coarse:h-9 px-2 rounded-md text-[12px] text-ash hover:text-moon aria-pressed:text-tide">{selecting ? 'Done' : 'Select'}</button>
      </div>}
      {selecting && <div className="mx-2 mt-2 flex-none flex items-center gap-1.5 rounded-lg bg-ridge px-2.5 py-1.5 text-[12.5px] animate-fade">
        <span className="flex-1 text-dust">{picked.size} selected</span>
        <button disabled={!picked.size} className="press px-2 h-7 pointer-coarse:h-9 rounded-md hover:bg-line disabled:opacity-40" onClick={() => { archiveWithUndo(threads.filter(t => picked.has(t.id))); endSelect(); }}>Archive</button>
        <button disabled={!picked.size} className="press px-2 h-7 pointer-coarse:h-9 rounded-md text-oxide hover:bg-line disabled:opacity-40" onClick={() => { deleteWithUndo(threads.filter(t => picked.has(t.id))); endSelect(); }}>Delete</button>
      </div>}
      <SelectCtx.Provider value={selCtx}>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pt-3 pb-3 space-y-3.5">
        {threads.some(openHumanTask) && <Section id="for-me" title="For me" count={threads.filter(openHumanTask).length} collapsed={!!collapsed['for-me']} toggle={toggle} icon={<Check size={12} className="text-tide" />}>
          {threads.filter(openHumanTask).sort((a, b) => b.humanTask!.at - a.humanTask!.at).map(t => <div key={t.id} className={`flex gap-1 pl-2 pr-1 py-1 rounded-lg ${t.id === activeId ? 'bg-ridge' : 'hover:bg-ridge/55'}`}>
            <TaskCheck thread={t} />
            <a href={`#/t/${t.id}`} onClick={close} className="flex-1 min-w-0 py-1 rounded-md" aria-current={t.id === activeId ? 'page' : undefined}>
              <p className="truncate text-[13px] text-moon">{t.title}</p>{space && !belongs(t) && <p className="text-[10.5px] text-ash">{spaces.find(s => s.id === projects.find(p => p.id === t.projectId)?.space)?.name ?? 'All'}</p>}<p className="truncate text-[11.5px] text-dust mt-0.5" title={t.humanTask!.text}>{t.humanTask!.text}</p>
            </a>
          </div>)}
        </Section>}
        {space && !shown.length && <div className="px-3 py-2 space-y-2 text-[13px] text-ash">
          <p>{projects.some(p => inSpace(p, space)) ? 'This space’s projects are hidden.' : 'No projects here yet. Move one here from All.'}</p>
          <button onClick={() => projects.some(p => inSpace(p, space)) ? setHidden(hidden.filter(id => !projects.some(p => p.id === id && inSpace(p, space)))) : useStore.getState().setActiveSpace('')}
            className="press text-tide hover:text-moon">{projects.some(p => inSpace(p, space)) ? 'Show projects' : 'Choose from All'}</button>
        </div>}
        {otherAttention.length > 0 && <Section id="other-input" title="Waiting · other spaces" count={otherAttention.length} collapsed={!!collapsed['other-input']} toggle={toggle}>
          {otherAttention.map(t => <div key={t.id}><p className="pl-3 text-[10.5px] text-ash">{spaces.find(s => s.id === projects.find(p => p.id === t.projectId)?.space)?.name ?? 'All'}</p><ThreadLink t={t} active={t.id === activeId} minute={minute} /></div>)}
        </Section>}
        {showArchived && <div className="flex items-center gap-2 px-2 text-[12px] text-dust animate-fade">
          <Archive size={12} className="text-tide" /><span className="flex-1">Archived · {scoped.length} {scoped.length === 1 ? 'thread' : 'threads'}</span>
          <button onClick={() => setShowArchived(false)} className="press text-tide hover:underline">Show active</button>
        </div>}
        {matches ? <div className="space-y-px">{matches.length ? matches.map(t => <ThreadLink key={t.id} t={t} active={t.id === activeId} minute={minute} />) : <p className="px-3 py-2 text-[13px] text-ash">No thread matches “{q}”.</p>}</div> : <>
        {pinned.length > 0 && <Section id="pinned" title="Pinned" collapsed={!!collapsed.pinned} toggle={toggle}>{pinned.map(t => <ThreadLink key={t.id} t={t} active={t.id === activeId} minute={minute} />)}</Section>}
        {hosts.length > 0 && !space && <p className="flex items-center gap-1.5 pl-2 text-[11px] font-bold text-dust"><Laptop size={12} />This Mac</p>}
        {shown.map((p, pi) => {
          const list = visible.filter(t => t.projectId === p.id);
          const boardActive = route.name === 'board' && route.projectId === p.id;
          return (
            <Section key={p.id} id={p.id} title={p.name} accent={list.filter(t => t.status === 'running').length} collapsed={!!collapsed[p.id]} toggle={toggle}
              href={`#/board/${p.id}`} active={boardActive} onNavigate={close} onMenu={() => { setSpaceMenu(false); setProjMenu(p.id); }}
              drag={{
                dragging: drag?.id === p.id,
                over: drag && drag.id !== p.id && drag.over === p.id ? drag.where ?? null : null,
                onStart: () => setDrag({ id: p.id }),
                onOver: () => setDrag(d => d && d.over !== p.id ? { ...d, over: p.id, where: shown.findIndex(x => x.id === d.id) < pi ? 'below' : 'above' } : d),
                onDrop: () => { if (drag && drag.id !== p.id) place(drag.id, p.id, drag.where ?? 'above'); setDrag(null); },
                onEnd: () => setDrag(null),
              }}
              actions={<>
                <a href={`#/new/${p.id}`} onClick={close} data-tip="New thread here" aria-label={`New thread in ${p.name}`} className="press size-6 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-ridge"><Plus size={14} /></a>
                <span className="relative">
                  <button onClick={() => { setSpaceMenu(false); setProjMenu(projMenu === p.id ? null : p.id); }} aria-label={`${p.name} options`} aria-expanded={projMenu === p.id} className="press size-6 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-ridge"><MoreHorizontal size={14} /></button>
                  <Menu open={projMenu === p.id} onClose={() => { setProjMenu(null); setSpaceMenu(false); }} align="right">
                    {spaceMenu ? <SpaceItems project={p} onClose={() => { setProjMenu(null); setSpaceMenu(false); }} /> : <>
                    <MenuItem onClick={() => setSpaceMenu(true)}>{spaces.length ? 'Move to space…' : 'Add to a space…'}</MenuItem>
                    <MenuItem icon={<ArrowUp />} onClick={() => { move(p.id, -1); setProjMenu(null); }}>Move up</MenuItem>
                    <MenuItem icon={<ArrowDown />} onClick={() => { move(p.id, 1); setProjMenu(null); }}>Move down</MenuItem>
                    <MenuItem icon={<EyeOff />} onClick={() => { setHidden([...hidden, p.id]); setProjMenu(null); }}>Hide from sidebar</MenuItem>
                    </>}
                  </Menu>
                </span>
              </>}>
              {list.map(t => <ThreadLink key={t.id} t={t} active={t.id === activeId} minute={minute} />)}
            </Section>
          );
        })}
        {loose.length > 0 && <Section id="chats" title="Chats" collapsed={!!collapsed.chats} toggle={toggle}>{loose.map(t => <ThreadLink key={t.id} t={t} active={t.id === activeId} minute={minute} />)}</Section>}
        {bySource.map(([src, list]) => (
          <Section key={src} id={`src:${src}`} title={sourceLabel(src)} count={list.length} collapsed={!!collapsed[`src:${src}`]} toggle={toggle}>
            {list.map(t => <ThreadLink key={t.id} t={t} active={t.id === activeId} minute={minute} />)}
          </Section>
        ))}
        <button onClick={onAddProject} className="press flex items-center gap-2 pl-3 py-1 pointer-coarse:py-2.5 rounded-lg text-[13px] text-ash hover:text-moon"><FolderPlus size={14} />Add project</button>
        {hosts.map(h => {
          const list = visible.filter(t => t.host === h.id);
          if (space && !list.length) return null;
          return (
            <div key={h.id} className="pt-3 border-t border-line">
              <Section id={`host:${h.id}`} title={h.name} accent={list.filter(t => t.status === 'running').length} collapsed={!!collapsed[`host:${h.id}`]} toggle={toggle}
                icon={<span className="relative flex-none" data-tip={h.connected ? `Remote · connected over SSH (${h.ssh})` : `Remote · connecting to ${h.ssh}`}>
                  <Server size={12} className="text-tide" /><span className={`absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-basalt ${h.connected ? 'bg-sprout' : 'bg-halo animate-pulse'}`} /></span>}
                actions={<a href={`#/new?host=${h.id}`} onClick={close} data-tip={`New thread on ${h.name}`} aria-label={`New thread on ${h.name}`} className="press size-6 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-ridge"><Plus size={14} /></a>}>
                <p className="pl-3 pb-0.5 label text-[9.5px] text-tide/80">remote</p>
                {list.length ? list.map(t => <ThreadLink key={t.id} t={t} active={t.id === activeId} minute={minute} />)
                  : <p className="pl-3 py-1 text-[12.5px] text-ash">{h.connected ? 'No threads here yet' : 'Connecting…'}</p>}
              </Section>
            </div>
          );
        })}
        </>}
      </div>
      </SelectCtx.Provider>

      <div className="px-2 py-2 border-t border-line flex-none safe-b safe-b-bar">
        {/* Phones: the places below fold away so the threads get the height; the fold is remembered. Desktop: always open. */}
        <button onClick={() => setMore(m => { localStorage.setItem('gibbous.sidebarMore', m ? '0' : '1'); return !m; })} aria-expanded={more}
          className="lg:hidden press flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg text-[13.5px] text-dust hover:text-moon hover:bg-ridge/55">
          <MoreHorizontal size={15} /><span className="flex-1 text-left">{more ? 'Less' : 'Kanban, sessions, settings…'}</span>
          <ChevronDown size={15} className={`text-ash transition-transform duration-300 ease-out ${more ? 'rotate-180' : ''}`} />
        </button>
        <div className={`grid transition-[grid-template-rows] duration-300 ease-out lg:grid-rows-[1fr] ${more ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className={`min-h-0 overflow-hidden space-y-0.5 transition-opacity duration-300 lg:opacity-100 ${more ? 'opacity-100' : 'opacity-0'}`}>
        {/* A filter, not a place: when on it's tinted (not the page highlight) and says how to get back. */}
        <button onClick={() => setShowArchived(!showArchived)} aria-pressed={showArchived}
          className={`press group relative flex items-center gap-2.5 rounded-lg text-[13.5px] w-full px-3 py-1.5 pointer-coarse:py-2.5 ${showArchived ? 'text-tide bg-tide/10 hover:bg-tide/15' : 'text-dust hover:text-moon hover:bg-ridge/55'}`}>
          <Archive size={15} /><span className="flex-1 text-left">{showArchived ? 'Viewing archived' : 'Archived'}</span>{showArchived && <X size={14} className="opacity-70" />}
        </button>
        {nav('#/kanban', <KanbanSquare size={15} />, 'Kanban', route.name === 'kanban')}
        {nav('#/automations', <CalendarClock size={15} />, 'Automations', route.name === 'automations')}
        {nav('#/rooms', <Users size={15} />, 'Rooms', route.name === 'rooms')}
        {nav('#/sessions', <History size={15} />, 'Sessions', route.name === 'sessions')}
        {nav('#/settings', <Settings size={15} />, 'Settings', route.name === 'settings')}
        </div>
        </div>
      </div>
      <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuenow={width.w} aria-valuemin={SB_MIN} aria-valuemax={SB_MAX} tabIndex={0}
        data-tip="Drag to resize · double-click to reset" {...width.handle}
        className={`hidden lg:block absolute inset-y-0 -right-1 w-2 z-10 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-tide/60 focus-visible:after:bg-tide/60 focus:outline-none ${width.dragging ? 'after:bg-tide/80' : ''}`} />
      {width.dragging && <div className="fixed inset-0 z-[60] cursor-col-resize" />}
    </nav>
  </>;
}
