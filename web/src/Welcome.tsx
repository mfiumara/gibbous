// "Bring your sessions in": the first-run picker (Home on a fresh Gibbous) and #/import. Hermes sessions grouped by the
// project folder they ran in, Claude Code / Codex sessions on this Mac, and per-platform "keep in sidebar" switches.
// Grouping, default ticks and the import loop are pure helpers in importSessions.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, Search, Folder, MessageCircle, ChevronDown } from 'lucide-react';
import { api } from './api';
import { rpc } from './rpc';
import { useStore, toastError } from './store';
import { useShallow } from 'zustand/react/shallow';
import { Button, IconButton, Logo, MoonLoader, PhaseMoon, Switch, Check, CheckRow, inputCls, go, ago, sourceLabel } from './ui';
import { PageHeader } from './Inbox';
import { fromHermes, fromForeign, groupCandidates, defaultSelection, matches, triState, toggleAll, countBy, whenLabel, NOISE_SOURCES, MESSAGING_SOURCES, type Candidate, type Group, type SessionDirs } from './importSessions';
import { importCandidates, reportImport, toggleSync, listForeign } from './importer';
import type { SessionListRow } from './hermes/contract';

function SessionRow({ c, on, done, toggle, enter }: { c: Candidate; on: boolean; done: boolean; toggle(): void; enter(): void }) {
  return (
    <CheckRow checked={on || done} disabled={done} onToggle={toggle} onEnter={enter} label={c.title}>
      <Check state={on || done} />
      <span className="flex-1 min-w-0 py-1.5">
        <span className="block truncate text-[13.5px]">{c.title}{done && <span className="label ml-2 text-tide">in gibbous</span>}</span>
        <span className="block truncate text-[11.5px] text-ash">{[sourceLabel(c.source), c.kind !== 'hermes' && c.cwd?.replace(/^\/Users\/[^/]+/, '~'), c.preview.replace(/\s+/g, ' ').slice(0, 140)].filter(Boolean).join(' · ')}</span>
      </span>
      {c.at > 0 && <span className="text-[11.5px] text-ash tabular-nums flex-none" data-tip={whenLabel(c.at)}>{ago(c.at)}</span>}
    </CheckRow>
  );
}

const PAGE = 6; // rows per group until "Show all"

function GroupBlock({ g, sel, setSel, done, project, setProject, existing, forceOpen, enter }: {
  g: Group; sel: Set<string>; setSel: React.Dispatch<React.SetStateAction<Set<string>>>; done(c: Candidate): boolean; project?: boolean; setProject?(v: boolean): void; existing?: string; forceOpen: boolean; enter(): void;
}) {
  const [open, setOpen] = useState(false);
  const pickable = g.items.filter(c => !done(c));
  const state = pickable.length ? triState(pickable, sel) : 'all';
  const shown = open || forceOpen ? g.items : g.items.slice(0, PAGE);
  return (
    <section className="space-y-0.5">
      <div className="flex items-center gap-2 pr-1">
        <CheckRow checked={state} disabled={!pickable.length} onToggle={() => setSel(s => toggleAll(s, pickable))} onEnter={enter} label={`${g.label}: all ${g.items.length}`} className="flex-1 min-w-0">
          <Check state={state} />
          {g.folder ? <Folder size={14} className="text-dust flex-none" /> : <MessageCircle size={14} className="text-dust flex-none" />}
          <span className="min-w-0 flex items-baseline gap-2"><span className="font-bold text-[13.5px] truncate">{g.label}</span>{g.detail && g.detail !== g.label && <span className="hidden sm:block font-mono text-[11px] text-ash truncate">{g.detail}</span>}</span>
          <span className="text-[12px] text-ash tabular-nums flex-none">{g.items.length}</span>
        </CheckRow>
        {g.canProject && setProject && <label className="flex items-center gap-2 text-[12.5px] text-dust flex-none select-none" data-tip={existing ? `Imported threads go into your ${existing} project` : project ? `Creates a project for ${g.detail} and files these threads under it` : 'Imported threads stay unfiled'}>
          <span className="hidden sm:inline">{existing ? 'In project' : 'Add as project'}</span><span className="sm:hidden">Project</span><Switch label={`Add ${g.label} as a project`} checked={!!project} onChange={setProject} />
        </label>}
      </div>
      <div className="pl-5 sm:pl-6">
        {shown.map(c => <SessionRow key={c.key} c={c} on={sel.has(c.key)} done={done(c)} enter={enter} toggle={() => setSel(s => { const n = new Set(s); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n; })} />)}
        {!forceOpen && g.items.length > PAGE && <button onClick={() => setOpen(!open)} className="press flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-2 text-[12.5px] text-dust hover:text-moon rounded-lg">
          <ChevronDown size={13} className={open ? 'rotate-180' : ''} />{open ? 'Show fewer' : `Show all ${g.items.length}`}</button>}
      </div>
    </section>
  );
}

