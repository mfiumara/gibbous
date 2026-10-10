// Hermes' kanban, read and acted on through the Gibbous server (server/kanban.ts). Gibbous keeps no tasks of its own:
// `#/board/<projectId>` shows the board matched to that project, `#/kanban` lists every board, `#/kanban/<slug>` opens one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Menu as MenuIcon, Plus, Archive, Link2, Unlink, Settings2, GitBranch, MessageSquare, AlertTriangle, Ban, Search, Eye, Undo2, Trash2, ChevronRight, KanbanSquare, CornerDownLeft, Network, Columns3 } from 'lucide-react';
import { api, type KanbanBoard, type KanbanCard, type KanbanColumn, type BoardMatch, type Project } from '../api';
import { useStore, toastError } from '../store';
import { Button, IconButton, Modal, Field, Menu, MenuItem, Moon, MoonLoader, Empty, Elapsed, Skeleton, Segmented, inputCls, go, NO_PREDICT } from '../ui';
import { TranscriptModal } from '../thread/TranscriptModal';
import { LABEL, HINT, visibleColumns, stepColumn, filterColumns, eventGist, agoS } from './board';
import { GraphView } from './Graph';
import { graphTasks, type Link } from './graphLayout';

type Boards = { boards: KanbanBoard[]; current: string; matches: Record<string, BoardMatch> };
type BoardData = { columns: KanbanColumn[]; assignees: string[]; now: number };
interface Detail {
  task: KanbanCard & { body: string; result: string | null; summary: string | null; workspace: string | null; createdBy: string | null; lastError: string | null };
  comments: { id: number; author: string; body: string; at: number }[];
  events: { id: number; kind: string; payload: unknown; at: number; runId: number | null }[];
  runs: { id: number; profile: string | null; status: string; outcome: string | null; summary: string | null; error: string | null; startedAt: number | null; endedAt: number | null; sessionId: string | null }[];
  links: { id: string; title: string; status: KanbanCard['status']; parent: boolean }[];
}

const base = (slug: string) => `/api/kanban/boards/${encodeURIComponent(slug)}/tasks`;
// Board or Graph, and the graph's "hide done", remembered per board. Hide done defaults on once done tasks pile up.
type ViewKind = 'board' | 'graph';
const viewKey = (slug: string) => `gibbous.kanban.view.${slug}`, hideKey = (slug: string) => `gibbous.kanban.hideDone.${slug}`;
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const MANY_DONE = 12;
const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement; return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName); };
const HOW: Record<BoardMatch['how'], string> = { linked: 'linked by hand', workdir: 'board workdir is this project', 'hermes-project': 'board is scoped to a project with this folder', inside: 'board workdir is inside this project' };

// Re-run `fn` every `ms` while the tab is visible (the caller loads once itself); a tab coming back refreshes at once.
function usePoll(fn: () => void, ms: number, on = true) {
  const f = useRef(fn); f.current = fn;
  useEffect(() => {
    if (!on) return;
    let h: ReturnType<typeof setInterval> | undefined;
    const run = () => { clearInterval(h); if (document.visibilityState === 'visible') h = setInterval(() => f.current(), ms); };
    const start = () => { if (document.visibilityState === 'visible') f.current(); run(); };
    run();
    document.addEventListener('visibilitychange', start);
    return () => { clearInterval(h); document.removeEventListener('visibilitychange', start); };
  }, [ms, on]);
}

