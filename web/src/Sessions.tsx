// Sessions: every conversation on this Mac (or a connected machine), sorted by the tool that ran it: Gibbous itself,
// the agent's CLI and desktop app, Paseo & editors over ACP, messaging apps, the API, and Claude Code / Codex logs.
// Inside a tool, sessions group by project folder. One click opens (or imports) a session; Select imports several.
// Desktop: a tool rail + the tool's list. Phones: #/sessions is the tool list, #/sessions/<tool> the list (like Settings).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Server, Laptop, ListChecks, Download, ChevronRight } from 'lucide-react';
import { api } from './api';
import { rpcFor } from './rpc';
import { useStore, toastError } from './store';
import { useShallow } from 'zustand/react/shallow';
import { Button, IconButton, MoonLoader, PhaseMoon, inputCls, go, sourceLabel } from './ui';
import { PageHeader } from './Inbox';
import { fromHermes, fromForeign, fromThreads, ownSessions, groupCandidates, matches, byTool, withForeignFolders, type Candidate, type SessionDirs, type Origins } from './importSessions';
import { importCandidates, reportImport, useForeign, loadForeign } from './importer';
import { TOOLS, chipsOf, countLabel, type ToolId } from './sessionTools';
import { ToolIcon, ToolIntro, AppChips, GroupBlock, SyncSwitches } from './SessionList';
import type { SessionListRow } from './hermes/contract';
import { thisMachine } from './paths';

const PICKABLE = new Set<ToolId>(['cli', 'desktop', 'acp', 'messaging', 'api', 'other', 'claude', 'codex']);
const SYNCABLE = new Set<ToolId>(['cli', 'desktop', 'acp', 'messaging', 'api', 'other']);
const KEY = 'gibbous.sessionsTool';

