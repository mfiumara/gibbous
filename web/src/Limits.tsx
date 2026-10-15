// Account limits (Codex / Claude session and weekly windows) from /api/limits: a compact block for the sidebar corner
// and a fuller card for Home and Settings → Usage. Like CodexBar: how much of each window is used and when it resets.
import { useEffect, useState } from 'react';
import { api } from './api';
import { pace } from './limitsPace';
import { useStore, toastError } from './store';

export interface LimitWindow { label: string; usedPercent: number | null; resetAt: number | null; scope: string; detail: string | null; windowSeconds: number | null }
export interface AccountLimits { provider: string; label: string; plan: string | null; windows: LimitWindow[]; details: string[]; unavailable: string | null; fetchedAt: number; resets: number | null }

let last: AccountLimits[] | undefined;
const subs = new Set<(v: AccountLimits[]) => void>();
let timer: ReturnType<typeof setInterval> | undefined, inflight: Promise<void> | undefined;
const load = (fresh = false) => inflight ??= api.get<AccountLimits[]>(`/api/limits${fresh ? '?fresh=1' : ''}`)
  .then(v => { last = v; subs.forEach(f => f(v)); }, () => {}).finally(() => { inflight = undefined; });
export const refreshLimits = () => load(true);

// One poll for every widget on screen, every two minutes while the app is visible.
export function useLimits(): AccountLimits[] | undefined {
  const [v, setV] = useState(last);
  useEffect(() => {
    subs.add(setV);
    if (!last) load();
    if (!timer) timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 120_000);
    const back = () => { if (document.visibilityState === 'visible' && (!last?.[0] || Date.now() - last[0].fetchedAt > 60_000)) load(); };
    document.addEventListener('visibilitychange', back);
    return () => { subs.delete(setV); document.removeEventListener('visibilitychange', back); if (!subs.size && timer) { clearInterval(timer); timer = undefined; } };
  }, []);
  return v;
}

