import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X, Search, CornerDownLeft, Copy } from 'lucide-react';
import { useStore, toastError, archiveWithUndo } from './store';
import { useShallow } from 'zustand/react/shallow';
import { api, type ThreadStatus } from './api';
import { useRoute, Moon, Kbd, Modal, TooltipHost, MediaViewer, MoonLoader, go, parse, sourceLabel, applyPrefs, type Route } from './ui';
import { BackSwipe } from './BackSwipe';
import { Sidebar } from './Sidebar';
import { ProjectFilter } from './ProjectFilter';
import { Home, AddProjectDialog } from './Home';
import { ThreadView } from './thread/ThreadView';
import { ExternalThread } from './thread/ExternalThread';
import { lazy, Suspense } from 'react';
const Board = lazy(() => import('./board/Board').then(m => ({ default: m.Board })));
import { InboxView, SessionsView, Login } from './Inbox';
const SearchView = lazy(() => import('./Search').then(m => ({ default: m.SearchView })));
const RoomsView = lazy(() => import('./Rooms').then(m => ({ default: m.RoomsView })));
const AutomationsView = lazy(() => import('./Automations').then(m => ({ default: m.AutomationsView })));
const SettingsView = lazy(() => import('./Settings').then(m => ({ default: m.SettingsView })));
import { SkyMoon } from './SkyMoon';
import { HealthBanner } from './HealthBanner';

// Thread-scoped shortcuts are broadcast; the open ThreadView acts on them.
const shortcut = (name: 'stop' | 'approve' | 'panel' | 'find') => dispatchEvent(new CustomEvent(`gibbous:${name}`));
const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement; return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName); };

const SHORTCUTS: [string, string][] = [
  ['⌘K', 'Search or jump anywhere'], ['⌘N', 'New thread'], ['⌘1–9', 'Open recent thread'], ['⌘F', 'Find in thread'],
  ['⌘.', 'Stop the running turn'], ['⌘⇧A', 'Allow the pending approval once'], ['⌘\\', 'Toggle side panel'],
  ['Esc', 'Close / cancel edit / leave the message box'], ['Enter', 'Jump into the message box'], ['j / k', 'Next / previous thread in the sidebar (k past the top goes home)'],
  ['↑ in empty composer', 'Edit your last message'], ['?', 'Show shortcuts'],
];

