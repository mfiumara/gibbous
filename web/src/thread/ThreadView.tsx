import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FolderGit2, FileCode2, SquareTerminal, Gauge, X, ArrowDown, Globe, Activity, MonitorPlay, ChevronLeft, Paperclip, Clock, Bot } from 'lucide-react';
import { api } from '../api';
import { HumanTaskCard } from '../HumanTask';
import { rpcFor, RpcContext, type HermesEvent } from '../rpc';
import { useStore, toastError } from '../store';
import { Moon, MoonImplode, IconButton, Empty, Skeleton, go, Elapsed, fmtDuration, fmtTokens, fmtUsd } from '../ui';

// Hermes' status lines lead with an emoji (🗜️ Compacting…); the moon icon already says it.
const COMPACTING = /compact|compress/i;
const LEAD_EMOJI = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u;
import { reduce, checkpointFor, endedLabel, withQueuedBubble, type Timeline, type Item } from './timeline';
import { getCached, putCached, onCached, mergeTail, prependOlder, reconcile, revive, type Paging } from './cache';
import { firstPage, resumeWith, olderPages } from './load';
import { AssistantMessage, ToolRow, ReasoningBlock, UserMessage, SideCard } from './Items';
import { useSubagents, SubagentsPanel, SubagentGroup } from './Subagents';
import { isLive, currentBatch, latestDelegatingTurn } from './agents';
import { Composer, type EditTarget } from './Composer';
import { RequestCard } from './RequestCard';
import { ThreadHeader, type PanelDef } from './ThreadHeader';
import { FindBar } from './FindBar';
import { handsFree, speak } from '../voice';
import { toMarkdown, toHtml, download, touch } from './export';
import type { RollbackCheckpoint } from '../hermes/contract';