export function SessionsView({ tool: routeTool }: { tool?: string }) {
  const { threads, projects, settings, hosts } = useStore(useShallow(s => ({ threads: s.threads, projects: s.projects, settings: s.settings, hosts: s.hosts })));
  const [machine, setMachine] = useState(''); // '' = this Mac, else a host id
  const local = !machine;
  const [rows, setRows] = useState<SessionListRow[]>();
  const [dirs, setDirs] = useState<SessionDirs | null>();
  const [origins, setOrigins] = useState<Origins | null>();
  useEffect(() => { setRows(undefined); rpcFor(machine || undefined).call('session.list', { limit: 5000 }).then(r => setRows(r.sessions)).catch(e => { toastError(e); setRows([]); }); }, [machine]);
  useEffect(() => {
    // Older servers lack these routes: then sessions group by source and Codex/Claude Code rows have no app chips.
    api.get<SessionDirs>('/api/sessions/dirs').then(setDirs, () => setDirs(null));
    api.get<Origins>('/api/sessions/origins').then(setOrigins, () => setOrigins(null));
  }, []);
  const claude = useForeign('claude', local), codex = useForeign('codex', local);

  const own = useMemo(() => ownSessions(threads, machine), [threads, machine]);
  const known = useMemo(() => new Map(threads.filter(t => (t.host ?? '') === machine).map(t => [t.sessionId, t.id])), [threads, machine]);
  const dirsFor = useMemo(() => local ? withForeignFolders(dirs, origins) : undefined, [local, dirs, origins]);
  const native = useMemo(() => rows && (dirs !== undefined || !local) ? fromHermes(rows, dirsFor, own, sourceLabel) : undefined, [rows, dirs, dirsFor, own, local]);
  const gib = useMemo(() => fromThreads(threads, projects, dirsFor, machine), [threads, projects, dirsFor, machine]);
  const foreignAll = useMemo(() => local ? [...fromForeign(claude.rows, origins, dirsFor), ...fromForeign(codex.rows, origins, dirsFor)] : [], [local, claude.rows, codex.rows, origins, dirsFor]);
  const tools = useMemo(() => byTool([...gib, ...(native ?? []), ...foreignAll.filter(c => !c.sub)]), [gib, native, foreignAll]);
  const helpers = useMemo(() => ({ claude: foreignAll.filter(c => c.sub && c.kind === 'claude').length, codex: foreignAll.filter(c => c.sub && c.kind === 'codex').length }), [foreignAll]);
  const more = (id: ToolId) => id === 'claude' ? claude.next != null : id === 'codex' ? codex.next != null : false;

  const list = TOOLS.filter(t => t.id === 'gibbous' || tools.get(t.id)?.length || (local && (t.id === 'claude' || t.id === 'codex')) || (local && t.id === 'opencode' && origins?.opencode));
  const stored = localStorage.getItem(KEY) as ToolId | null;
  const current: ToolId = (list.find(t => t.id === routeTool) ?? list.find(t => t.id === stored) ?? list.find(t => t.id !== 'gibbous' && tools.get(t.id)?.length) ?? list[0]).id;
  useEffect(() => { if (routeTool && list.some(t => t.id === routeTool)) localStorage.setItem(KEY, routeTool); }, [routeTool]); // eslint-disable-line react-hooks/exhaustive-deps
  const listing = !routeTool; // phones: the tool list is its own page

  const [q, setQ] = useState('');
  const [app, setApp] = useState('');
  useEffect(() => { setApp(''); }, [current, machine]);
  const items = tools.get(current) ?? [];
  const chips = useMemo(() => chipsOf(items.filter(c => c.app), c => c.app!), [items]);
  const shown = useMemo(() => items.filter(c => (!app || c.app?.key === app) && matches(c, q)), [items, app, q]);
  const groups = useMemo(() => groupCandidates(shown, { dirs: dirsFor, label: sourceLabel }), [shown, dirsFor]);
  const loading = current === 'claude' ? claude.loading && !claude.rows.length : current === 'codex' ? codex.loading && !codex.rows.length : current !== 'gibbous' && current !== 'opencode' && !native;

  const done = (c: Candidate) => !!c.thread || (c.kind === 'hermes' && known.has(c.id));
  const open = async (c: Candidate) => {
    const t = c.thread ?? (c.kind === 'hermes' ? known.get(c.id) : undefined);
    if (t) return go(`/t/${t}`);
    const res = await importCandidates([c], new Set(), () => {}, machine || undefined);
    if (res.threads[0]) go(`/t/${res.threads[0]}`); else reportImport(res);
  };

  // Select: tick rows across tools, then import them with the shared routine (importer.ts), as the import picker does.
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<[number, number]>();
  const everything = useMemo(() => [...tools.values()].flat(), [tools]);
  const picked = everything.filter(c => sel.has(c.key) && !done(c));
  const stopSelecting = () => { setSelecting(false); setSel(new Set()); };
  const importSelected = async () => {
    if (progress || !picked.length) return;
    setProgress([0, picked.length]);
    const res = await importCandidates(picked, new Set(), (d, t) => setProgress([d, t]), machine || undefined);
    setProgress(undefined); stopSelecting(); reportImport(res);
    if (res.threads.length === 1) go(`/t/${res.threads[0]}`);
  };

  // `/` searches, Esc steps out (search box → list; select mode → off; a tool page on phones → the tool list), h/l switch tool.
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role=dialog], dialog[open], [role=menu]')) return;
      const t = e.target as HTMLElement, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if (e.key === 'Escape') {
        e.preventDefault();
        if (t === search.current) { search.current!.blur(); document.querySelector<HTMLElement>('[data-sessions-list] [data-vim-item]')?.focus(); }
        else if (selecting) stopSelecting();
        else if (routeTool && matchMedia('(max-width: 767px)').matches) go('/sessions');
      } else if (typing) return;
      else if (e.key === '/') { e.preventDefault(); search.current?.focus(); }
      else if (e.key === 'Enter' && selecting && !t.closest('button, a, input, textarea, select, [role=checkbox], [role=switch]')) { e.preventDefault(); importSelected(); }
      else if ((e.key === 'h' || e.key === 'l') && !e.shiftKey) {
        const i = list.findIndex(x => x.id === current), next = list[i + (e.key === 'l' ? 1 : -1)];
        if (next) { e.preventDefault(); (document.activeElement as HTMLElement)?.blur?.(); go(`/sessions/${next.id}`); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const synced = new Set(settings?.syncSources ?? []);
  const toolSources = [...new Set(items.map(c => c.source))];
  const fl = current === 'claude' ? claude : current === 'codex' ? codex : undefined;
  const total = current === 'claude' || current === 'codex' ? origins ? Object.values(origins[current]).filter(o => !o.sub).length : undefined : undefined;

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Sessions" back={listing ? undefined : { href: '#/sessions', label: 'Sessions' }}>
        <span className="ml-auto flex items-center gap-1">
          <a href="#/import" data-tip="Pick sessions to bring in, grouped by tool and project folder" className="press inline-flex items-center gap-1.5 h-8 pointer-coarse:h-10 px-2.5 rounded-lg text-[13px] text-dust hover:text-moon hover:bg-ridge"><Download size={14} /><span className="hidden sm:inline">Import sessions…</span><span className="sm:hidden">Import</span></a>
          {PICKABLE.has(current) && <span className={listing ? 'hidden md:contents' : 'contents'}><IconButton label={selecting ? 'Stop selecting' : 'Select several to import'} aria-pressed={selecting} onClick={() => selecting ? stopSelecting() : setSelecting(true)}><ListChecks size={16} /></IconButton></span>}
        </span>
      </PageHeader>
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <nav aria-label="Session tools" className={`${listing ? 'flex-1 overflow-y-auto' : 'hidden'} md:block md:flex-none md:w-60 md:border-r border-line md:py-3 md:px-2 md:overflow-y-auto`}>
          <div className="p-3 md:p-0 space-y-3 md:space-y-0.5">
            {hosts.length > 0 && <div className="flex flex-wrap gap-1.5 md:px-1 md:pb-3" role="radiogroup" aria-label="Machine">
              {[{ id: '', name: 'This Mac', connected: true }, ...hosts].map(h => (
                <button key={h.id} role="radio" aria-checked={machine === h.id} onClick={() => setMachine(h.id)}
                  className={`press inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-[12.5px] ${machine === h.id ? (h.id ? 'border-tide/50 bg-tide/10 text-tide' : 'border-moon/30 bg-ridge text-moon') : 'border-line text-dust hover:text-moon'}`}>
                  {h.id ? <Server size={13} /> : <Laptop size={13} />}{h.name}
                  {h.id && !h.connected && <span className="size-1.5 rounded-full bg-halo animate-pulse" />}
                </button>
              ))}
            </div>}
            <div className="surface md:[background:none] md:border-0 md:shadow-none rounded-2xl md:rounded-none divide-y divide-line md:divide-y-0 overflow-hidden md:space-y-0.5">
              {list.map(t => {
                const n = t.id === 'opencode' ? origins?.opencode ?? 0 : tools.get(t.id)?.length ?? 0, busy = (t.id === 'claude' ? claude : t.id === 'codex' ? codex : undefined)?.loading;
                return (
                  <a key={t.id} href={`#/sessions/${t.id}`} aria-current={t.id === current ? 'page' : undefined} data-tip={t.tip}
                    className={`press flex items-center gap-3 md:gap-2.5 px-4 md:px-3 py-3 md:py-1.5 md:rounded-lg text-[15px] md:text-[13.5px] active:bg-ridge/55 ${t.id === 'opencode' ? 'text-ash' : 'text-moon'} ${t.id === current ? 'md:bg-ridge md:shadow-[inset_0_1px_0_var(--surface-hi)]' : 'md:text-dust md:hover:text-moon md:hover:bg-ridge/55'}`}>
                    <ToolIcon id={t.id} /><span className="flex-1 min-w-0 truncate">{t.label}</span>
                    {busy && !n ? <MoonLoader size={12} /> : <span className="text-[12px] text-ash tabular-nums">{t.id === 'opencode' ? 'not supported' : countLabel(n, more(t.id))}</span>}
                    <ChevronRight size={15} className="md:hidden text-ash" />
                  </a>
                );
              })}
            </div>
            <p className="md:hidden px-1 text-[12.5px] text-ash">Sessions from each tool on {thisMachine(useStore.getState().service)}. Open one to keep going here.</p>
          </div>
        </nav>
        <div className={`${listing ? 'hidden md:flex' : 'flex'} flex-1 min-h-0 flex-col`}>
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            <div key={`${current}:${machine}`} className="mx-auto max-w-3xl p-4 sm:p-6 space-y-4" data-vim-list data-sessions-list>
              <ToolIntro id={current} n={current === 'opencode' ? origins?.opencode : items.length} more={more(current)}>
                {(current === 'claude' || current === 'codex') && <p className="text-[12px] text-ash">
                  {[total != null && fl && fl.next != null && `Newest ${items.length} of about ${total} loaded`, helpers[current] > 0 && `${helpers[current]} helper runs (subagents, reviewers) left out`].filter(Boolean).join(' · ')}</p>}
              </ToolIntro>
              {current !== 'opencode' && <>
                <AppChips chips={chips} value={app} onChange={setApp} />
                {local && SYNCABLE.has(current) && toolSources.length > 0 && <SyncSwitches tool={current} sources={app ? [app] : toolSources} synced={synced} />}
                {(items.length > 0 || q) && <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" />
                  <input ref={search} className={inputCls + ' pl-9'} placeholder="Search titles, previews and folders" aria-label="Search sessions" value={q} onChange={e => setQ(e.target.value)} /></div>}
                {loading ? <p className="flex items-center gap-2.5 text-sm text-dust"><MoonLoader size={20} />Reading sessions…</p>
                  : !items.length ? <p className="text-sm text-ash">{fl?.error ? `Couldn't read them: ${fl.error}` : current === 'gibbous' ? 'No threads yet.' : 'None found.'}</p>
                  : q && !groups.length ? <p className="text-sm text-ash">No sessions match.</p> : null}
                <div className="space-y-4">
                  {groups.map(g => <GroupBlock key={g.key} g={g} mode={selecting && current !== 'gibbous' ? 'pick' : 'open'} sel={sel} setSel={setSel} done={done} forceOpen={!!q.trim()} enter={importSelected} open={open} page={8} withApp={!app && chips.length > 1} />)}
                </div>
                {fl && fl.next != null && items.length > 0 && <Button onClick={() => loadForeign(current as 'claude' | 'codex')} disabled={fl.loading}>{fl.loading ? <><MoonLoader size={14} />Loading…</> : 'Load older sessions'}</Button>}
              </>}
            </div>
          </div>
          {selecting && <footer className="flex-none border-t border-line bg-basalt/85 backdrop-blur-md"><div className="mx-auto max-w-3xl px-4 py-2.5 flex items-center gap-3">
            {progress ? <span className="flex-1 min-w-0 flex items-center gap-2.5 text-[13px]" role="status"><PhaseMoon fraction={progress[0] / Math.max(1, progress[1])} color="var(--color-tide)" size={18} />Importing {Math.min(progress[0] + 1, progress[1])} of {progress[1]}</span>
              : <span className="flex-1 min-w-0 truncate text-[12.5px] text-dust">{picked.length ? `${picked.length} selected` : 'Tick sessions to import'}</span>}
            <Button onClick={stopSelecting} disabled={!!progress}>Cancel</Button>
            <Button tone="primary" onClick={importSelected} disabled={!picked.length || !!progress} data-kbd="↵">Import selected</Button>
          </div></footer>}
        </div>
      </div>
    </div>
  );
}
