// Account limits (Codex / Claude session and weekly windows) from /api/limits: a compact block for the sidebar corner
// and a fuller card for Home and Settings → Usage. Like CodexBar: how much of each window is used and when it resets.
import { useEffect, useState } from 'react';
import { api } from './api';

export interface LimitWindow { label: string; usedPercent: number | null; resetAt: number | null; scope: string; detail: string | null }
export interface AccountLimits { provider: string; label: string; plan: string | null; windows: LimitWindow[]; details: string[]; unavailable: string | null; fetchedAt: number }

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
    return () => { subs.delete(setV); if (!subs.size && timer) { clearInterval(timer); timer = undefined; } };
  }, []);
  return v;
}

// "Current session" → "Session", "Current week" → "Week", "Weekly" → "Week".
export const shortLabel = (l: string) => /session|5.?h/i.test(l) ? 'Session' : /week/i.test(l) ? (/opus/i.test(l) ? 'Opus week' : /sonnet/i.test(l) ? 'Sonnet week' : 'Week') : l;
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

function Bar({ w, now }: { w: LimitWindow; now: number }) {
  const p = Math.max(0, Math.min(100, w.usedPercent ?? 0));
  return <div className="min-w-0" data-tip={`${w.label}: ${Math.round(p)}% used${w.resetAt ? ` · resets ${resetIn(w.resetAt, now)}` : ''}`}>
    <div className="flex items-baseline gap-1.5 text-[11px] text-ash"><span className="truncate">{shortLabel(w.label)}</span>
      <span className="ml-auto tabular-nums text-dust">{Math.round(p)}%</span></div>
    <div className="mt-0.5 h-1 rounded-full bg-line overflow-hidden"><div className={`h-full rounded-full ${tone(p)} transition-[width] duration-500`} style={{ width: `${p}%` }} /></div>
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
            {w.resetAt && <p className="mt-0.5 text-[10.5px] text-ash">resets {resetIn(w.resetAt, now)}{w.scope === 'model' ? ' · this model only' : ''}</p>}
          </div>
        ))}
        {l.details.map(d => <p key={d} className="text-[11.5px] text-dust">{detailText(d)}</p>)}
      </section>
    ))}
  </div>;
}