export function Welcome({ first }: { first?: boolean }) {
  const { threads, projects, settings, setWelcomeDone } = useStore(useShallow(s => ({ threads: s.threads, projects: s.projects, settings: s.settings, setWelcomeDone: s.setWelcomeDone })));
  const [rows, setRows] = useState<SessionListRow[]>();
  const [dirs, setDirs] = useState<SessionDirs | null>();
  const [foreign, setForeign] = useState<Candidate[]>();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [proj, setProj] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [progress, setProgress] = useState<[number, number]>();
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    rpc.call('session.list', { limit: 5000 }).then(r => setRows(r.sessions), e => { toastError(e); setRows([]); });
    // Older servers have no /api/sessions/dirs: then sessions group by source.
    api.get<SessionDirs>('/api/sessions/dirs').then(setDirs, () => setDirs(null));
    Promise.all((['claude', 'codex'] as const).map(source => listForeign(source).catch(() => [])))
      .then(([a, b]) => setForeign(fromForeign([...a, ...b])));
  }, []);

  const imported = useMemo(() => new Set(threads.filter(t => !t.host).map(t => t.sessionId)), [threads]);
  const hermes = useMemo(() => rows && dirs !== undefined ? fromHermes(rows, dirs ?? undefined) : undefined, [rows, dirs]);
  const groups = useMemo(() => hermes ? groupCandidates(hermes.filter(c => matches(c, q)), { dirs: dirs ?? undefined, label: sourceLabel }) : [], [hermes, dirs, q]);
  const fGroups = useMemo(() => foreign ? groupCandidates(foreign.filter(c => matches(c, q)), { label: sourceLabel }) : [], [foreign, q]);
  const all = useMemo(() => [...(hermes ?? []), ...(foreign ?? [])], [hermes, foreign]);
  const done = (c: Candidate) => c.kind === 'hermes' && imported.has(c.id);

  // Default ticks and project switches, once the Hermes list is in.
  const seeded = useRef(false);
  useEffect(() => {
    if (!hermes || seeded.current) return;
    seeded.current = true;
    setSel(defaultSelection(hermes, imported));
    setProj(Object.fromEntries(groupCandidates(hermes, { dirs: dirs ?? undefined, label: sourceLabel }).filter(g => g.canProject).map(g => [g.folder!, g.repo || projects.some(p => p.path === g.folder)])));
  }, [hermes]); // eslint-disable-line react-hooks/exhaustive-deps

  const picked = all.filter(c => sel.has(c.key) && !done(c));
  const newProjects = new Set(picked.filter(c => c.folder && proj[c.folder] && !projects.some(p => p.path === c.folder)).map(c => c.folder)).size;
  const sources = useMemo(() => countBy(hermes ?? [], c => c.source), [hermes]);
  const leftOut = useMemo(() => {
    const noise = (rows ?? []).filter(r => NOISE_SOURCES.has(r.source || '')).length, empty = (rows ?? []).filter(r => !NOISE_SOURCES.has(r.source || '') && !r.message_count).length;
    return [noise && `${noise} scheduled, subagent and kanban runs`, empty && `${empty} empty sessions`].filter(Boolean).join(' and ');
  }, [rows]);
  const messaging = sources.filter(([s]) => MESSAGING_SOURCES.has(s));
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
  // All = every Hermes session shown; Claude Code / Codex copies stay a deliberate pick (their group checkboxes).
  const setAll = (on: boolean) => setSel(s => on ? new Set([...s].filter(k => !k.startsWith('hermes:')).concat((hermes ?? []).filter(c => !done(c) && matches(c, q)).map(c => c.key))) : new Set());

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

  const loading = !hermes;
  return (
    <div className="h-full flex flex-col">
      {first
        ? <header data-drag-window className="flex items-center h-12 px-3 lg:hidden flex-none"><IconButton label="Open sidebar" onClick={() => useStore.setState({ sidebar: true })}><Menu size={17} /></IconButton></header>
        : <PageHeader title="Import sessions" back={{ href: '#/sessions', label: 'Hermes history' }} />}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-3xl px-4 pt-4 sm:pt-10 pb-8 space-y-7 animate-rise" data-vim-list data-import-list>
          <div className="space-y-2">
            {first && <div className="flex items-center gap-2.5 pb-2"><Logo size={20} /><span className="font-label tracking-[0.2em] text-[13px]">gibbous</span></div>}
            <h1 className="text-[28px] sm:text-[34px] leading-[1.1] font-bold tracking-[-.02em]">Bring your sessions in</h1>
            <p className="text-[14.5px] text-dust max-w-xl">Pick the conversations you want as threads. Everything else stays in Hermes history, where you can open it any time.</p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" />
              <input ref={search} className={inputCls + ' pl-9'} placeholder="Filter by title, folder or source" aria-label="Filter sessions" value={q} onChange={e => setQ(e.target.value)} /></div>
            <Button size="sm" onClick={() => setAll(true)} data-tip="Tick every Hermes session shown">All</Button>
            <Button size="sm" onClick={() => setAll(false)} data-tip="Untick everything">None</Button>
          </div>

          <section className="space-y-3">
            <div className="space-y-1">
              <h2 className="label">Hermes</h2>
              {loading ? <p className="flex items-center gap-2.5 text-sm text-dust"><MoonLoader size={20} />Reading your sessions…</p>
                : <p className="text-[12.5px] text-ash">{sources.map(([s, n]) => `${sourceLabel(s)} ${n}`).join(' · ') || 'No conversations yet.'}{leftOut && <span className="block">Left out: {leftOut}.</span>}</p>}
            </div>
            {!loading && hermes!.length > 0 && <p className="text-[12.5px] text-dust">Sessions from the last {14} days are ticked. Folders that are git repositories become projects.</p>}
            {groups.map(g => <GroupBlock key={g.key} g={g} sel={sel} setSel={setSel} done={done} forceOpen={!!q.trim()} enter={start}
              project={g.folder ? proj[g.folder] : undefined} setProject={g.folder ? v => setProj(p => ({ ...p, [g.folder!]: v })) : undefined} existing={projects.find(p => p.path === g.folder)?.name} />)}
            {!loading && q && !groups.length && <p className="text-sm text-ash">No Hermes sessions match.</p>}
          </section>

          <section className="space-y-3">
            <div className="space-y-1">
              <h2 className="label">Claude Code and Codex on this Mac</h2>
              {!foreign ? <p className="flex items-center gap-2.5 text-sm text-dust"><MoonLoader size={20} />Looking for sessions…</p>
                : <p className="text-[12.5px] text-dust">{foreign.length ? `Importing copies a session into Hermes so you can continue it here. None are ticked: pick the ones you want.` : 'None found.'}</p>}
            </div>
            {fGroups.map(g => <GroupBlock key={g.key} g={g} sel={sel} setSel={setSel} done={done} forceOpen={!!q.trim()} enter={start} />)}
          </section>

          {messaging.length > 0 && <section className="space-y-2">
            <div className="space-y-1"><h2 className="label">Keep in sidebar automatically</h2><p className="text-[12.5px] text-dust">Every chat from these platforms appears as a thread, new ones too.</p></div>
            {messaging.map(([s, n]) => (
              <label key={s} className="flex items-center gap-3 px-2 min-h-10 pointer-coarse:min-h-11 rounded-lg hover:bg-ridge/50 select-none">
                <span className="flex-1 text-[13.5px]">{sourceLabel(s)} <span className="text-ash text-[12px]">{n} chat{n === 1 ? '' : 's'}</span></span>
                <Switch label={`Keep ${sourceLabel(s)} chats in the sidebar`} checked={synced.has(s)} onChange={() => toggleSync(s)} />
              </label>
            ))}
          </section>}
        </div>
      </div>

      <footer className="flex-none border-t border-line bg-basalt/85 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 py-2.5 flex items-center gap-3">
          {progress
            ? <span className="flex-1 min-w-0 flex items-center gap-2.5 text-[13px]" role="status"><PhaseMoon fraction={progress[0] / Math.max(1, progress[1])} color="var(--color-tide)" size={18} />Importing {Math.min(progress[0] + 1, progress[1])} of {progress[1]}</span>
            : <span className="flex-1 min-w-0 truncate text-[12.5px] text-dust">{picked.length ? `${picked.length} selected${newProjects ? ` · ${newProjects} new project${newProjects === 1 ? '' : 's'}` : ''}` : 'Nothing selected'}</span>}
          <Button onClick={leave} disabled={!!progress} data-tip={first ? 'Start with an empty sidebar; import later from Hermes history' : 'Back to Hermes history'}>{first ? 'Skip' : 'Cancel'}</Button>
          <Button tone="primary" onClick={start} disabled={!picked.length || !!progress} data-kbd="↵">Import {picked.length || ''} session{picked.length === 1 ? '' : 's'}</Button>
        </div>
      </footer>
    </div>
  );
}