function useBoards() {
  const [b, setB] = useState<Boards>();
  const [err, setErr] = useState<string>();
  const load = useCallback(() => api.get<Boards>('/api/kanban/boards').then(r => { setB(r); setErr(undefined); }, e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  return { boards: b, err, reload: load };
}

function Header({ children }: { children: React.ReactNode }) {
  return <header data-drag-window className="flex items-center gap-2 px-3 h-12 border-b border-line flex-none">
    <IconButton label="Open sidebar" className="lg:hidden" onClick={() => useStore.setState({ sidebar: true })}><MenuIcon size={17} /></IconButton>
    {children}
  </header>;
}

const BoardIcon = ({ b, size = 15 }: { b?: KanbanBoard; size?: number }) => b?.icon
  ? <span aria-hidden style={{ fontSize: size }} className="leading-none">{b.icon}</span>
  : <KanbanSquare size={size} className="text-ash" style={b?.color ? { color: b.color } : undefined} />;

// ── index: every board ────────────────────────────────────────────────
export function KanbanIndex() {
  const { boards, err } = useBoards();
  const projects = useStore(s => s.projects);
  const live = boards?.boards.filter(b => !b.archived) ?? [];
  return (
    <div className="h-full flex flex-col">
      <Header><h1 className="font-bold">Kanban</h1><span className="label text-ash hidden sm:inline">All boards</span></Header>
      {err ? <Empty title="Hermes kanban isn't available"><p className="select-text">{err}</p></Empty>
        : !boards ? <div className="grid place-items-center flex-1"><MoonLoader size={40} label="Loading boards" /></div>
        : !live.length ? <Empty title="No kanban boards yet"><p>Create one with <code className="font-mono">hermes kanban boards create</code>.</p></Empty>
        : <div className="flex-1 overflow-y-auto"><ul data-vim-list className="mx-auto max-w-3xl p-4 space-y-2">
          {live.map(b => {
            const linked = projects.filter(p => boards.matches[p.id]?.slug === b.slug);
            return <li key={b.slug}><a data-vim-item href={`#/kanban/${b.slug}`} className="tile flex items-center gap-3 rounded-xl px-3.5 py-3 focus-visible:outline-2 focus-visible:outline-tide">
              <span className="size-7 grid place-items-center flex-none"><BoardIcon b={b} size={18} /></span>
              <span className="flex-1 min-w-0">
                <span className="flex items-baseline gap-2"><span className="font-bold text-sm truncate">{b.name}</span><span className="font-mono text-[11px] text-ash">{b.slug}</span>{b.current && <span className="label text-tide" data-tip="The board `hermes kanban` uses without --board">current</span>}</span>
                {b.description && <span className="block text-[12.5px] text-dust truncate">{b.description}</span>}
                {linked.length > 0 && <span className="block text-[11.5px] text-ash truncate">{linked.map(p => p.name).join(', ')}</span>}
              </span>
              <Counts b={b} />
              <ChevronRight size={14} className="text-ash flex-none" />
            </a></li>;
          })}
        </ul></div>}
    </div>
  );
}

function Counts({ b }: { b: KanbanBoard }) {
  const c = b.counts;
  return <span className="flex items-center gap-2.5 text-[12px] text-dust tabular-nums flex-none">
    {!!c.running && <span className="inline-flex items-center gap-1" data-tip={`${c.running} running`}><Moon kanban="running" size={8} />{c.running}</span>}
    {!!c.blocked && <span className="inline-flex items-center gap-1" data-tip={`${c.blocked} blocked`}><Moon kanban="blocked" size={8} />{c.blocked}</span>}
    {!!((c.todo ?? 0) + (c.ready ?? 0)) && <span className="hidden sm:inline-flex items-center gap-1" data-tip="To do and ready"><Moon kanban="todo" size={8} />{(c.todo ?? 0) + (c.ready ?? 0)}</span>}
    <span className="hidden sm:inline-flex items-center gap-1" data-tip={`${c.done ?? 0} done`}><Moon kanban="done" size={8} />{c.done ?? 0}</span>
  </span>;
}

// ── one board (a project's, or any by slug) ────────────────────────────
export function Kanban({ projectId, slug: fixed }: { projectId?: string; slug?: string }) {
  const project = useStore(s => projectId ? s.projects.find(p => p.id === projectId) : undefined);
  const { boards, err, reload } = useBoards();
  const match = project && boards?.matches[project.id];
  const slug = fixed ?? match?.slug;
  const board = boards?.boards.find(b => b.slug === slug);
  const [settings, setSettings] = useState(false);

  if (projectId && !project) return <Empty title="Project not found" />;
  const settingsBtn = project && <IconButton label="Project settings" onClick={() => setSettings(true)}><Settings2 size={16} /></IconButton>;
  const dialogs = project && <ProjectSettings project={project} open={settings} onClose={() => setSettings(false)} />;
  if (err) return <div className="h-full flex flex-col"><Header><h1 className="font-bold truncate">{project?.name ?? fixed}</h1><span className="ml-auto">{settingsBtn}</span></Header>
    <Empty title="Hermes kanban isn't available"><p className="select-text">{err}</p><Button onClick={reload}>Try again</Button></Empty>{dialogs}</div>;
  if (!boards) return <div className="h-full grid place-items-center"><MoonLoader size={40} label="Loading board" /></div>;
  if (!slug || !board) return <div className="h-full flex flex-col">
    <Header><h1 className="font-bold truncate">{project?.name ?? fixed}</h1><span className="ml-auto">{settingsBtn}</span></Header>
    {project ? <LinkBoard project={project} boards={boards} onLinked={reload} /> : <Empty title="No such board"><a className="text-tide hover:underline" href="#/kanban">All boards</a></Empty>}
    {dialogs}
  </div>;
  return <>
    <BoardView key={board.slug} board={board} project={project} match={match || undefined} boards={boards} onRelink={reload} onSettings={settingsBtn ? () => setSettings(true) : undefined} />
    {dialogs}
  </>;
}

function LinkBoard({ project, boards, onLinked }: { project: Project; boards: Boards; onLinked(): void }) {
  const link = (slug: string) => api.patch(`/api/projects/${project.id}`, { kanbanBoard: slug }).then(onLinked, toastError);
  const live = boards.boards.filter(b => !b.archived);
  return <div className="flex-1 overflow-y-auto"><div className="mx-auto max-w-lg p-6 space-y-4 animate-rise">
    <p className="font-bold text-[15px]">No board for {project.name}</p>
    <p className="text-sm text-dust">Gibbous shows a project's work from the agent's kanban. A board matches when its default workdir is this project's folder (or inside it). <span className="font-mono text-[12px] select-text">{project.path}</span></p>
    {live.length ? <>
      <p className="label">Link an existing board</p>
      <ul data-vim-list className="space-y-1.5">{live.map(b => <li key={b.slug}>
        <button data-vim-item onClick={() => link(b.slug)} className="tile w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-tide">
          <span className="size-6 grid place-items-center flex-none"><BoardIcon b={b} /></span>
          <span className="flex-1 min-w-0"><span className="block text-sm font-bold truncate">{b.name}</span><span className="block text-[11.5px] text-ash font-mono truncate">{b.defaultWorkdir ?? 'no default workdir'}</span></span>
          <span className="text-[12px] text-ash tabular-nums">{b.total}</span><Link2 size={13} className="text-ash" />
        </button></li>)}</ul>
    </> : null}
    <p className="text-[12.5px] text-ash">Or create one in a terminal: <code className="font-mono select-text">hermes kanban boards create {project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')} --workdir {project.path}</code></p>
  </div></div>;
}

function BoardView({ board, project, match, boards, onRelink, onSettings }: { board: KanbanBoard; project?: Project; match?: BoardMatch; boards: Boards; onRelink(): void; onSettings?(): void }) {
  const [data, setData] = useState<BoardData>();
  const [err, setErr] = useState<string>();
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [linkMenu, setLinkMenu] = useState(false);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [view, setViewState] = useState<ViewKind>(() => stored(viewKey(board.slug)) === 'graph' ? 'graph' : 'board');
  const setView = (v: ViewKind) => { store(viewKey(board.slug), v); setViewState(v); };
  const [hideDonePref, setHideDonePref] = useState(() => stored(hideKey(board.slug)));
  const [links, setLinks] = useState<Link[]>();
  const loadLinks = useCallback(() => api.get<{ links: Link[] }>(`/api/kanban/boards/${encodeURIComponent(board.slug)}/links`).then(r => setLinks(r.links), e => { setErr(e.message); setLinks(l => l ?? []); }), [board.slug]);
  usePoll(loadLinks, 8000, view === 'graph');
  useEffect(() => { if (view === 'graph') loadLinks(); }, [view, loadLinks]);
  const load = useCallback(() => api.get<BoardData>(`${base(board.slug)}${archived ? '?archived=1' : ''}`).then(d => { setData(d); setErr(undefined); }, e => setErr(e.message)), [board.slug, archived]);
  usePoll(load, 4000);
  useEffect(() => { load(); }, [load]);
  const cols = useMemo(() => data ? filterColumns(visibleColumns(data.columns, archived), q) : [], [data, archived, q]);
  const open_ = data?.columns.reduce((n, c) => n + (c.name === 'archived' || c.name === 'done' ? 0 : c.tasks.length), 0) ?? 0;
  const scroller = useRef<HTMLDivElement>(null);
  const graph = useMemo(() => {
    if (!data || view !== 'graph') return null;
    const all = visibleColumns(data.columns, archived).flatMap(c => c.tasks);
    const doneCount = all.filter(t => t.status === 'done').length;
    const hideDone = hideDonePref == null ? doneCount > MANY_DONE : hideDonePref === '1';
    const kept = graphTasks(all, links ?? [], hideDone);
    const tasks = filterColumns([{ name: 'todo', tasks: kept }], q)[0].tasks;
    return { tasks, doneCount, hideDone };
  }, [data, view, archived, links, hideDonePref, q]);

  // h/l: jump to the previous/next column with cards (j/k inside the column are App.tsx's [data-vim-list] walk).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'v' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e) && !document.querySelector('[role=dialog], [role=menu], dialog[open]')) { e.preventDefault(); setView(view === 'board' ? 'graph' : 'board'); return; }
      if (view !== 'board' || (e.key !== 'h' && e.key !== 'l') || e.metaKey || e.ctrlKey || e.altKey || typing(e) || document.querySelector('[role=dialog], [role=menu], dialog[open]')) return;
      const sections = [...(scroller.current?.querySelectorAll<HTMLElement>('section[data-col]') ?? [])];
      const at = sections.findIndex(s => s.contains(document.activeElement));
      const to = at < 0 ? stepColumn(cols, -1, 1) : stepColumn(cols, at, e.key === 'l' ? 1 : -1);
      if (to == null) return;
      e.preventDefault();
      const card = sections[to]?.querySelector<HTMLElement>('[data-vim-item]');
      card?.focus(); card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [cols, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const unlink = () => project && api.patch(`/api/projects/${project.id}`, { kanbanBoard: '' }).then(() => { setLinkMenu(false); onRelink(); }, toastError);
  const relink = (slug: string) => project && api.patch(`/api/projects/${project.id}`, { kanbanBoard: slug }).then(() => { setLinkMenu(false); onRelink(); }, toastError);

  return (
    <div className="h-full flex flex-col">
      <Header>
        <span className="size-6 grid place-items-center flex-none"><BoardIcon b={board} /></span>
        <div className="min-w-0 flex-1 sm:flex-none sm:max-w-[45%]">
          <h1 className="font-bold truncate leading-tight" data-tip={project ? `${project.name} · ${match ? HOW[match.how] : ''}` : board.slug}>{board.name}</h1>
          {board.description && <p className="text-[11.5px] text-dust truncate leading-tight" data-tip={board.description}>{board.description}</p>}
        </div>
        <span className="hidden md:inline label text-ash" data-tip="Not done or archived">{open_} open</span>
        <div className="ml-auto flex items-center gap-1">
          <Segmented label="View" value={view} onChange={setView} options={[
            { value: 'board', label: <span className="inline-flex items-center gap-1.5"><Columns3 size={14} /><span className="hidden sm:inline">Board</span></span>, tip: 'Columns by status (v)' },
            { value: 'graph', label: <span className="inline-flex items-center gap-1.5"><Network size={14} /><span className="hidden sm:inline">Graph</span></span>, tip: 'Dependencies: what waits on what (v)' },
          ]} />
          <label className="hidden sm:flex items-center gap-1.5 well rounded-lg px-2 h-7.5 w-44 focus-within:border-tide/60"><Search size={13} className="text-ash flex-none" />
            <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setQ(''); (e.target as HTMLElement).blur(); } }} placeholder="Filter cards" aria-label="Filter cards" className="bg-transparent text-[13px] w-full focus:outline-none placeholder:text-ash" {...NO_PREDICT} /></label>
          <IconButton label={archived ? 'Hide archived' : 'Show archived'} aria-pressed={archived} className={archived ? 'text-tide' : ''} onClick={() => setArchived(!archived)}><Archive size={16} /></IconButton>
          {project && <span className="relative">
            <IconButton label="Linked board" aria-expanded={linkMenu} onClick={() => setLinkMenu(!linkMenu)}><Link2 size={16} /></IconButton>
            <Menu open={linkMenu} onClose={() => setLinkMenu(false)} align="right">
              <p className="px-2.5 pt-1 pb-1.5 text-[11.5px] text-ash">{match ? `Matched: ${HOW[match.how]}` : ''}</p>
              {boards.boards.filter(b => !b.archived && b.slug !== board.slug).map(b => <MenuItem key={b.slug} icon={<BoardIcon b={b} />} onClick={() => relink(b.slug)}>Show {b.name} instead</MenuItem>)}
              {match?.how === 'linked' && <MenuItem icon={<Unlink />} onClick={unlink}>Unlink (match by folder again)</MenuItem>}
              <MenuItem icon={<KanbanSquare />} onClick={() => go(`/kanban/${board.slug}`)}>Open as its own board</MenuItem>
            </Menu>
          </span>}
          {onSettings && <IconButton label="Project settings" onClick={onSettings}><Settings2 size={16} /></IconButton>}
          <Button size="sm" tone="primary" onClick={() => setCreating(true)} aria-label="New task"><Plus size={14} /><span className="hidden sm:inline">Task</span></Button>
        </div>
      </Header>
      {err && <p className="px-4 py-2 text-[13px] text-oxide select-text border-b border-line">{err}</p>}
      {view === 'graph' ? (!data || !links || !graph ? <div className="grid place-items-center flex-1"><MoonLoader size={36} label="Loading dependencies" /></div>
        : <GraphView tasks={graph.tasks} links={links} now={data.now} hideDone={graph.hideDone} doneCount={graph.doneCount} onOpen={setOpen}
          onHideDone={v => { store(hideKey(board.slug), v ? '1' : '0'); setHideDonePref(v ? '1' : '0'); }} fitKey={`${board.slug}|${archived}|${graph.hideDone}|${q.trim()}`} />)
      : !data ? <div className="flex gap-3 p-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-40 w-[280px] rounded-2xl" />)}</div> : (
        <div ref={scroller} data-vim-list className="flex-1 min-h-0 overflow-x-auto snap-x snap-mandatory sm:snap-none overscroll-x-contain">
          <div className="flex gap-3 p-3 h-full w-max min-w-full">
            {cols.map(col => {
              const cap = col.name === 'done' || col.name === 'archived' ? 40 : 200, shown = more[col.name] ? col.tasks : col.tasks.slice(0, cap);
              return (
                <section key={col.name} data-col={col.name} aria-label={LABEL[col.name]}
                  className="snap-center w-[calc(100vw-24px)] sm:w-[288px] lg:w-auto lg:flex-1 lg:min-w-[264px] lg:max-w-[420px] flex-none flex flex-col rounded-2xl bg-crater/45">
                  <div className="flex items-center gap-2 px-3 pt-3 pb-2" data-tip={HINT[col.name]}>
                    <Moon kanban={col.name} size={8} /><h2 className="label text-moon/80">{LABEL[col.name]}</h2><span className="label text-ash">{col.tasks.length}</span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-2">
                    {shown.map(t => <Card key={t.id} t={t} now={data.now} onOpen={() => setOpen(t.id)} />)}
                    {col.tasks.length > shown.length && <button className="press w-full rounded-lg py-1.5 text-[12.5px] text-dust hover:text-moon hover:bg-ridge/50" onClick={() => setMore(m => ({ ...m, [col.name]: true }))}>Show all {col.tasks.length}</button>}
                    {!col.tasks.length && <p className="px-1.5 py-2 text-[12.5px] text-ash">{q ? 'No matches' : HINT[col.name]}</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
      <TaskSheet slug={board.slug} id={open} assignees={data?.assignees ?? []} onClose={() => setOpen(null)} onChanged={load} onOpen={setOpen} />
      <CreateTask slug={board.slug} open={creating} assignees={data?.assignees ?? []} onClose={() => setCreating(false)} onCreated={id => { load(); setOpen(id); }} />
    </div>
  );
}

function Card({ t, now, onOpen }: { t: KanbanCard; now: number; onOpen(): void }) {
  const blocked = t.status === 'blocked';
  return (
    <button data-vim-item onClick={onOpen} className="tile w-full text-left rounded-xl px-3 py-2.5 space-y-1.5 focus-visible:outline-2 focus-visible:outline-tide">
      <span className="flex items-start gap-2">
        <span className="mt-[5px] flex-none"><Moon kanban={t.status} size={8} /></span>
        <span className="flex-1 min-w-0 text-[13.5px] leading-snug line-clamp-3">{t.title}</span>
        {t.priority > 0 && <span className="label text-halo flex-none" data-tip={`Priority ${t.priority}`}>P{t.priority}</span>}
      </span>
      {t.summary && <span className="text-[12px] text-dust line-clamp-2 pl-4">{t.summary}</span>}
      <span className="flex items-center gap-x-2.5 gap-y-1 flex-wrap pl-4 text-[11.5px] text-ash">
        <span className="font-mono">{t.id}</span>
        {t.assignee && <span className="text-dust truncate max-w-[9rem]" data-tip="Assigned profile">{t.assignee}</span>}
        {t.status === 'running' && t.runStartedAt ? <span className="text-tide" data-tip="Running for"><Elapsed since={t.runStartedAt * 1000} /></span>
          : t.status === 'done' && t.completedAt ? <span data-tip="Completed">{agoS(t.completedAt, now)}</span> : null}
        {t.parents > 0 && <span className="inline-flex items-center gap-0.5" data-tip={`Depends on ${t.parents} task${t.parents > 1 ? 's' : ''}`}><GitBranch size={11} className="rotate-180" />{t.parents}</span>}
        {t.progress && <span className="inline-flex items-center gap-0.5" data-tip={`${t.progress.done} of ${t.progress.total} child tasks done`}><GitBranch size={11} />{t.progress.done}/{t.progress.total}</span>}
        {t.comments > 0 && <span className="inline-flex items-center gap-0.5" data-tip={`${t.comments} comment${t.comments > 1 ? 's' : ''}`}><MessageSquare size={11} />{t.comments}</span>}
        {blocked && <span className="inline-flex items-center gap-0.5 text-halo" data-tip={t.blockKind ? `Blocked (${t.blockKind})` : 'Blocked'}><Ban size={11} />{t.blockKind ?? 'blocked'}</span>}
        {t.warnings > 0 && <span className="inline-flex items-center gap-0.5 text-oxide" data-tip={`${t.warnings} diagnostic warning${t.warnings > 1 ? 's' : ''}`}><AlertTriangle size={11} />{t.warnings}</span>}
      </span>
    </button>
  );
}

// ── card detail ────────────────────────────────────────────────────────
function TaskSheet({ slug, id, assignees, onClose, onChanged, onOpen }: { slug: string; id: string | null; assignees: string[]; onClose(): void; onChanged(): void; onOpen(id: string): void }) {
  const [d, setD] = useState<Detail>();
  const [comment, setComment] = useState('');
  const [blocking, setBlocking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<{ id: string; profile?: string; title: string } | null>(null);
  const load = useCallback(() => { if (id) api.get<Detail>(`${base(slug)}/${encodeURIComponent(id)}`).then(setD, toastError); }, [slug, id]);
  useEffect(() => { setD(undefined); setComment(''); setBlocking(null); load(); }, [load]);
  usePoll(load, 4000, !!id);
  const act = async (verb: string, body: Record<string, unknown> = {}) => {
    if (!id) return;
    setBusy(true);
    try { await api.post(`${base(slug)}/${encodeURIComponent(id)}/${verb}`, body); load(); onChanged(); return true; }
    catch (e) { toastError(e); return false; } finally { setBusy(false); }
  };
  const t = d?.task;
  const timeline = useMemo(() => d ? [
    ...d.events.map(e => ({ key: `e${e.id}`, at: e.at, text: eventGist(e.kind, e.payload), run: undefined as Detail['runs'][number] | undefined })),
    ...d.runs.map(r => ({ key: `r${r.id}`, at: r.startedAt ?? 0, text: `Run ${r.id}${r.profile ? ` · ${r.profile}` : ''} · ${r.outcome ?? r.status}${r.error ? ` · ${r.error}` : ''}`, run: r })),
  ].sort((a, b) => b.at - a.at) : [], [d]);
  return <>
    <Modal open={!!id} onClose={onClose} title={t?.title ?? 'Task'} wide bottom>
      {!d || !t ? <div className="space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-24" /></div> : <div className="max-h-[70dvh] overflow-y-auto -mx-1 px-1 space-y-5">
        <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap text-[12.5px] text-dust">
          <span className="inline-flex items-center gap-1.5 text-moon"><Moon kanban={t.status} size={9} />{LABEL[t.status]}</span>
          <span className="font-mono select-text">{t.id}</span>
          <label className="inline-flex items-center gap-1.5" data-tip="Profile that works on this task">
            <select value={t.assignee ?? ''} disabled={busy} onChange={e => act('assign', { assignee: e.target.value })} className="bg-transparent text-moon rounded-md hover:bg-ridge px-1 py-0.5 focus:outline-none">
              <option value="">Unassigned</option>{[...new Set([...(t.assignee ? [t.assignee] : []), ...assignees])].map(a => <option key={a} value={a}>{a}</option>)}
            </select></label>
          {t.priority > 0 && <span className="text-halo">P{t.priority}</span>}
          {t.createdBy && <span>by {t.createdBy}</span>}
          {t.branch && <span className="font-mono select-text inline-flex items-center gap-1"><GitBranch size={11} />{t.branch}</span>}
          {t.status === 'running' && t.runStartedAt && <span className="text-tide inline-flex items-center gap-1"><Moon kanban="running" size={7} /><Elapsed since={t.runStartedAt * 1000} /></span>}
        </div>
        {t.body && <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed rounded-xl bg-well border border-line px-3.5 py-3 max-h-72 overflow-y-auto">{t.body}</div>}
        {(t.summary || t.result) && <div className="space-y-1"><p className="label">{t.result ? 'Result' : 'Latest summary'}</p><div className="whitespace-pre-wrap text-[13px] text-dust">{t.result ?? t.summary}</div></div>}
        {t.lastError && <p className="text-[12.5px] text-oxide select-text">{t.lastError}</p>}
        {d.links.length > 0 && <div className="space-y-1"><p className="label">Dependencies</p><ul className="space-y-0.5">{d.links.map(l => <li key={l.id}>
          <button onClick={() => onOpen(l.id)} className="press w-full flex items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-ridge">
            <Moon kanban={l.status} size={8} /><span className="text-ash w-16 flex-none">{l.parent ? 'waits on' : 'unblocks'}</span><span className="flex-1 truncate">{l.title}</span><span className="font-mono text-[11px] text-ash">{l.id}</span>
          </button></li>)}</ul></div>}

        <div className="flex flex-wrap gap-2">
          {t.status === 'blocked' || t.status === 'scheduled'
            ? <Button size="sm" disabled={busy} onClick={() => act('unblock')}><Undo2 size={13} />Unblock</Button>
            : t.status !== 'done' && t.status !== 'archived' && (blocking == null
              ? <Button size="sm" disabled={busy} onClick={() => setBlocking('')}><Ban size={13} />Block…</Button>
              : <form className="flex gap-2 flex-1 min-w-[16rem]" onSubmit={e => { e.preventDefault(); act('block', { reason: blocking }).then(ok => ok && setBlocking(null)); }}>
                <input autoFocus className={inputCls + ' py-1.5'} value={blocking} onChange={e => setBlocking(e.target.value)} placeholder="Why is it blocked? (optional)" {...NO_PREDICT}
                  onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setBlocking(null); } }} />
                <Button size="sm" tone="halo" disabled={busy}>Block</Button></form>)}
          {t.status !== 'archived' && <Button size="sm" tone="danger" disabled={busy} onClick={() => confirm(`Archive “${t.title}”? It leaves the board (it stays under Archived).`) && act('archive').then(ok => ok && onClose())}><Trash2 size={13} />Archive</Button>}
        </div>

        <div className="space-y-2">
          <p className="label">Comments{d.comments.length ? ` · ${d.comments.length}` : ''}</p>
          {d.comments.map(c => <div key={c.id} className="rounded-xl bg-crater/60 px-3 py-2">
            <p className="text-[11.5px] text-ash"><span className="text-dust">{c.author}</span> · {agoS(c.at)}</p>
            <p className="whitespace-pre-wrap text-[13px] mt-0.5">{c.body}</p>
          </div>)}
          <form className="flex gap-2 items-end" onSubmit={e => { e.preventDefault(); act('comment', { body: comment }).then(ok => ok && setComment('')); }}>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Add a comment for the agents and people on this task" aria-label="Comment" className={inputCls + ' resize-none'} {...NO_PREDICT}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            <IconButton label="Post comment (⌘↩)" type="submit" disabled={busy || !comment.trim()}><CornerDownLeft size={15} /></IconButton>
          </form>
        </div>

        {timeline.length > 0 && <div className="space-y-1">
          <p className="label">Activity</p>
          <ol className="relative border-l border-line ml-1.5 space-y-0.5">{timeline.map(x => <li key={x.key} className="pl-3 py-0.5 text-[12.5px] flex items-baseline gap-2">
            <span className={`flex-1 min-w-0 truncate ${x.run ? 'text-moon' : 'text-dust'}`} data-tip={x.text}>{x.text}</span>
            {x.run?.sessionId && <button className="press inline-flex items-center gap-1 text-tide hover:underline flex-none" onClick={() => setSession({ id: x.run!.sessionId!, profile: x.run!.profile ?? undefined, title: `${t.title} · run ${x.run!.id}` })}><Eye size={12} />Session</button>}
            <span className="text-ash tabular-nums flex-none">{agoS(x.at)}</span>
          </li>)}</ol>
        </div>}
      </div>}
    </Modal>
    <TranscriptModal sessionId={session?.id ?? null} profile={session?.profile} title={session?.title ?? ''} onClose={() => setSession(null)} />
  </>;
}

function CreateTask({ slug, open, assignees, onClose, onCreated }: { slug: string; open: boolean; assignees: string[]; onClose(): void; onCreated(id: string): void }) {
  const [d, setD] = useState({ title: '', body: '', assignee: '', priority: 0 });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ task: KanbanCard | null; warning: string | null }>(base(slug), d);
      if (r.warning) useStore.getState().toast({ title: 'Task created', body: r.warning });
      setD({ title: '', body: '', assignee: '', priority: 0 }); onClose();
      if (r.task) onCreated(r.task.id);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New task" wide bottom>
      <Field label="Title"><input autoFocus className={inputCls} value={d.title} onChange={e => setD({ ...d, title: e.target.value })} {...NO_PREDICT} /></Field>
      <Field label="Details" hint="What done looks like; the assignee's agent reads this."><textarea className={inputCls + ' min-h-32'} value={d.body} onChange={e => setD({ ...d, body: e.target.value })} {...NO_PREDICT}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && d.title.trim()) { e.preventDefault(); save(); } }} /></Field>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Assignee" hint="Unassigned tasks wait until someone picks a profile."><select className={inputCls} value={d.assignee} onChange={e => setD({ ...d, assignee: e.target.value })}>
          <option value="">Unassigned</option>{assignees.map(a => <option key={a} value={a}>{a}</option>)}</select></Field>
        <Field label="Priority" hint="Higher runs first."><input type="number" className={inputCls} value={d.priority} onChange={e => setD({ ...d, priority: Number(e.target.value) || 0 })} /></Field>
      </div>
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button tone="primary" disabled={busy || !d.title.trim()} onClick={save}>Create task</Button></div>
    </Modal>
  );
}