export function App() {
  const { loaded, authed, palette } = useStore(useShallow(s => ({ loaded: s.loaded, authed: s.authed, palette: s.palette })));
  const route = useRoute();
  const [adding, setAdding] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'k') { e.preventDefault(); useStore.setState({ palette: !useStore.getState().palette }); return; }
      if (mod && k === 'n' && !e.shiftKey) { e.preventDefault(); go('/new'); return; }
      if (mod && /^[1-9]$/.test(e.key)) {
        const recent = [...useStore.getState().threads].filter(t => t.status !== 'archived').sort((a, b) => b.updatedAt - a.updatedAt);
        const t = recent[Number(e.key) - 1];
        if (t) { e.preventDefault(); go(`/t/${t.id}`); }
        return;
      }
      if (mod && e.key === '.') { e.preventDefault(); shortcut('stop'); return; }
      if (mod && e.shiftKey && k === 'a') { e.preventDefault(); shortcut('approve'); return; }
      if (mod && e.key === '\\') { e.preventDefault(); shortcut('panel'); return; }
      if (mod && k === 'f' && location.hash.startsWith('#/t/')) { e.preventDefault(); shortcut('find'); return; }
      if (e.key === '?' && !typing(e) && !mod) { e.preventDefault(); setHelp(true); return; }
      // Esc is always ours: unhandled, the Mac app's window takes it as "leave full screen". Native <dialog>s close themselves.
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.preventDefault(); return; }
      if (mod || e.altKey || e.isComposing || typing(e)) return;
      // Outside any text field: Enter jumps into the message box, j/k walk the sidebar's threads (vim-style).
      if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button, [role=menuitem], [role=option], summary')) {
        const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label=Message], textarea[aria-label="First message"]');
        if (box) { e.preventDefault(); box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
        return;
      }
      if ((k === 'j' || k === 'k') && !e.shiftKey && !document.querySelector('[role=dialog], [role=menu], dialog[open]')) {
        e.preventDefault();
        // Walk the sidebar in DOM order, skipping rows inside collapsed sections ([inert]). If the open thread is itself
        // in a collapsed section, step from its position to the nearest visible row. Home sits above the first thread:
        // j from Home opens the first thread, k past the first thread comes back Home.
        const all = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label=Threads] a[href^="#/t/"]')];
        const open = (a: HTMLAnchorElement) => !a.closest('[inert]');
        const here = all.findIndex(a => a.getAttribute('href') === location.hash);
        const d = k === 'j' ? 1 : -1;
        const home = parse(location.hash).name === 'home';
        let next: HTMLAnchorElement | undefined;
        if (here < 0) next = home && d < 0 ? undefined : (d > 0 ? all : [...all].reverse()).find(open);
        else for (let i = here + d; i >= 0 && i < all.length && !next; i += d) if (open(all[i])) next = all[i];
        if (!next && here >= 0 && d < 0) { go('/'); document.querySelector('nav[aria-label=Threads]')?.closest('.overflow-y-auto')?.scrollTo({ top: 0 }); return; }
        if (next && next.getAttribute('href') !== location.hash) { location.hash = next.getAttribute('href')!; next.scrollIntoView({ block: 'nearest' }); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // Optional chime when an agent starts waiting on you (Settings → Appearance).
  const requestIds = useStore(s => s.requests.map(r => r.id).join(','));
  const heard = useRef<Set<string> | null>(null);   // null until the first load: requests already open don't chime
  useEffect(() => {
    const ids = requestIds ? requestIds.split(',') : [];
    if (heard.current && ids.some(id => !heard.current!.has(id)) && localStorage.getItem('gibbous.chime') === 'on') chime();
    heard.current = new Set(ids);
  }, [requestIds]);

  // Favicon: the moon, plus a dot while agents work (tide) or wait on you (halo).
  const working = useStore(s => s.threads.some(t => t.status === 'running'));
  const needs = useStore(s => s.requests.length > 0);
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel=icon][sizes="32x32"]');
    if (!link) return;
    if (!working && !needs) { link.href = '/favicon-32.png'; return; }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d')!; g.drawImage(img, 0, 0, 64, 64);
      g.beginPath(); g.arc(50, 50, 13, 0, 2 * Math.PI); g.fillStyle = '#15171c'; g.fill();
      g.beginPath(); g.arc(50, 50, 9, 0, 2 * Math.PI); g.fillStyle = needs ? '#f2c46d' : '#9db4d8'; g.fill();
      link.href = c.toDataURL();
    };
    img.src = '/favicon-64.png';
  }, [working, needs]);

  // Tab title shows how many agents wait on you.
  const waiting = useStore(s => s.requests.length);
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Gibbous` : 'Gibbous';
    (window as any).webkit?.messageHandlers?.gibbousBadge?.postMessage(waiting); // macOS app: Dock + menu-bar count
  }, [waiting]);

  const screenRef = useRef<HTMLDivElement>(null);
  const screen = (r: Route) =>
    r.name === 'thread' ? <ThreadRoute key={r.id} id={r.id} /> :
    r.name === 'board' ? <Board projectId={r.projectId} /> :
    r.name === 'inbox' ? <InboxView /> :
    r.name === 'sessions' ? <SessionsView /> :
    r.name === 'search' ? <SearchView q={r.q} /> :
    r.name === 'settings' ? <SettingsView tab={r.tab} /> :
    r.name === 'rooms' ? <RoomsView id={r.id} /> :
    r.name === 'automations' ? <AutomationsView /> :
    <Home projectId={r.projectId} host={r.host} onAddProject={() => setAdding(true)} />;

  if (!loaded) return <div className="h-full grid place-items-center"><MoonLoader size={56} label="Starting Gibbous" /></div>;
  if (!authed) return <Login />;

  return (
    <div className="h-full flex overflow-hidden">
      <SkyMoon />
      <Sidebar route={route} onAddProject={() => setAdding(true)} />
      <main className="flex-1 min-w-0 h-full flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <HealthBanner />
        {/* .vt-screen is the only part that moves on navigation (screenTransition.ts); BackSwipe draws the screen
            a back gesture returns to underneath it. */}
        <div className="flex-1 min-h-0 relative">
          <BackSwipe screen={screenRef} render={screen} />
          <div ref={screenRef} className="vt-screen relative h-full"><Boundary key={location.hash}><Suspense fallback={<div className="h-full grid place-items-center"><MoonLoader size={40} /></div>}>
            {screen(route)}
          </Suspense></Boundary></div>
        </div>
      </main>
      <AddProjectDialog open={adding} onClose={() => setAdding(false)} />
      {palette && <Palette start={palette === 'projects' ? 'projects' : undefined} onClose={() => useStore.setState({ palette: false })} />}
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <ul className="divide-y divide-line">{SHORTCUTS.map(([k, d]) => <li key={k} className="flex items-center py-2 text-sm"><span className="flex-1 text-dust">{d}</span><Kbd>{k}</Kbd></li>)}</ul>
      </Modal>
      <Toasts />
      <TooltipHost />
      <MediaViewer />
    </div>
  );
}

// A screen that throws shows its error in place; the sidebar and every other screen keep working.
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    console.error('[gibbous] screen crashed', error);
    // A lazy screen from an older build failed to load: that's a deploy, not a bug.
    if (/dynamically imported module|Importing a module script failed|MIME type|Failed to fetch/i.test(error.message)) (window as any).gibbousReloadOnce?.();
  }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="h-full grid place-items-center p-6"><div className="max-w-lg w-full space-y-3 text-center">
        <p className="font-bold">This screen hit an error</p>
        <pre className="text-left max-h-48 overflow-auto rounded-xl bg-well border border-line p-3 font-mono text-[11.5px] text-dust whitespace-pre-wrap">{`${e.message}\n${e.stack?.split('\n').slice(1, 6).join('\n') ?? ''}`}</pre>
        <div className="flex justify-center gap-2"><button className="press h-8 px-3 rounded-lg border border-line text-[13px] hover:bg-ridge" onClick={() => this.setState({ error: undefined })}>Try again</button>
          <button className="press h-8 px-3 rounded-lg border border-line text-[13px] hover:bg-ridge" onClick={() => go('/')}>Go home</button></div>
      </div></div>
    );
  }
}

// Conversations owned by another surface (Discord…) render read-only; everything else is a live thread.
function ThreadRoute({ id }: { id: string }) {
  const t = useStore(s => s.threads.find(x => x.id === id));
  return t?.readOnly ? <ExternalThread thread={t} /> : <ThreadView id={id} />;
}

type Opt = { label: string; hint: string; href?: string; run?: () => void; status?: ThreadStatus; keywords?: string; stay?: boolean };

// Every settings section, findable by what's inside it ("theme", "password", "budget"…).
const SETTINGS: [string, string, string][] = [
  ['general', 'General', 'model default parallel tasks review rounds approvals yolo smart'],
  ['appearance', 'Appearance', 'theme night daylight dark light density compact roomy moon animations editor vs code'],
  ['notifications', 'Notifications', 'push alerts needs you finished failures test'],
  ['phone', 'Phone', 'qr sign in link iphone tailnet tailscale install home screen'],
  ['coordinator', 'Coordinator', 'mcp tools lead team spawn register'],
  ['playbooks', 'Playbooks', 'plan review tests budget auto merge pr'],
  ['maintenance', 'Maintenance', 'stuck orphaned worktrees backup restore diagnostics debug bundle'],
  ['usage', 'Usage', 'spend cost tokens insights chart'],
  ['profiles', 'Profiles', 'persona profile default'],
  ['skills', 'Skills', 'skill hub install reload'],
  ['mcp', 'MCP servers', 'mcp server tools oauth'],
  ['jobs', 'Scheduled jobs', 'cron schedule jobs'],
  ['platforms', 'Messaging', 'discord telegram slack gateway restart'],
  ['memory', 'Memory', 'memory user.md learned'],
  ['vault', 'Vault', 'password login card 1password bitwarden connectors'],
  ['config', 'Config', 'config.yaml keys secrets settings'],
  ['hosts', 'Hosts', 'remote ssh tailnet machine'],
  ['update', 'Update', 'version upgrade compatibility'],
];

function Palette({ onClose, start }: { onClose(): void; start?: 'projects' }) {
  const [mode, setMode] = useState(start);
  const { threads, projects } = useStore(useShallow(s => ({ threads: s.threads, projects: s.projects })));
  const route = useRoute();
  const here = route.name === 'thread' ? threads.find(t => t.id === route.id) : undefined;
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const options = useMemo(() => {
    const needle = q.toLowerCase().trim();
    const all: Opt[] = [
      { label: 'New thread', hint: 'start', href: '/new' },
      ...projects.flatMap(p => [{ label: `New thread in ${p.name}`, hint: 'start', href: `/new/${p.id}` }, { label: `${p.name} board`, hint: 'board', href: `/board/${p.id}` }]),
      ...threads.filter(t => t.status !== 'archived').sort((a, b) => b.updatedAt - a.updatedAt)
        .map(t => ({ label: t.title, hint: t.readOnly ? sourceLabel(t.source) : projects.find(p => p.id === t.projectId)?.name ?? 'chat', href: `/t/${t.id}`, status: t.status })),
      ...(projects.length > 1 ? [{ label: 'Filter projects in the sidebar…', hint: 'filter', keywords: 'show hide projects sidebar toggle', stay: true, run: () => setMode('projects') }] : []),
      { label: 'Inbox', hint: 'go', href: '/inbox' }, { label: 'Rooms', hint: 'go', href: '/rooms' }, { label: 'Automations', hint: 'go', href: '/automations', keywords: 'cron schedules jobs scheduled recurring' }, { label: 'Hermes history', hint: 'go', href: '/sessions' }, { label: 'Settings', hint: 'go', href: '/settings' },
      ...SETTINGS.map(([id, label, keywords]) => ({ label: `${label} settings`, hint: 'settings', href: `/settings/${id}`, keywords })),
      ...(here ? [
        { label: here.pinned ? 'Unpin this thread' : 'Pin this thread', hint: 'action', run: () => { api.patch(`/api/threads/${here.id}`, { pinned: !here.pinned }).catch(toastError); } },
        ...(here.status !== 'archived' ? [{ label: 'Archive this thread', hint: 'action', run: () => archiveWithUndo(here) }] : []),
      ] : []),
      { label: document.documentElement.dataset.theme === 'light' ? 'Switch to Night theme' : 'Switch to Daylight theme', hint: 'action', keywords: 'theme dark light mode',
        run: () => { localStorage.setItem('gibbous.theme', document.documentElement.dataset.theme === 'light' ? 'night' : 'light'); applyPrefs(); } },
      { label: document.documentElement.dataset.skymoon === 'off' ? 'Show tonight\'s moon' : 'Hide tonight\'s moon', hint: 'action', keywords: 'background moon',
        run: () => { localStorage.setItem('gibbous.skymoon', document.documentElement.dataset.skymoon === 'off' ? 'on' : 'off'); applyPrefs(); } },
    ];
    // Name matches rank above keyword-only matches ("daylight" → the theme action, then Appearance settings).
    const hits = needle
      ? [...all.filter(o => o.label.toLowerCase().includes(needle)), ...all.filter(o => !o.label.toLowerCase().includes(needle) && `${o.hint} ${o.keywords ?? ''}`.toLowerCase().includes(needle))]
      : all.filter(o => o.hint !== 'settings');
    // Always offer a full-text search across every conversation.
    return [...hits.slice(0, 11), ...(needle ? [{ label: `Search all conversations for “${q.trim()}”`, hint: 'search', href: `/search?q=${encodeURIComponent(q.trim())}` }] : [])];
  }, [q, threads, projects]);
  const pick = (i: number) => { const o = options[i]; if (!o) return; o.run ? o.run() : go(o.href!); if (!o.stay) onClose(); };
  if (mode === 'projects') return <ProjectFilter onClose={onClose} onBack={start ? undefined : () => setMode(undefined)} />;
  return (
    <div className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-[3px] flex justify-center pt-[12vh] px-3 animate-fade" onClick={onClose}>
      <div role="dialog" aria-label="Search or jump" className="pop w-full max-w-xl h-fit rounded-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 border-b border-line">
          <Search size={16} className="text-ash" />
          <input autoFocus className="flex-1 bg-transparent py-3.5 text-[15px] placeholder:text-ash focus:outline-none" placeholder="Jump to a thread, board or page, or search everything…" value={q}
            onChange={e => { setQ(e.target.value); setSel(0); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, options.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
              if (e.key === 'Enter') pick(sel);
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }} />
          <Kbd>esc</Kbd>
        </div>
        <ul role="listbox" className="max-h-[52vh] overflow-y-auto p-1.5">
          {options.map((o, i) => (
            <li key={(o.href ?? '') + o.label} role="option" aria-selected={i === sel}>
              <button onMouseMove={() => setSel(i)} onClick={() => pick(i)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors duration-100 ${i === sel ? 'bg-ridge text-moon' : 'text-moon/85'}`}>
                {o.status ? <Moon thread={o.status} size={9} /> : <span className="size-[9px]" />}
                <span className="truncate flex-1">{o.label}</span>
                <span className="label text-ash">{o.hint}</span>
                {i === sel && <CornerDownLeft size={13} className="text-ash animate-fade" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Two soft sine notes, a fifth apart. Synthesised, so there's no sound file to ship.
function chime() {
  try {
    const ctx = new AudioContext(), t = ctx.currentTime;
    for (const [f, at] of [[880, 0], [1318.5, .12]] as const) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + at); g.gain.linearRampToValueAtTime(.08, t + at + .02); g.gain.exponentialRampToValueAtTime(.0001, t + at + .9);
      o.connect(g).connect(ctx.destination); o.start(t + at); o.stop(t + at + 1);
    }
    setTimeout(() => ctx.close(), 1500);
  } catch { /* no audio */ }
}

