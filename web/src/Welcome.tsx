// "Bring your sessions in": the first-run picker (Home on a fresh Gibbous) and #/import. One section per tool that ran
// the sessions (the same taxonomy and pieces as Sessions: sessionTools.ts, SessionList.tsx), grouped by project folder
// inside, plus per-app "keep in sidebar" switches for messaging. Grouping, default ticks and the import loop are pure
// helpers in importSessions.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, Search } from 'lucide-react';
import { api } from './api';
import { rpc } from './rpc';
import { useStore, toastError } from './store';
import { useShallow } from 'zustand/react/shallow';
import { Button, IconButton, Logo, MoonLoader, PhaseMoon, inputCls, go, sourceLabel } from './ui';
import { PageHeader } from './Inbox';
import { fromHermes, fromForeign, ownSessions, withForeignFolders, groupCandidates, defaultSelection, matches, byTool, NOISE_SOURCES, RECENT_DAYS, type Candidate, type SessionDirs, type Origins } from './importSessions';
import { importCandidates, reportImport, useForeign, loadForeign } from './importer';
import { TOOLS, countLabel, type ToolId } from './sessionTools';
import { ToolIcon, ToolIntro, GroupBlock, SyncSwitches } from './SessionList';
import type { SessionListRow } from './hermes/contract';

const PICK_TOOLS: ToolId[] = ['cli', 'desktop', 'acp', 'messaging', 'api', 'other', 'claude', 'codex'];