// "Current session" → "Session", "Current week" → "Week", "Weekly" → "Week".
export const shortLabel = (l: string) => /session|5.?h/i.test(l) ? 'Session' : /^(current )?week(ly)?$/i.test(l.trim()) ? 'Week' : l.replace(/\bweek\b/i, 'weekly');   // 'Fable week' → 'Fable weekly'
export function resetIn(at: number | null, now = Date.now()): string {
  if (at == null) return '';
  const m = Math.max(0, Math.round((at - now) / 60_000));
  if (m < 60) return `in ${m}m`;
  if (m < 24 * 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
// Hermes phrases details for its own CLI ("… - use /usage reset to activate"): keep the fact.
const detailText = (d: string) => d.replace(/\s*[-–]\s*use \/usage.*$/i, '');
const tone = (p: number) => p >= 90 ? 'bg-oxide' : p >= 75 ? 'bg-halo' : 'bg-tide';

// Like CodexBar: the bar is what's LEFT of the window, the marker is how much time is left. Bar ending short of the
// marker = using it faster than the clock (deficit, red marker); past it = reserve (green marker).
function Bar({ w, now }: { w: LimitWindow; now: number }) {
  const used = Math.max(0, Math.min(100, w.usedPercent ?? 0)), left = 100 - used, pc = pace(w.usedPercent, w.resetAt, w.windowSeconds, now);
  const timeLeft = pc ? Math.max(0, Math.min(100, 100 - (used + pc.delta))) : null;
  return <div className="min-w-0" data-tip={`${w.label}: ${Math.round(left)}% left${pc ? ` · ${Math.round(Math.abs(pc.delta))}% ${pc.delta < 0 ? 'in deficit' : 'in reserve'}` : ''}${w.resetAt ? ` · resets ${resetIn(w.resetAt, now)}` : ''}`}>
    <div className="flex items-baseline gap-1.5 text-[11px] text-ash"><span className="truncate">{shortLabel(w.label)}</span>
      <span className="ml-auto tabular-nums text-dust">{Math.round(left)}% left</span></div>
    <div className="relative mt-0.5 h-1 rounded-full bg-line"><div className={`h-full rounded-full ${tone(used)} transition-[width] duration-500`} style={{ width: `${left}%` }} />
      {timeLeft != null && <span aria-hidden className={`absolute -inset-y-px w-[2px] -ml-px rounded-full ${pc!.delta < -0.5 ? 'bg-oxide/80' : 'bg-sprout/80'} shadow-[0_0_0_1px_var(--color-basalt)]`} style={{ left: `${timeLeft}%` }} />}</div>
  </div>;
}

// Sidebar corner: one line per login, its windows side by side.
export function LimitsMini({ onOpen }: { onOpen?(): void }) {
  const limits = useLimits(), now = Date.now();
  if (!limits?.length) return null;
  return <button onClick={onOpen} aria-label="Account limits" className="press w-full text-left px-3 py-1.5 rounded-lg hover:bg-ridge/55 space-y-1.5">
    {limits.filter(l => l.windows.length).map(l => (
      <div key={l.provider} className="flex items-center gap-2.5">
        <span className="w-[42px] flex-none text-[11.5px] text-dust truncate">{l.label}</span>
        <div className="flex-1 min-w-0 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(l.windows.length, 2)}, minmax(0, 1fr))` }}>
          {l.windows.slice(0, 2).map(w => <Bar key={w.label} w={w} now={now} />)}
        </div>
      </div>
    ))}
  </button>;
}

// Home and Settings → Usage: every window with its reset time, the plan, and what Hermes adds (banked resets…).
export function LimitsCard() {
  const limits = useLimits(), now = Date.now();
  const [busy, setBusy] = useState(false);
  if (!limits) return null;
  if (!limits.length) return <p className="text-[12.5px] text-ash">No account limits to show: none of your logins (Codex, Claude) report them.</p>;
  return <div className="grid sm:grid-cols-2 gap-3">
    {limits.map(l => (
      <section key={l.provider} className="rounded-xl surface bg-basalt p-3.5 space-y-2.5">
        <h3 className="flex items-baseline gap-2 text-[13px]"><span className="font-bold text-moon">{l.label}</span>{l.plan && <span className="text-ash">{l.plan}</span>}
          <button disabled={busy} onClick={async () => { setBusy(true); await refreshLimits(); setBusy(false); }} className="press ml-auto text-[11px] text-ash hover:text-moon disabled:opacity-50" data-tip={`Checked at ${new Date(l.fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`}>{busy ? 'Checking…' : 'Refresh'}</button></h3>
        {l.unavailable && <p className="text-[12px] text-oxide">{l.unavailable}</p>}
        {l.windows.map(w => (
          <div key={w.label}>
            <Bar w={w} now={now} />
            <p className="mt-0.5 flex flex-wrap gap-x-2 text-[10.5px] text-ash">{w.resetAt && <span className="whitespace-nowrap">resets {resetIn(w.resetAt, now)}{w.scope === 'model' ? ' · this model only' : ''}</span>}</p>
          </div>
        ))}
        {l.details.map(d => <p key={d} className="text-[11.5px] text-dust">{detailText(d)}</p>)}
        {l.provider === 'openai-codex' && l.resets != null && <ResetRow resets={l.resets} worst={Math.max(0, ...l.windows.map(w => w.usedPercent ?? 0))} />}
      </section>
    ))}
  </div>;
}

// Banked Codex resets: how many are left, and a button to use one. Always confirmed; a second, sterner confirmation
// when no window is used up yet (a reset restores the whole allowance, so most of it would be wasted).
function ResetRow({ resets, worst }: { resets: number; worst: number }) {
  const [busy, setBusy] = useState(false);
  const toast = useStore(s => s.toast);
  const use = async () => {
    if (!confirm(`Use 1 of your ${resets} banked Codex resets? It restores your full 5-hour and weekly limits right away.`)) return;
    setBusy(true);
    try {
      let r = await api.post<{ status: string; available: number | null }>('/api/limits/codex/reset', { force: false });
      if (r.status === 'not_exhausted') {
        if (!confirm(`Your busiest window is only ${Math.round(worst)}% used, so most of this reset would go to waste. Use it anyway?`)) return;
        r = await api.post('/api/limits/codex/reset', { force: true });
      }
      const left = r.available ?? undefined;
      toast(r.status === 'reset' ? { title: `Reset used: your Codex limits are full again${left != null ? ` · ${left} left` : ''}` }
        : r.status === 'nothing_to_reset' ? { title: 'Nothing to reset: your limits aren\'t used up. No reset was spent.' }
        : r.status === 'already_redeemed' ? { title: 'That reset was already processed; nothing more was spent.' }
        : { title: r.status === 'no_credits_banked' || r.status === 'no_credit' ? 'No banked resets left on this account.' : 'Could not use a reset right now. Try again shortly.', tone: 'error' });
      await refreshLimits();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return <div className="flex items-center gap-2 pt-1 border-t border-line/60 text-[12px]">
    <span className="text-dust">{resets === 0 ? 'No resets banked' : `${resets} reset${resets === 1 ? '' : 's'} banked`}</span>
    {resets > 0 && <button disabled={busy} onClick={use} className="press ml-auto h-7 px-2.5 rounded-md border border-line text-[12px] text-moon hover:bg-ridge disabled:opacity-50">{busy ? 'Resetting…' : 'Use a reset…'}</button>}
  </div>;
}