// Panels load on first open (xterm and friends stay out of the initial bundle).
const ChangesPanel = lazy(() => import('../panels/ChangesPanel').then(m => ({ default: m.ChangesPanel })));
const FilesPanel = lazy(() => import('../panels/FilesPanel').then(m => ({ default: m.FilesPanel })));
const TerminalPanel = lazy(() => import('../panels/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const SessionPanel = lazy(() => import('../panels/SessionPanel').then(m => ({ default: m.SessionPanel })));
const PreviewPanel = lazy(() => import('../panels/PreviewPanel').then(m => ({ default: m.PreviewPanel })));
const ProcessesPanel = lazy(() => import('../panels/ProcessesPanel').then(m => ({ default: m.ProcessesPanel })));
const ScreenPanel = lazy(() => import('../panels/ScreenPanel').then(m => ({ default: m.ScreenPanel })));
import { filesFrom } from '../attachments';
import { findLocalUrls } from '../panels/preview-urls';
import { haptic } from '../iosBridge';
import { thisMachine } from '../paths';

const PANELS: PanelDef[] = [
  { id: 'changes', label: 'Changes', icon: FolderGit2 },
  { id: 'files', label: 'Files', icon: FileCode2 },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'preview', label: 'Preview', icon: Globe },
  { id: 'processes', label: 'Processes', icon: Activity },
  { id: 'screen', label: 'Screen', icon: MonitorPlay },
  { id: 'session', label: 'Session', icon: Gauge },
];
const wide = () => matchMedia('(min-width: 1024px)').matches;
const PAGE = 160;

// Where you were in each thread (px from the bottom), for this app session. Absent = following the bottom.
const SCROLL = new Map<string, number>();

export function ThreadView({ id }: { id: string }) {
  const thread = useStore(s => s.threads.find(t => t.id === id));
  useEffect(() => { useStore.getState().markSeen(id); }, [id, thread?.updatedAt]);
  const rpc = rpcFor(thread?.host);
  const project = useStore(s => s.projects.find(p => p.id === thread?.projectId));
  const allRequests = useStore(s => s.requests);
  const requests = useMemo(() => allRequests.filter(r => r.threadId === id), [allRequests, id]);
  const [sid, setSid] = useState<string>();
  const [tl, setTl] = useState<Timeline>({ items: [], running: false });
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<EditTarget>();
  const [panel, setPanel] = useState<string | null>(() => wide() ? localStorage.getItem('gibbous.panel') || null : null);
  const [agentFocus, setAgentFocus] = useState<string>();
  const [groupOpen, setGroupOpen] = useState(false); // the subagent card's fold, shared wherever it renders
  const agents = useSubagents(id, tl.items, tl.running);
  const { batch, earlier } = useMemo(() => currentBatch(agents, latestDelegatingTurn(tl.items)), [agents, tl.items]);
  const openAgents = (key?: string) => { setAgentFocus(key); setPanel('agents'); };
  const [limit, setLimit] = useState(PAGE);
  const [insert, setInsert] = useState<{ text: string; n: number }>();
  const [finding, setFinding] = useState(false);
  const [checkpoints, setCheckpoints] = useState<{ enabled: boolean; list: RollbackCheckpoint[] }>();
  const [atBottom, setAtBottom] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const gesture = useRef(0); // last user scroll input (wheel, touch, scrollbar drag, keys)
  const markGesture = () => { gesture.current = performance.now(); };
  const lastTop = useRef(0);
  const restore = useRef(false);
  const keepFromBottom = useRef<number | null>(null); // "Show earlier": hold the reading position while rows land above
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [dropped, setDropped] = useState<{ files: File[]; n: number }>();
  const reopen = useRef<() => void>(() => {});
  const initial = useRef(new Set<string>()); // rows present at load don't animate in; new ones do
  const fresh = useRef(false); // this open has Hermes' answer (vs. the cached copy painted on switch)
  const anchor = useRef<{ id: string; y: number } | null>(null); // reading position across the background refresh
  const tlRef = useRef(tl); tlRef.current = tl;
  const [page, setPage] = useState<Paging>(); // older history still on the server ("Show earlier" fetches it)
  const pageRef = useRef(page); pageRef.current = page;
  const older = useRef<Promise<Item[]> | null>(null);
  const limitRef = useRef(limit); limitRef.current = limit;

  // Switching threads resets during render (not in an effect), so the first frame already shows the new thread:
  // its cached timeline if we have one, else skeletons. Hermes' fresh copy replaces it in the background.
  const key = `${id}:${thread?.sessionId}`;
  const [shown, setShown] = useState('');
  const shownRef = useRef(''); shownRef.current = key;
  if (shown !== key) {
    setShown(key);
    const c = thread ? getCached(id) : undefined;
    const hit = c && c.session === thread!.sessionId ? c : undefined;
    setTl(hit ? revive(hit, thread!.status === 'running') : { items: [], running: false });
    setSid(undefined); setLimit(PAGE); setEdit(undefined); setCheckpoints(hit?.checkpoints); setLoading(!hit); setPage(hit?.page);
    pageRef.current = hit?.page; older.current = null;
    initial.current = new Set(hit?.tl.items.map(i => i.id));
    fresh.current = false; anchor.current = null;
    stick.current = !SCROLL.has(id); restore.current = SCROLL.has(id);
  }

  useEffect(() => { if (wide()) localStorage.setItem('gibbous.panel', panel ?? ''); }, [panel]);

  // Attach (Gibbous's server joins first so approvals are always answerable), subscribe, then resume.
  useEffect(() => {
    if (!thread) return;
    let cancelled = false;
    let unsub = () => {};
    let busy = false;
    const open = async () => {
      busy = true;
      try {
        const hist = firstPage(id); // doesn't need the live session: runs alongside the attach
        const { session_id } = await api.post<{ session_id: string }>(`/api/threads/${id}/attach`);
        if (cancelled) return;
        unsub();
        const onEv = (ev: HermesEvent) => {
          // Hands-free: read the finished reply aloud, then listen for the next request.
          if (ev.type === 'message.complete' && handsFree.on && typeof ev.payload?.text === 'string' && ev.payload.text) speak(ev.payload.text, () => dispatchEvent(new CustomEvent('gibbous:listen')));
          // The turn you're watching ended: a soft tick (iPhone app only; not while the app is in the background).
          if (ev.type === 'message.complete' && !document.hidden) haptic('done');
          if (ev.type === 'preview.open' && ev.payload?.url) { setPreviewUrl(ev.payload.url); setPanel('preview'); }
          setTl(t => reduce(t, ev));
          if ((ev.type === 'message.complete' || ev.type === 'message.start') && pendingSent.current.length) flushSent();
        };
        const offs = [rpc.onSession(session_id, onEv)];
        unsub = () => offs.forEach(f => f());
        const { r, tl: next, page: fresh0 } = await resumeWith(rpc, thread, hist);
        if (cancelled) return;
        if (r.session_id !== session_id) offs.push(rpc.onSession(r.session_id, onEv)); // reaped in between
        const prev = tlRef.current.items;
        // Rows already on screen (from the cache) keep their ids and DOM, so the swap is invisible; older rows loaded
        // before (cache, "Show earlier") stay in front of the fresh newest page.
        let { items, kept } = mergeTail(prev, next.items);
        // Older rows without a cursor (a trimmed cache entry) would be fetched again: keep just the fresh page then.
        if (kept && !pageRef.current) { items = reconcile(prev, next.items); kept = false; }
        const pg = kept ? pageRef.current! : fresh0;
        setPage(pg); pageRef.current = pg;
        if (prev.length && !stick.current) {
          // Reading back in the thread: keep the rendered window's first row so nothing above the viewport moves,
          // and remember the first visible row to re-pin it after the commit.
          const top = prev.length > limitRef.current ? prev[prev.length - limitRef.current] : prev[0];
          const at = items.findIndex(i => i.id === top.id);
          if (at >= 0) setLimit(l => Math.max(l, items.length - at));
          const el = scroller.current;
          const row = el && [...el.querySelectorAll<HTMLElement>('[data-k]')].find(n => n.offsetTop + n.offsetHeight > el.offsetTop + el.scrollTop);
          anchor.current = row ? { id: row.dataset.k!, y: row.offsetTop - el!.scrollTop } : null;
        }
        initial.current = new Set(items.map(i => i.id));
        setTl({ ...next, items });
        setSid(r.session_id);
        if (!prev.length) { stick.current = !SCROLL.has(id); restore.current = SCROLL.has(id); }
        fresh.current = true;
      } catch (e) {
        toastError(e);
      } finally {
        busy = false;
        if (!cancelled) setLoading(false);
      }
    };
    reopen.current = open;
    open();
    // A reconnect re-resumes. Not while an open is in flight: on a cold start the socket's first ready lands while
    // the first open waits for it, and a second open doubled every request (two full resumes per page load).
    const offReady = rpc.onReady(() => { if (!busy) open(); });
    return () => { cancelled = true; unsub(); offReady(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, thread?.sessionId]);

  // A queued message the server just handed to Hermes (its turn starts now): show it as sent. The server's event can
  // beat this tab's own message.complete for the turn before; then it waits for that end (or the new start), so the
  // bubble never lands inside the previous reply.
  const pendingSent = useRef<{ id: string; shown: string; at: number }[]>([]);
  const flushSent = () => { const ms = pendingSent.current; pendingSent.current = []; setTimeout(() => setTl(t => ms.reduce((tt, m) => ({ ...tt, items: withQueuedBubble(tt.items, m) }), t))); };
  useEffect(() => {
    pendingSent.current = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const f = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; id: string; shown: string }>).detail;
      if (d?.threadId !== id) return;
      pendingSent.current.push({ id: d.id, shown: d.shown, at: Date.now() });
      if (!tlRef.current.running) flushSent();
      else { clearTimeout(timer); timer = setTimeout(() => { if (pendingSent.current.length) flushSent(); }, 4000); }
    };
    addEventListener('gibbous:queueSent', f);
    return () => { removeEventListener('gibbous:queueSent', f); clearTimeout(timer); };
  }, [id]);

  // A prefetch (sidebar hover/press) that lands while we still show skeletons: paint it now.
  useEffect(() => onCached(k => {
    const c = k === id && !fresh.current && !tlRef.current.items.length ? getCached(id) : undefined;
    if (!c || c.session !== thread?.sessionId) return;
    initial.current = new Set(c.tl.items.map(i => i.id));
    setTl(revive(c, useStore.getState().threads.find(t => t.id === id)?.status === 'running')); setCheckpoints(c.checkpoints); setLoading(false);
    setPage(c.page); pageRef.current = c.page;
  }), [id, thread?.sessionId]);

  // Keep this thread's cache entry current as live events reduce the timeline (only once Hermes answered this open,
  // so a stale copy is never re-stamped as fresh).
  useEffect(() => { if (sid && thread) putCached(id, { tl, session: thread.sessionId, checkpoints, page }); }, [tl, sid, checkpoints, page]);

  // Older history from the server, in front of what's loaded (one page, or everything for an export).
  const loadOlder = (all = false) => {
    const p = pageRef.current;
    if (!p?.more) return Promise.resolve(tlRef.current.items);
    if (older.current) return older.current;
    const k = key;
    const run = olderPages(id, p, all, tlRef.current.items[0]?.kind !== 'user').then(o => {
      const items = prependOlder(tlRef.current.items, o.items);
      if (shownRef.current !== k) return items;
      const el = scroller.current;
      if (el && !stick.current) keepFromBottom.current = el.scrollHeight - el.scrollTop; // hold the reading position
      setTl(t => ({ ...t, items: prependOlder(t.items, o.items) }));
      if (!all) setLimit(l => l + o.items.length); // an export loads everything but renders only what it needs
      setPage(o.page); pageRef.current = o.page;
      return items;
    }, e => { toastError(e); return tlRef.current.items; }).finally(() => { older.current = null; });
    older.current = run;
    return run;
  };

  // File checkpoints (Hermes snapshots before each turn's first edit); refreshed whenever a turn ends.
  const loadCheckpoints = useCallback(() => {
    if (sid) rpc.call('rollback.list', { session_id: sid }).then(r => setCheckpoints({ enabled: r.enabled, list: r.checkpoints ?? [] }), () => setCheckpoints({ enabled: false, list: [] }));
  }, [sid]);
  useEffect(() => { if (!tl.running) loadCheckpoints(); }, [tl.running, loadCheckpoints]);

  // Keep pinned to the bottom while new output streams, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const a = anchor.current; anchor.current = null;
    const row = a && !stick.current ? content.current?.querySelector<HTMLElement>(`[data-k="${CSS.escape(a.id)}"]`) : null;
    if (keepFromBottom.current != null) { el.scrollTop = el.scrollHeight - keepFromBottom.current; keepFromBottom.current = null; }
    else if (row) el.scrollTop = row.offsetTop - a!.y;
    else if (stick.current) el.scrollTop = el.scrollHeight;
    else if (restore.current && !loading) { restore.current = false; el.scrollTop = el.scrollHeight - (SCROLL.get(id) ?? 0); }
  }, [tl.items, requests.length, loading, limit]);

  // Content also grows without new items (markdown/highlighting settling, the status line, a taller composer
  // shrinking the viewport) and the tab may have been hidden: whenever anything resizes, re-pin if following.
  useEffect(() => {
    const el = scroller.current, inner = content.current;
    if (!el || !inner) return;
    const pin = () => { if (stick.current) { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop; } };
    const ro = new ResizeObserver(pin);
    ro.observe(el); ro.observe(inner);
    const onVis = () => { if (document.visibilityState === 'visible') pin(); };
    document.addEventListener('visibilitychange', onVis); addEventListener('focus', pin);
    return () => { ro.disconnect(); document.removeEventListener('visibilitychange', onVis); removeEventListener('focus', pin); };
  }, [loading]);

  // Global shortcuts routed to the open thread.
  useEffect(() => {
    const stop = () => sid && rpc.call('session.interrupt', { session_id: sid }).catch(toastError);
    const approve = () => { const r = requests.find(x => x.method === 'approval'); if (r) api.post(`/api/requests/${encodeURIComponent(r.id)}/answer`, { result: { choice: 'once' } }).catch(toastError); };
    const togglePanel = () => setPanel(p => p ? null : (localStorage.getItem('gibbous.lastPanel') || 'changes'));
    const find = () => setFinding(true);
    addEventListener('gibbous:stop', stop); addEventListener('gibbous:approve', approve); addEventListener('gibbous:panel', togglePanel); addEventListener('gibbous:find', find);
    return () => { removeEventListener('gibbous:stop', stop); removeEventListener('gibbous:approve', approve); removeEventListener('gibbous:panel', togglePanel); removeEventListener('gibbous:find', find); };
  }, [sid, requests]);
  useEffect(() => { if (panel) localStorage.setItem('gibbous.lastPanel', panel); }, [panel]);

  const refreshKey = useMemo(() => tl.items.filter(i => i.kind === 'tool' && i.status !== 'running').length + (tl.running ? 0 : 1e6), [tl]);
  const hasAgents = agents.length > 0 || panel === 'agents';
  const panels = useMemo(() => [
    ...(hasAgents ? [{ id: 'agents', label: 'Subagents', icon: Bot }] : []),
    ...PANELS,
  ], [hasAgents]);
  const users = useMemo(() => tl.items.filter((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user'), [tl.items]);

  if (!thread) return <Empty title="Thread not found">It may have been deleted. <button className="text-tide underline" onClick={() => go('/')}>Start a new thread</button></Empty>;

  const items = tl.items.length > limit ? tl.items.slice(-limit) : tl.items;
  // Live subagents while the turn has moved past the delegation: one card, at the bottom.
  const liveBelow = agents.some(isLive) && items.at(-1)?.kind !== 'subagent';
  // Reloaded history has delegate_task tool rows instead of live subagent rows: retain the same single anchor.
  const groupAt = items.findLastIndex(it => it.kind === 'subagent' || (it.kind === 'tool' && it.name === 'delegate_task'));
  const running = tl.running || thread.status === 'running';
  // The parent blocked on delegate_task does nothing itself: say what it's waiting for.
  const liveAgents = agents.filter(isLive).length;
  const waitingOn = liveAgents ? `Waiting on ${liveAgents} subagent${liveAgents > 1 ? 's' : ''}` : undefined;
  const notice = (text: string) => setTl(t => ({ ...t, items: [...t.items, { kind: 'notice', id: `n${Date.now()}`, text, tone: 'info' }] }));

  const branch = async () => {
    if (!sid) return;
    try {
      const r = await rpc.call('session.branch', { session_id: sid });
      const t = await api.post<{ id: string }>('/api/import', { sessionId: r.stored_session_id, title: `${thread.title} (branch)`, projectId: thread.projectId, readOnly: false });
      go(`/t/${t.id}`);
    } catch (e) { toastError(e); }
  };
  const revert = async (cp: RollbackCheckpoint) => {
    if (!sid || !cp.hash || !confirm('Restore every file this turn changed to how it was before the turn? The conversation is kept.')) return;
    try { await rpc.call('rollback.restore', { session_id: sid, hash: cp.hash }); useStore.getState().toast({ title: 'Files restored to before that turn' }); loadCheckpoints(); }
    catch (e) { toastError(e); }
  };
  const exportThread = async (kind: 'md' | 'html' | 'share') => {
    const name = thread.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'thread';
    const all = await loadOlder(true); // the whole conversation, not just the pages on screen
    if (kind === 'md') return download(`${name}.md`, toMarkdown(thread.title, all), 'text/markdown');
    setLimit(1e9); // render the whole conversation before snapshotting
    await new Promise(r => setTimeout(r, 300));
    const html = await toHtml(thread.title, content.current!);
    if (kind === 'html') return download(`${name}.html`, html, 'text/html');
    try {
      const r = await api.post<{ path: string }>('/api/shares', { html, title: thread.title, threadId: thread.id });
      const base = useStore.getState().tailnetUrl ?? location.origin;
      if (touch() && navigator.share) { await navigator.share({ title: thread.title, url: base + r.path }).catch(() => {}); return; }
      await navigator.clipboard.writeText(base + r.path);
      useStore.getState().toast({ title: 'Share link copied', body: `${base}${r.path} · read-only snapshot; anyone who can reach ${thisMachine(useStore.getState().service)} with the link can open it.` });
    } catch (e) { toastError(e); }
  };
  const mention = (p: string) => { setInsert({ text: `@${p} `, n: Date.now() }); if (!wide()) setPanel(null); };
  const lastUser = users.at(-1);

  const panelBody = panel && (
    panel === 'changes' ? <ChangesPanel thread={thread} refreshKey={refreshKey} /> :
    panel === 'files' ? <FilesPanel thread={thread} onMention={mention} /> :
    panel === 'terminal' ? <TerminalPanel thread={thread} project={project} /> :
    panel === 'preview' ? <PreviewPanel url={previewUrl} setUrl={setPreviewUrl} suggestions={findLocalUrls(tl.items.flatMap(i => i.kind === 'tool' ? [JSON.stringify(i.result ?? '')] : i.kind === 'assistant' ? [i.text] : []))} /> :
    panel === 'processes' ? <ProcessesPanel sid={sid} /> :
    panel === 'screen' ? <ScreenPanel sid={sid} /> :
    panel === 'agents' ? <SubagentsPanel agents={agents} sid={sid} focus={agentFocus} onFocus={setAgentFocus} /> :
    <SessionPanel tl={tl} sid={sid} checkpoints={checkpoints} onRestore={revert} onChanged={loadCheckpoints} />
  );

  return (
    <RpcContext.Provider value={rpc}>
    <div className="flex h-full min-w-0">
      <div data-thread-root className="relative flex flex-col flex-1 min-w-0"
        onDragEnter={e => { if (!thread.readOnly && [...e.dataTransfer.types].includes('Files')) { dragDepth.current++; setDragOver(true); } }}
        onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); } }}
        onDragOver={e => { if (dragOver) e.preventDefault(); }}
        onDrop={e => { if (!dragOver) return; e.preventDefault(); dragDepth.current = 0; setDragOver(false); setDropped({ files: filesFrom(e.dataTransfer), n: Date.now() }); }}>
        {dragOver && <div className="absolute inset-2 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-tide/60 bg-basalt/80 backdrop-blur-sm pointer-events-none animate-fade">
          <p className="flex items-center gap-2 text-[15px] text-moon"><Paperclip size={18} className="text-tide" />Drop to attach</p></div>}
        <ThreadHeader thread={thread} tl={tl} panels={panels} panel={panel} setPanel={setPanel} onBranch={branch} onExport={exportThread} />
        <HumanTaskCard thread={thread} />
        {finding && <FindBar root={content} onClose={() => setFinding(false)} version={tl.items.length} />}

        <div ref={scroller} data-pane="doc" tabIndex={-1} onWheel={markGesture} onTouchMove={markGesture} onPointerDown={markGesture} onKeyDown={markGesture} onScroll={e => {
            // Only scrolling *up* stops following; growth, scroll anchoring and smooth-scrolls down never do.
            const el = e.currentTarget, b = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            // Layout changes (a growing composer, content settling) can move scrollTop too; only a real gesture unfollows.
            if (b) stick.current = true; else if (el.scrollTop < lastTop.current - 2 && performance.now() - gesture.current < 800) stick.current = false;
            lastTop.current = el.scrollTop;
            const shown = b || stick.current; if (shown !== atBottom) setAtBottom(shown);
            if (!loading) { if (stick.current) SCROLL.delete(id); else SCROLL.set(id, el.scrollHeight - el.scrollTop); } }}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden outline-none">
          <div ref={content} className="mx-auto max-w-3xl px-4 py-6 space-y-3">
            {(tl.items.length > limit || page?.more) && <button onClick={() => {
              const el = scroller.current!; stick.current = false;
              // Rendered rows first; past them, the next page from the server.
              if (tl.items.length > limit) { keepFromBottom.current = el.scrollHeight - el.scrollTop; setLimit(l => l + PAGE); }
              else loadOlder();
            }} className="press mx-auto block label hover:text-moon rounded-md px-2 py-1">Show earlier{tl.items.length > limit ? ` (${tl.items.length - limit})` : ''}</button>}
            {loading && !tl.items.length && <div className="space-y-5 pt-2" aria-label="Loading conversation">
              <div className="flex justify-end"><Skeleton className="h-9 w-2/5 rounded-2xl" /></div>
              <div className="space-y-2"><Skeleton className="h-3.5 w-11/12" /><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-3.5 w-2/3" /></div>
              <Skeleton className="h-6 w-1/3" />
            </div>}
            {!loading && !tl.items.length && <div className="pt-10 text-center text-sm text-dust animate-rise">
              <p>{thread.worktree ? <>Working in <span className="font-mono text-moon/80">{thread.worktree.branch}</span>, a fresh worktree off <span className="font-mono">{thread.worktree.base}</span>.</> : <>Working in <span className="font-mono break-all text-moon/80">{thread.cwd}</span>.</>}</p>
              <p className="text-ash mt-1">Start typing below.</p>
            </div>}
            {items.map((it, i) => {
              const anim = initial.current.has(it.id) ? 'tl-row' : 'tl-row animate-rise';
              switch (it.kind) {
                case 'user': {
                  const idx = users.indexOf(it);
                  const cp = checkpointFor(it.at, users[idx + 1]?.at, checkpoints?.list ?? []);
                  return <div key={it.id} className={anim} data-k={it.id}><UserMessage item={it} onEdit={it.rowId != null ? () => setEdit({ rowId: it.rowId, text: it.text }) : undefined} onRevert={cp ? () => revert(cp) : undefined} /></div>;
                }
                case 'assistant': return <div key={it.id} className={anim} data-k={it.id}><AssistantMessage item={it} endOfTurn={items[i + 1]?.kind === 'turn'} tail={running && i === items.length - 1} /></div>;
                case 'reasoning': return <div key={it.id} className={anim} data-k={it.id}><ReasoningBlock item={it} /></div>;
                case 'tool': return <div key={it.id} className={anim} data-k={it.id}><ToolRow item={it} cwd={thread.cwd} />{i === groupAt && !liveBelow && <SubagentGroup agents={batch} earlierCount={earlier.length} onOpen={openAgents} open={groupOpen} setOpen={setGroupOpen} />}</div>;
                case 'subagent': {
                  // One current-batch card at the latest delegation; earlier rows render nothing.
                  // (Matching live rows to stored sessions shrank the card to 1/1 once events arrived.)
                  if (i !== groupAt) return null;
                  // While they work and the turn has moved on, the card follows the work at the bottom instead (never both).
                  if (liveBelow) return null;
                  return <div key={it.id} className={anim} data-k={it.id}><SubagentGroup agents={batch} earlierCount={earlier.length} onOpen={openAgents} open={groupOpen} setOpen={setGroupOpen} /></div>;
                }
                case 'side': return <div key={it.id} className={anim} data-k={it.id}><SideCard item={it} /></div>;
                case 'turn': return <TurnFooter key={it.id} item={it} />;
                case 'notice': return <p key={it.id} className={`${anim} text-[13px] rounded-lg px-3 py-2 border ${it.tone === 'error' ? 'border-oxide/40 text-oxide bg-oxide/5' : 'border-line text-dust'} whitespace-pre-wrap`}>{it.text}</p>;
              }
            })}
            {running && <p className="flex items-center gap-2 text-[13px] text-tide animate-fade">{COMPACTING.test(tl.status ?? '') ? <MoonImplode size={13} /> : <Moon thread="running" size={9} />}<span className="truncate">{(tl.status ?? waitingOn ?? 'Waxing…').replace(LEAD_EMOJI, '')}</span>{tl.turnStartedAt && <Elapsed since={tl.turnStartedAt} className="ml-auto text-[12px] text-ash font-mono" />}</p>}
            {/* Working subagents whose card isn't already right above (stored-only, or the delegation scrolled up). */}
            {liveBelow && <div className="mt-2"><SubagentGroup agents={batch} earlierCount={earlier.length} onOpen={openAgents} open={groupOpen} setOpen={setGroupOpen} /></div>}
            {thread.status === 'error' && !running && thread.error && !tl.items.some(i => i.kind === 'notice') && <p className="text-[13px] text-oxide select-text">{thread.error}</p>}
            {requests.map(r => <div key={r.id} className="animate-rise"><RequestCard r={r} /></div>)}
          </div>
        </div>


        <div className="kb-bar flex-none px-3 pt-1 pb-3 safe-b-bar pointer-coarse:-mb-[env(safe-area-inset-bottom)]">
          <div className="relative mx-auto max-w-3xl">
            {/* Sits on top of the composer, so it never covers what you are typing however tall the box gets. */}
            {!atBottom && <button onClick={() => { const el = scroller.current!; stick.current = true; setAtBottom(true); el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }}
              className="pop press absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12.5px] text-moon [--origin:bottom]">
              <ArrowDown size={13} />{running ? 'Follow output' : 'Latest'}
            </button>}
            <Composer dropped={dropped} draftKey={id} sid={sid} running={running} edit={edit} onCancelEdit={() => setEdit(undefined)} onNotice={notice} insert={insert} onStale={() => reopen.current()}
              onEditLast={lastUser?.rowId != null ? () => setEdit({ rowId: lastUser.rowId, text: lastUser.text }) : undefined} todos={tl.todos} info={tl.info ?? {}} usage={tl.usage} compacting={tl.compacting}
              onSide={(taskId, mode, question) => setTl(t => ({ ...t, items: [...t.items, { kind: 'side', id: `side-${taskId}`, mode, question }] }))}
              onSent={text => setTl(t => ({ ...t, items: [...t.items, { kind: 'user', id: `sent-${Date.now()}`, text, at: Date.now() }] }))} />
          </div>
        </div>
      </div>

      {panel && (
        <aside data-pane="items" className="kb-fixed fixed inset-0 z-40 bg-basalt flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] lg:py-0 lg:static lg:z-auto lg:w-[44%] lg:min-w-[380px] lg:max-w-[760px] lg:border-l lg:border-line animate-fade">
          <div className="flex items-center gap-1 px-2 h-12 border-b border-line flex-none">
            {/* Phones: the panel covers the chat, so "back" is always the first thing. */}
            <button onClick={() => setPanel(null)} aria-label="Back to the conversation" className="lg:hidden press inline-grid place-items-center size-8 flex-none rounded-lg text-tide"><ChevronLeft size={20} /></button>
            <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto [scrollbar-width:none]">
              {panels.map(p => (
                <button key={p.id} onClick={() => setPanel(p.id)} aria-pressed={panel === p.id}
                  className={`press h-8 px-2.5 rounded-lg text-[13px] inline-flex items-center gap-1.5 whitespace-nowrap flex-none ${panel === p.id ? 'bg-ridge text-moon shadow-[inset_0_1px_0_var(--surface-hi)]' : 'text-dust hover:text-moon'}`}>
                  <p.icon size={14} />{p.label}
                </button>
              ))}
            </div>
            <span className="hidden lg:contents"><IconButton label="Close panel" onClick={() => setPanel(null)}><X size={16} /></IconButton></span>
          </div>
          <div className="flex-1 min-h-0"><Suspense fallback={<div className="p-4 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-3/4" /></div>}>{panelBody}</Suspense></div>
        </aside>
      )}
    </div>
    </RpcContext.Provider>
  );
}

// Turn footer: hovering (or tapping, on phones) swaps the time spent for when the turn ended. The resting text sets the
// size; the end time overlays it from the right edge (absolute, so its extra width never pushes the clock away from
// "6s"). Each side carries its own clock. The fade is moonrise/moonset (styles.css .turn-swap).
function TurnFooter({ item }: { item: Extract<Item, { kind: 'turn' }> }) {
  const [shown, setShown] = useState(false);
  const spent = [item.ms != null && fmtDuration(item.ms), item.tokens && `${fmtTokens(item.tokens)} tokens`, item.cost && fmtUsd(item.cost)].filter(Boolean).join(' · ');
  return (
    <p className="flex justify-end -mt-2 select-none">
      <span className={`${item.at ? 'turn-swap' : ''} relative font-mono text-[11.5px] text-dust whitespace-nowrap ${shown ? 'is-on' : ''}`} onClick={() => item.at && setShown(s => !s)}>
        <span className="turn-a inline-flex items-center gap-1.5"><Clock size={11} />{spent}</span>
        {item.at && <span className="turn-b absolute right-0 top-0 inline-flex items-center gap-1.5"><Clock size={11} />{endedLabel(item.at)}</span>}
      </span>
    </p>
  );
}