function Toasts() {
  const { toasts, dismiss } = useStore(useShallow(s => ({ toasts: s.toasts, dismiss: s.dismiss })));
  return (
    <div aria-live="polite" className="fixed z-[70] top-[calc(env(safe-area-inset-top)+.5rem)] sm:top-auto sm:bottom-4 right-3 left-3 sm:left-auto sm:right-4 sm:w-96 flex flex-col gap-2 pointer-events-none sm:pb-[env(safe-area-inset-bottom)]">
      {toasts.map(t => (
        <div key={t.id} className={`pop pointer-events-auto rounded-xl px-4 py-3 flex gap-3 [--origin:top] sm:[--origin:bottom_right] ${t.tone === 'error' ? 'border-oxide/45' : ''}`}>
          <span className={`mt-1.5 size-1.5 flex-none rounded-full ${t.tone === 'error' ? 'bg-oxide' : 'bg-tide'}`} />
          <button className="flex-1 min-w-0 text-left" onClick={() => { if (t.url) { t.url.startsWith('http') ? window.open(t.url, '_blank') : (location.hash = t.url.replace(/^\/#/, '')); } dismiss(t.id); }}>
            <p className={`text-sm font-bold ${t.tone === 'error' ? 'text-oxide' : ''}`}>{t.title}</p>
            {t.body && <p className="text-[13px] text-dust line-clamp-3 mt-0.5">{t.body}</p>}
          </button>
          {t.action && <button onClick={() => { t.action!.run(); dismiss(t.id); }} className="press self-center h-8 px-3 rounded-lg bg-ridge text-[13px] font-bold text-moon hover:bg-line">{t.action.label}</button>}
          {t.tone === 'error' && <button aria-label="Copy error details" data-tip="Copy details" onClick={() => navigator.clipboard.writeText(`${t.title}${t.body ? `\n${t.body}` : ''}\n\nat ${location.hash || '#/'} · ${new Date().toISOString()} · ${navigator.userAgent}`).then(() => dismiss(t.id))}
            className="press text-ash hover:text-moon self-start rounded p-0.5"><Copy size={14} /></button>}
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="press text-ash hover:text-moon self-start rounded p-0.5"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
