import { useEffect, useMemo, useState } from 'react';
import { Menu, Search, Server, Laptop, ChevronLeft } from 'lucide-react';
import { api, hermes, type Thread } from './api';
import { rpc, rpcFor } from './rpc';
import { useStore, toastError } from './store';
import { Moon, IconButton, Empty, Button, Logo, MoonLoader, inputCls, go, ago, sourceLabel, fmtUsd } from './ui';
import { RequestCard } from './thread/RequestCard';
import { SkyMoon } from './SkyMoon';
import type { SessionListRow, ForeignSessionRow } from './hermes/contract';

// `back` (phones only) swaps the drawer button for a back link, for pages that drill into a list.
const Header = ({ title, children, back }: { title: string; children?: React.ReactNode; back?: { href: string; label: string } }) => (
  <header data-drag-window className="flex items-center gap-2 px-3 h-12 border-b border-line flex-none">
    {back && <a href={back.href} aria-label={`Back to ${back.label}`} className="md:hidden press inline-grid place-items-center size-8 -ml-1 rounded-lg text-tide"><ChevronLeft size={20} /></a>}
    <span className={back ? 'hidden md:contents' : 'contents'}><IconButton label="Open sidebar" className="lg:hidden" onClick={() => useStore.setState({ sidebar: true })}><Menu size={17} /></IconButton></span>
    <h1 className="font-bold">{title}</h1>{children}
  </header>
);
export { Header as PageHeader };

export function InboxView() {
  const requests = useStore(s => s.requests);
  const tasks = useStore(s => s.tasks);
  const threads = useStore(s => s.threads);
  const projects = useStore(s => s.projects);
  const review = tasks.filter(t => t.status === 'review' || t.status === 'failed');
  const errored = threads.filter(t => t.status === 'error');
  const midnight = new Date().setHours(0, 0, 0, 0);
  const doneToday = threads.filter(t => !t.readOnly && t.role !== 'worker' && t.role !== 'reviewer' && t.role !== 'planner' && t.status === 'idle' && t.lastText && t.updatedAt >= midnight).sort((a, b) => b.updatedAt - a.updatedAt);
  const mergedToday = tasks.filter(t => t.status === 'done' && (t.finishedAt ?? t.updatedAt) >= midnight);
  const [spent, setSpent] = useState<number>();
  // Today's row of the daily breakdown (Hermes's `totals` aren't scoped to the requested days).
  useEffect(() => { hermes.get<{ daily: { day: string; actual_cost: number; estimated_cost: number }[] }>('analytics/usage?days=2').then(u => { const d = u.daily.find(x => x.day === new Date().toLocaleDateString('en-CA')); setSpent(d ? d.actual_cost || d.estimated_cost : 0); }, () => {}); }, []);
  const empty = !requests.length && !review.length && !errored.length && !doneToday.length && !mergedToday.length;
  return (
    <div className="h-full flex flex-col">
      <Header title="Inbox" />
      {empty ? <Empty title="Nothing needs you" /> : (
        <div className="flex-1 overflow-y-auto"><div className="mx-auto max-w-2xl p-4 space-y-8">
          {requests.length > 0 && <section className="space-y-3"><h2 className="label">Waiting for an answer</h2>{requests.map(r => <RequestCard key={r.id} r={r} showThread />)}</section>}
          {review.length > 0 && <section className="space-y-2"><h2 className="label">Tasks to review</h2>
            {review.map(t => (
              <a key={t.id} href={`#/board/${t.projectId}`} className="tile flex items-center gap-3 rounded-xl px-3 py-2.5">
                <Moon task={t.status} size={10} /><span className="flex-1 min-w-0"><span className="block truncate font-bold text-sm">{t.title}</span>
                <span className="block text-xs text-dust">{projects.find(p => p.id === t.projectId)?.name} · {t.status === 'failed' ? 'failed' : t.verdict === 'approve' ? 'approved by reviewer' : 'reviewer asked for changes'}</span></span>
                <span className="text-xs text-ash">{ago(t.updatedAt)}</span>
              </a>
            ))}</section>}
          {errored.length > 0 && <section className="space-y-2"><h2 className="label">Threads with errors</h2>
            {errored.map(t => (
              <a key={t.id} href={`#/t/${t.id}`} className="tile flex items-center gap-3 rounded-xl px-3 py-2.5">
                <Moon thread={t.status} size={10} /><span className="flex-1 min-w-0"><span className="block truncate font-bold text-sm">{t.title}</span><span className="block text-xs text-oxide truncate">{t.error}</span></span>
              </a>
            ))}</section>}
          {(doneToday.length > 0 || mergedToday.length > 0) && <section className="space-y-2">
            <h2 className="label flex items-baseline gap-2">Today<span className="normal-case tracking-normal font-sans text-[12px] text-ash">{[doneToday.length && `${doneToday.length} finished`, mergedToday.length && `${mergedToday.length} merged`, spent && `${fmtUsd(spent)} spent`].filter(Boolean).join(' · ')}</span></h2>
            {mergedToday.map(t => (
              <a key={t.id} href={t.mergedAs?.startsWith('http') ? t.mergedAs : `#/board/${t.projectId}`} target={t.mergedAs?.startsWith('http') ? '_blank' : undefined} className="tile flex items-center gap-3 rounded-xl px-3 py-2.5">
                <Moon task="done" size={10} /><span className="flex-1 min-w-0"><span className="block truncate text-sm">{t.title}</span><span className="block text-xs text-dust">{projects.find(p => p.id === t.projectId)?.name} · {t.mergedAs?.startsWith('http') ? 'pull request opened' : `merged ${t.mergedAs ?? ''}`}</span></span>
                <span className="text-xs text-ash">{ago(t.finishedAt ?? t.updatedAt)}</span>
              </a>
            ))}
            {doneToday.slice(0, 12).map(t => (
              <a key={t.id} href={`#/t/${t.id}`} className="tile flex items-center gap-3 rounded-xl px-3 py-2.5">
                <Moon thread={t.status} size={10} /><span className="flex-1 min-w-0"><span className="block truncate text-sm">{t.title}</span><span className="block text-xs text-dust truncate">{t.lastText?.replace(/\s+/g, ' ').slice(0, 140)}</span></span>
                <span className="text-xs text-ash">{ago(t.updatedAt)}</span>
              </a>
            ))}
          </section>}
        </div></div>
      )}
    </div>
  );
}