// Project settings (name, base branch, worktree setup, terminal scripts); opened from the project's board header.
function ProjectSettings({ project, open, onClose }: { project: Project; open: boolean; onClose(): void }) {
  const [name, setName] = useState(project.name);
  const [baseBranch, setBase] = useState(project.baseBranch ?? '');
  const [setup, setSetup] = useState(project.setupScript ?? '');
  const [scripts, setScripts] = useState(project.scripts ?? []);
  const save = async () => { await api.patch(`/api/projects/${project.id}`, { name, baseBranch: baseBranch || undefined, setupScript: setup || undefined, scripts: scripts.filter(s => s.name.trim() && s.command.trim()) }).catch(toastError); onClose(); };
  const remove = async () => { if (!confirm(`Remove ${project.name} from Gibbous? Files, threads and its board stay.`)) return; await api.del(`/api/projects/${project.id}`).catch(toastError); go('/'); };
  const detect = async () => {
    const found = await api.get<{ name: string; command: string }[]>(`/api/projects/${project.id}/scripts/detect`).catch(toastError);
    if (found) setScripts(s => [...s, ...found.filter(f => !s.some(x => x.name === f.name))]);
  };
  const setScript = (i: number, patch: Partial<{ name: string; command: string }>) => setScripts(s => s.map((x, j) => j === i ? { ...x, ...patch } : x));
  return (
    <Modal open={open} onClose={onClose} title="Project settings" wide>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Name"><input className={inputCls} value={name} onChange={e => setName(e.target.value)} /></Field>
        {project.baseBranch !== undefined && <Field label="Base branch" hint="Worktree threads branch from here."><input className={inputCls + ' font-mono'} value={baseBranch} onChange={e => setBase(e.target.value)} /></Field>}
      </div>
      <p className="text-xs text-dust font-mono select-text">{project.path}</p>
      <Field label="Worktree setup script" hint="Runs in each new worktree, e.g. pnpm install."><textarea className={inputCls + ' font-mono text-[13px] min-h-16'} value={setup} onChange={e => setSetup(e.target.value)} placeholder="pnpm install" /></Field>
      <div className="space-y-2">
        <div className="flex items-center"><span className="label flex-1">Scripts</span><Button size="sm" onClick={detect}>Detect from package.json / Makefile</Button><Button size="sm" className="ml-1.5" onClick={() => setScripts(s => [...s, { name: '', command: '' }])}><Plus size={12} />Add</Button></div>
        <p className="text-xs text-dust">Buttons in the Terminal panel.</p>
        {scripts.map((sc, i) => <div key={i} className="flex gap-2">
          <input className={inputCls + ' w-36 font-mono text-[13px]'} placeholder="name" value={sc.name} onChange={e => setScript(i, { name: e.target.value })} />
          <input className={inputCls + ' font-mono text-[13px]'} placeholder="command" value={sc.command} onChange={e => setScript(i, { command: e.target.value })} />
          <IconButton label="Remove script" onClick={() => setScripts(s => s.filter((_, j) => j !== i))}><Trash2 size={13} /></IconButton>
        </div>)}
      </div>
      <div className="flex gap-2 pt-2"><Button tone="danger" onClick={remove}>Remove project</Button><span className="flex-1" /><Button onClick={onClose}>Cancel</Button><Button tone="primary" onClick={save}>Save</Button></div>
    </Modal>
  );
}