export function Welcome({ first }: { first?: boolean }) {
  const { threads, projects, settings, setWelcomeDone } = useStore(useShallow(s => ({ threads: s.threads, projects: s.projects, settings: s.settings, setWelcomeDone: s.setWelcomeDone })));
  const [rows, setRows] = useState<SessionListRow[]>();
  const [dirs, setDirs] = useState<SessionDirs | null>();
  const [origins, setOrigins] = useState<Origins | null>();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [proj, setProj] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [progress, setProgress] = useState<[number, number]>();
  const search = useRef<HTMLInputElement>(null);
  const claude = useForeign('claude'), codex = useForeign('codex');

  useEffect(() => {
    rpc.call('session.list', { limit: 5000 }).then(r => setRows(r.sessions), e => { toastError(e); setRows([]); });
    // Older servers have no /api/sessions/dirs or /origins: then sessions group by source, and Codex rows have no app.
    api.get<SessionDirs>('/api/sessions/dirs').then(setDirs, () => setDirs(null));
    api.get<Origins>('/api/sessions/origins').then(setOrigins, () => setOrigins(null));
  }, []);

  const imported = useMemo(() => new Set(threads.filter(t => !t.host).map(t => t.sessionId)), [threads]);
  const own = useMemo(() => ownSessions(threads), [threads]);
  const native = useMemo(() => rows && dirs !== undefined ? fromHermes(rows, dirs ?? undefined, own, sourceLabel) : undefined, [rows, dirs, own]);
  const allDirs = useMemo(() => withForeignFolders(dirs, origins), [dirs, origins]);
  const foreign = useMemo(() => [...fromForeign(claude.rows, origins, allDirs), ...fromForeign(codex.rows, origins, allDirs)].filter(c => !c.sub), [claude.rows, codex.rows, origins, allDirs]);
  const tools = useMemo(() => byTool([...(native ?? []), ...foreign]), [native, foreign]);
  const all = useMemo(() => [...(native ?? []), ...foreign], [native, foreign]);
  const done = (c: Candidate) => c.kind === 'hermes' && imported.has(c.id);
  const groupsOf = (id: ToolId) => groupCandidates((tools.get(id) ?? []).filter(c => matches(c, q)), { dirs: allDirs, label: sourceLabel });

  // Default ticks and project switches, once the list is in.
  const seeded = useRef(false);
  useEffect(() => {
    if (!native || seeded.current) return;
    seeded.current = true;
    setSel(defaultSelection(native, imported));
    setProj(Object.fromEntries(groupCandidates(native, { dirs: dirs ?? undefined, label: sourceLabel }).filter(g => g.canProject).map(g => [g.folder!, g.repo || projects.some(p => p.path === g.folder)])));
  }, [native]); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = all.filter(c => sel.has(c.key) && !done(c));
  const newProjects = new Set(picked.filter(c => c.folder && proj[c.folder] && !projects.some(p => p.path === c.folder)).map(c => c.folder)).size;
  const leftOut = useMemo(() => {
    const noise = (rows ?? []).filter(r => NOISE_SOURCES.has(r.source || '')).length, empty = (rows ?? []).filter(r => !NOISE_SOURCES.has(r.source || '') && !r.message_count).length;
    return [noise && `${noise} scheduled, subagent and kanban runs`, empty && `${empty} empty sessions`].filter(Boolean).join(' and ');
  }, [rows]);
  const synced = new Set(settings?.syncSources ?? []);

  const leave = () => { if (first) setWelcomeDone(); go(first ? '/' : '/sessions'); };
  const start = async () => {
    if (progress || !picked.length) return;
    setProgress([0, picked.length]);
    const res = await importCandidates(picked, new Set(Object.entries(proj).filter(([, v]) => v).map(([k]) => k)), (d, t) => setProgress([d, t]));
    reportImport(res);
    setWelcomeDone();
    go(res.threads.length === 1 ? `/t/${res.threads[0]}` : '/');
  };
  // All = every session of the tools that open in place; Claude Code / Codex copies stay a deliberate pick (their group checkboxes).
  const setAll = (on: boolean) => setSel(s => on ? new Set([...s].filter(k => !k.startsWith('hermes:')).concat((native ?? []).filter(c => !done(c) && matches(c, q)).map(c => c.key))) : new Set());

  // Enter imports, `/` searches, Esc leaves (or steps out of the search box). Rows handle their own Space/Enter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role=dialog], dialog[open]')) return;
      const t = e.target as HTMLElement, inSearch = t === search.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (inSearch) { search.current!.blur(); document.querySelector<HTMLElement>('[data-import-list] [data-vim-item]')?.focus(); } else leave();
      } else if (e.key === 'Enter' && (inSearch || !t.closest('button, a, input, textarea, select, [role=checkbox], [role=switch]'))) { e.preventDefault(); start(); }
      else if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(t.tagName)) { e.preventDefault(); search.current?.focus(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const loading = !native;
  const shownTools = PICK_TOOLS.filter(id => tools.get(id)?.length || id === 'claude' || id === 'codex');
  return (
    <div className="h-full flex flex-col">
      {first
        ? <header data-drag-window className="flex items-center h-12 px-3 lg:hidden flex-none"><IconButton label="Open sidebar" onClick={() => useStore.setState({ sidebar: true })}><Menu size={17} /></IconButton></header>
        : <PageHeader title="Import sessions" back={{ href: '#/sessions', label: 'Sessions' }} />}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-3xl px-4 pt-4 sm:pt-10 pb-8 space-y-8 animate-rise" data-vim-list data-import-list>
          <div className="space-y-2">
            {first && <div className="flex items-center gap-2.5 pb-2"><Logo size={20} /><span className="font-label tracking-[0.2em] text-[13px]">gibbous</span></div>}
            <h1 className="text-[28px] sm:text-[34px] leading-[1.1] font-bold tracking-[-.02em]">Bring your sessions in</h1>
            <p className="text-[14.5px] text-dust max-w-xl">Pick the conversations you want as threads. Everything else stays under Sessions, where you can open it any time.</p>
            {loading ? <p className="flex items-center gap-2.5 text-sm text-dust"><MoonLoader size={20} />Reading your sessions…</p>
              : <p className="text-[12.5px] text-ash">{native!.length ? `Sessions from the last ${RECENT_DAYS} days are ticked. Folders that are git repositories become projects.` : 'No conversations yet.'}{leftOut && <span className="block">Left out: {leftOut}.</span>}</p>}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" />
              <input ref={search} className={inputCls + ' pl-9'} placeholder="Filter by title, folder or source" aria-label="Filter sessions" value={q} onChange={e => setQ(e.target.value)} /></div>
            <Button size="sm" onClick={() => setAll(true)} data-tip="Tick every session shown, except Claude Code and Codex copies">All</Button>
            <Button size="sm" onClick={() => setAll(false)} data-tip="Untick everything">None</Button>
          </div>

          {!loading && <nav aria-label="Jump to a tool" className="flex flex-wrap gap-1.5 -mt-3">
            {shownTools.map(id => <button key={id} onClick={() => document.getElementById(`import-${id}`)?.scrollIntoView({ block: 'start' })}
              className="press inline-flex items-center gap-1.5 h-7 pointer-coarse:h-9 px-2.5 rounded-md border border-line text-[12.5px] text-dust hover:text-moon">
              <ToolIcon id={id} size={13} />{TOOLS.find(t => t.id === id)!.label}<span className="text-ash tabular-nums">{countLabel(tools.get(id)?.length ?? 0, id === 'claude' ? claude.next != null : id === 'codex' ? codex.next != null : false)}</span></button>)}
          </nav>}
          {!loading && shownTools.map(id => {
            const groups = groupsOf(id), n = tools.get(id)?.length ?? 0, fl = id === 'claude' ? claude : id === 'codex' ? codex : undefined;
            const sources = [...new Set((tools.get(id) ?? []).map(c => c.source))];
            return (
              <section key={id} id={`import-${id}`} className="space-y-3 scroll-mt-4" aria-label={TOOLS.find(t => t.id === id)!.label}>
                <ToolIntro id={id} n={n} more={fl ? fl.next != null : false}>
                  {fl && fl.loading && !n && <p className="flex items-center gap-2.5 text-sm text-dust"><MoonLoader size={18} />Looking for sessions…</p>}
                  {fl && !fl.loading && !n && <p className="text-[12.5px] text-ash">None found.</p>}
                  {fl && n > 0 && <p className="text-[12px] text-ash">None are ticked: pick the ones you want.</p>}
                </ToolIntro>
                {id === 'messaging' && sources.length > 0 && <SyncSwitches tool="messaging" sources={sources} synced={synced} />}
                {groups.map(g => <GroupBlock key={g.key} g={g} mode="pick" sel={sel} setSel={setSel} done={done} forceOpen={!!q.trim()} enter={start} withApp={id === 'codex' || id === 'claude' || id === 'messaging'}
                  project={g.folder ? proj[g.folder] : undefined} setProject={g.folder ? v => setProj(p => ({ ...p, [g.folder!]: v })) : undefined} existing={projects.find(p => p.path === g.folder)?.name} />)}
                {fl && fl.next != null && n > 0 && <Button size="sm" onClick={() => loadForeign(id as 'claude' | 'codex')} disabled={fl.loading}>{fl.loading ? <><MoonLoader size={14} />Loading…</> : 'Load older sessions'}</Button>}
              </section>
            );
          })}
          {!loading && q && shownTools.every(id => !groupsOf(id).length) && <p className="text-sm text-ash">No sessions match.</p>}
          {!loading && !!origins?.opencode && <section className="space-y-1"><ToolIntro id="opencode" n={origins.opencode} /></section>}
        </div>
      </div>

      <footer className="flex-none border-t border-line bg-basalt/85 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 py-2.5 flex items-center gap-3">
          {progress
            ? <span className="flex-1 min-w-0 flex items-center gap-2.5 text-[13px]" role="status"><PhaseMoon fraction={progress[0] / Math.max(1, progress[1])} color="var(--color-tide)" size={18} />Importing {Math.min(progress[0] + 1, progress[1])} of {progress[1]}</span>
            : <span className="flex-1 min-w-0 truncate text-[12.5px] text-dust">{picked.length ? `${picked.length} selected${newProjects ? ` · ${newProjects} new project${newProjects === 1 ? '' : 's'}` : ''}` : 'Nothing selected'}</span>}
          <Button onClick={leave} disabled={!!progress} data-tip={first ? 'Start with an empty sidebar; import later from Sessions' : 'Back to Sessions'}>{first ? 'Skip' : 'Cancel'}</Button>
          <Button tone="primary" onClick={start} disabled={!picked.length || !!progress} data-kbd="↵">Import {picked.length || ''} session{picked.length === 1 ? '' : 's'}</Button>
        </div>
      </footer>
    </div>
  );
}
