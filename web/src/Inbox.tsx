import { useEffect, useState } from 'react';
import { Menu, ChevronLeft } from 'lucide-react';
import { api, hermes } from './api';
import { useStore } from './store';
import { Moon, IconButton, Empty, Button, Logo, inputCls, ago, fmtUsd } from './ui';
import { RequestCard } from './thread/RequestCard';
import { SkyMoon } from './SkyMoon';

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
  const threads = useStore(s => s.threads);
  const errored = threads.filter(t => t.status === 'error');
  const midnight = new Date().setHours(0, 0, 0, 0);
  const doneToday = threads.filter(t => !t.readOnly && t.status === 'idle' && t.lastText && t.updatedAt >= midnight).sort((a, b) => b.updatedAt - a.updatedAt);
  const [spent, setSpent] = useState<number>();
  // Today's row of the daily breakdown (Hermes's `totals` aren't scoped to the requested days).
  useEffect(() => { hermes.get<{ daily: { day: string; actual_cost: number; estimated_cost: number }[] }>('analytics/usage?days=2').then(u => { const d = u.daily.find(x => x.day === new Date().toLocaleDateString('en-CA')); setSpent(d ? d.actual_cost || d.estimated_cost : 0); }, () => {}); }, []);
  const empty = !requests.length && !errored.length && !doneToday.length;
  return (
    <div className="h-full flex flex-col">
      <Header title="Inbox" />
      {empty ? <Empty title="Nothing needs you" /> : (
        <div className="flex-1 overflow-y-auto"><div className="mx-auto max-w-2xl p-4 space-y-8">
          {requests.length > 0 && <section className="space-y-3"><h2 className="label">Waiting for an answer</h2>{requests.map(r => <RequestCard key={r.id} r={r} showThread />)}</section>}
          {errored.length > 0 && <section className="space-y-2"><h2 className="label">Threads with errors</h2>
            {errored.map(t => (
              <a key={t.id} href={`#/t/${t.id}`} className="tile flex items-center gap-3 rounded-xl px-3 py-2.5">
                <Moon thread={t.status} size={10} /><span className="flex-1 min-w-0"><span className="block truncate font-bold text-sm">{t.title}</span><span className="block text-xs text-oxide truncate">{t.error}</span></span>
              </a>
            ))}</section>}
          {doneToday.length > 0 && <section className="space-y-2">
            <h2 className="label flex items-baseline gap-2">Today<span className="normal-case tracking-normal font-sans text-[12px] text-ash">{[`${doneToday.length} finished`, spent && `${fmtUsd(spent)} spent`].filter(Boolean).join(' · ')}</span></h2>
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