// Every Hermes session (Discord, CLI, cron, Paseo…). Opening one adds it to Gibbous as a read-only thread;
// "Keep in sidebar" mirrors a whole source (e.g. all Discord chats) automatically.
export function SessionsView() {
  const [rows, setRows] = useState<SessionListRow[]>();
  const [q, setQ] = useState('');
  const [src, setSrc] = useState<string>(() => localStorage.getItem('gibbous.historySource') ?? 'all');
  const threads = useStore(s => s.threads);
  const settings = useStore(s => s.settings);
  const toast = useStore(s => s.toast);
  const hosts = useStore(s => s.hosts);
  const [machine, setMachine] = useState(''); // '' = this Mac, else a host id
  const known = useMemo(() => new Map(threads.filter(t => (t.host ?? '') === machine).map(t => [t.sessionId, t])), [threads, machine]);
  useEffect(() => { setRows(undefined); rpcFor(machine || undefined).call('session.list', { limit: 5000 }).then(r => setRows(r.sessions)).catch(e => { toastError(e); setRows([]); }); }, [machine]);
  useEffect(() => { localStorage.setItem('gibbous.historySource', src); }, [src]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.source ?? 'other', (m.get(r.source ?? 'other') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const needle = q.toLowerCase();
  const shown = (rows ?? []).filter(r => (src === 'all' || r.source === src) && (!needle || `${r.title} ${r.preview}`.toLowerCase().includes(needle))).slice(0, 400);
  // Claude Code / Codex sessions on this Mac: imported into Hermes on open, then they're ordinary threads.
  const foreign = !machine && (src === 'claude' || src === 'codex');
  const [fRows, setFRows] = useState<ForeignSessionRow[] | null>(null);
  useEffect(() => { if (foreign) { setFRows(null); rpc.call('session.foreign.list', { source: src as 'claude' | 'codex', limit: 200 }).then(r => setFRows(r.sessions ?? []), e => { toastError(e); setFRows([]); }); } }, [src, foreign]);
  const openForeign = async (r: ForeignSessionRow) => {
    try {
      const imp = await rpc.call('session.foreign.import', { id: r.id });
      const t = await api.post<Thread>('/api/import', { sessionId: imp.session_id, title: r.title || r.label, source: r.source === 'claude' ? 'claude_code' : 'codex', readOnly: false });
      go(`/t/${t.id}`);
    } catch (e) { toastError(e); }
  };
  const synced = new Set(settings?.syncSources ?? []);

  const open = async (r: SessionListRow) => {
    const existing = known.get(r.id);
    if (existing) return go(`/t/${existing.id}`);
    try {
      const t = await api.post<Thread>('/api/import', { sessionId: r.id, title: r.title || r.preview?.slice(0, 60), source: r.source, startedAt: r.started_at ? r.started_at * 1000 : undefined, host: machine || undefined });
      go(`/t/${t.id}`);
    } catch (e) { toastError(e); }
  };
  const toggleSync = async (source: string) => {
    const next = synced.has(source) ? [...synced].filter(x => x !== source) : [...synced, source];
    try {
      await api.patch('/api/settings', { syncSources: next });
      if (!synced.has(source)) {
        const r = await api.post<{ added: number }>('/api/sync');
        toast({ title: `${sourceLabel(source)} chats are in the sidebar`, body: r.added ? `Added ${r.added}. New ones appear automatically.` : 'New ones appear automatically.' });
      }
    } catch (e) { toastError(e); }
  };

  return (
    <div className="h-full flex flex-col">
      <Header title="Hermes history" />
      <div className="flex-1 overflow-y-auto"><div className="mx-auto max-w-3xl p-4 space-y-3">
        {hosts.length > 0 && <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Machine">
          {[{ id: '', name: 'This Mac', connected: true }, ...hosts].map(h => (
            <button key={h.id} role="radio" aria-checked={machine === h.id} onClick={() => { setMachine(h.id); setSrc('all'); }}
              className={`press inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-[13px] ${machine === h.id ? (h.id ? 'border-tide/50 bg-tide/10 text-tide' : 'border-moon/30 bg-ridge text-moon') : 'border-line text-dust hover:text-moon'}`}>
              {h.id ? <Server size={13} /> : <Laptop size={13} />}{h.name}{h.id && <span className="label text-[9px]">remote</span>}
              {h.id && !h.connected && <span className="size-1.5 rounded-full bg-halo animate-pulse" />}
            </button>
          ))}
        </div>}
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Source">
          {[['all', rows?.length ?? 0] as const, ...counts, ...(machine ? [] : [['claude', null] as const, ['codex', null] as const])].map(([s, n]) => (
            <button key={s} role="radio" aria-checked={src === s} onClick={() => setSrc(s)}
              className={`h-7 pointer-coarse:h-9 px-2.5 rounded-md border text-[12.5px] ${src === s ? 'border-tide bg-tide/10 text-moon' : 'border-line text-dust hover:text-moon'}`}>
              {s === 'all' ? 'All' : s === 'claude' ? 'Claude Code' : s === 'codex' ? 'Codex' : sourceLabel(s)} {n != null && <span className="text-ash">{n}</span>}
            </button>
          ))}
        </div>
        {foreign && <p className="text-[13px] text-dust">Sessions from {src === 'claude' ? 'Claude Code' : 'Codex'} on this Mac. Opening one copies it into Hermes so you can continue it here.</p>}
        {src !== 'all' && !foreign && !machine && (
          <label className="flex items-center gap-2 text-sm text-dust select-none">
            <input type="checkbox" className="accent-tide" checked={synced.has(src)} onChange={() => toggleSync(src)} />
            Keep {sourceLabel(src)} conversations in the sidebar (new ones are added automatically)
          </label>
        )}
        <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" /><input className={inputCls + ' pl-9'} placeholder="Search titles and previews" value={q} onChange={e => setQ(e.target.value)} /></div>
        {!rows && !foreign && <p className="flex items-center gap-2.5 text-sm text-dust"><MoonLoader size={20} />Loading sessions…</p>}
        {foreign && (fRows === null ? <p className="flex items-center gap-2.5 text-sm text-dust"><MoonLoader size={20} />Looking for sessions…</p> : <ul className="divide-y divide-line">{fRows.filter(r => !needle || `${r.title} ${r.excerpt} ${r.cwd}`.toLowerCase().includes(needle)).map(r => (
          <li key={r.id}><button onClick={() => openForeign(r)} className="press w-full text-left py-2.5 px-1 flex gap-3 hover:bg-ridge/40 rounded">
            <span className="flex-1 min-w-0"><span className="block truncate text-sm font-bold">{r.title || r.label}</span><span className="block truncate text-xs text-dust">{r.cwd ? `${r.cwd} · ` : ''}{r.excerpt}</span></span>
            <span className="text-xs text-ash tabular-nums flex-none">{r.turn_count ?? 0} turns · {ago(r.mtime * 1000)}</span>
          </button></li>
        ))}</ul>)}
        {!foreign && <ul className="divide-y divide-line">
          {shown.map(r => (
            <li key={r.id}><button onClick={() => open(r)} className="w-full text-left py-2.5 px-1 flex gap-3 hover:bg-ridge/40 rounded">
              <span className="hidden sm:block label w-20 flex-none pt-0.5 text-ash truncate">{sourceLabel(r.source)}</span>
              <span className="flex-1 min-w-0"><span className="block truncate text-sm font-bold">{r.title || 'Untitled'}{known.has(r.id) && <span className="label ml-2 text-tide">in gibbous</span>}</span><span className="block truncate text-xs text-dust">{r.preview}</span>
                <span className="sm:hidden block text-[11.5px] text-ash">{sourceLabel(r.source)} · {r.message_count} msgs · {r.started_at ? ago(r.started_at * 1000) : ''}</span></span>
              <span className="hidden sm:block text-xs text-ash tabular-nums flex-none">{r.message_count} msgs · {r.started_at ? ago(r.started_at * 1000) : ''}</span>
            </button></li>
          ))}
        </ul>}
        {rows && !foreign && shown.length === 400 && <p className="text-xs text-ash">Showing the newest 400.</p>}
      </div></div>
    </div>
  );
}

export function Login() {
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  // Accept the bare token or a whole sign-in link (…/login?token=…), as copied from Settings → Phone.
  const extract = (v: string) => { try { return new URL(v.trim()).searchParams.get('token') ?? v.trim(); } catch { return v.trim(); } };
  const signIn = async (raw: string) => {
    try { await api.post('/api/login', { token: extract(raw) }); location.reload(); } catch { setErr('That token is wrong. Copy the sign-in link from Settings → Phone on a signed-in device, or from ~/.gibbous/login-url on the Mac.'); }
  };
  const paste = async () => { try { const v = await navigator.clipboard.readText(); setToken(v); signIn(v); } catch { setErr('Clipboard access was blocked; paste into the field instead.'); } };
  return (
    <div className="relative h-full grid place-items-center p-6 overflow-hidden">
      <SkyMoon />
      <form onSubmit={e => { e.preventDefault(); signIn(token); }} className="relative w-full max-w-sm space-y-5 animate-rise">
        <div className="flex items-center gap-2.5"><Logo size={22} /><span className="font-label tracking-[0.2em]">gibbous</span></div>
        <div className="space-y-1.5"><h1 className="text-[22px] font-bold tracking-[-.01em]">Sign in</h1><p className="text-sm text-dust">Paste the sign-in link or access token from a device that's already signed in.</p></div>
        <input className={inputCls + ' font-mono h-10'} type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Sign-in link or token" autoFocus aria-label="Sign-in link or token" />
        {err && <p className="text-sm text-oxide animate-fade">{err}</p>}
        <div className="flex gap-2">
          <Button type="button" size="lg" className="flex-1" onClick={paste}>Paste link</Button>
          <Button tone="primary" size="lg" className="flex-1" disabled={!token}>Sign in</Button>
        </div>
      </form>
    </div>
  );
}
