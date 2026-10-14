// Settings → Usage: tokens, sessions and API-equivalent cost per model, day, source, profile and thread, read from
// every Hermes state.db by the Gibbous server (/api/usage). Charts are hand-drawn SVG; numbers are tabular.
import { LimitsCard } from '../Limits';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Segmented, Skeleton, Empty, MoonDisc } from '../ui';
import { useUsage } from '../useUsage';
import { buckets, fmtCount, fmtCost, fmtPct, niceMax, seriesOf, type Range, type UsageReport, type Bucket } from '../usage';

const RANGES: { value: Range; label: string }[] = [{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }, { value: 'all', label: 'All' }];
const RANGE_WORDS: Record<Range, string> = { '7': 'the last 7 days', '30': 'the last 30 days', '90': 'the last 90 days', all: 'all time' };
const color = (i: number) => `var(--color-s${i < 0 ? 0 : i + 1})`;
const Dot = ({ c }: { c: string }) => <span aria-hidden className="inline-block size-2 rounded-[3px] flex-none" style={{ background: c }} />;
const num = 'tabular-nums text-right';

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return <section className="surface rounded-2xl p-4 sm:p-5">
    <div className="flex items-baseline gap-3 mb-3.5"><h2 className="font-bold text-[14.5px] flex-1">{title}</h2>{aside && <span className="text-[12px] text-ash tabular-nums">{aside}</span>}</div>
    {children}
  </section>;
}

function Stat({ label, value, sub, tip }: { label: string; value: string; sub?: string; tip?: string }) {
  return <div className="min-w-0" data-tip={tip}>
    <p className="label">{label}</p>
    <p className="text-[20px] font-semibold tracking-[-.01em] leading-tight mt-1 tabular-nums">{value}</p>
    {sub && <p className="text-[11.5px] text-ash truncate tabular-nums">{sub}</p>}
  </div>;
}

function Headline({ r }: { r: UsageReport }) {
  const t = r.totals, hit = t.cacheHitRate;
  return <section className="surface moonlit rounded-2xl p-5 space-y-5">
    <div className="flex items-center gap-5">
      <MoonDisc fraction={hit ?? 0} size={68} />
      <div className="min-w-0">
        <p className="label">Tokens · {RANGE_WORDS[r.days == null ? 'all' : String(r.days) as Range]}</p>
        <p className="text-[34px] sm:text-[40px] font-bold tracking-[-.025em] leading-none mt-1.5 tabular-nums">{fmtCount(t.tokens)}</p>
        <p className="text-[12.5px] text-dust mt-1.5 tabular-nums">{fmtCount(t.input)} in · {fmtCount(t.output)} out{t.reasoning ? ` · ${fmtCount(t.reasoning)} reasoning` : ''}</p>
      </div>
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-4 pt-4 border-t border-line">
      <Stat label="Sessions" value={t.sessions.toLocaleString()} sub={`${t.apiCalls.toLocaleString()} model calls`} />
      <Stat label="Tool calls" value={t.toolCalls.toLocaleString()} sub={`${t.messages.toLocaleString()} messages`} />
      <Stat label="Cache hits" value={hit == null ? '—' : fmtPct(hit)} sub={`${fmtCount(t.cacheRead)} read from cache`} tip="Share of prompt tokens served from the provider's cache. The moon fills with it." />
      <Stat label="API-equivalent" value={t.costUsd == null ? '—' : `~${fmtCost(t.costUsd)}`} sub={t.costUsd == null ? 'nothing priced' : t.includedUsd > 0 ? `~${fmtCost(t.includedUsd)} of it on your subscription` : `${t.pricedSessions.toLocaleString()} sessions priced`}
        tip="What it would cost at API list prices. Subscription use (ChatGPT/Codex login) is priced at the same list prices." />
    </div>
  </section>;
}

const shortDay = (d: string) => new Date(d + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDay = (d: string) => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function Chart({ data, series, labels }: { data: Bucket[]; series: string[]; labels: Record<string, string> }) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width)))); ro.observe(box.current!); return () => ro.disconnect(); }, []);
  const H = 176, P = { l: 38, r: 2, t: 8, b: 22 };
  const max = niceMax(Math.max(0, ...data.map(d => d.tokens)));
  const cw = (W - P.l - P.r) / Math.max(1, data.length), gap = Math.min(6, Math.max(1, cw * 0.28)), bw = Math.max(1, cw - gap);
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - v / max);
  const order = [...series, 'other'];
  const step = Math.ceil(data.length / Math.max(2, Math.floor((W - P.l) / 64)));
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), x = (e.clientX - r.left) * (W / r.width) - P.l;
    const i = Math.floor(x / cw); setHover(i >= 0 && i < data.length ? i : null);
  };
  const h = hover != null ? data[hover] : null, weekly = data.length > 1 && data[0].day !== data[0].end;
  return <div ref={box} className="relative select-none">
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block w-full h-auto touch-pan-y" role="img" aria-label="Tokens per day, stacked by model"
      onPointerMove={pick} onPointerDown={pick} onPointerLeave={e => e.pointerType === 'mouse' && setHover(null)}>
      {[0, 0.5, 1].map(f => <g key={f}>
        <line x1={P.l} x2={W - P.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--color-line)" strokeDasharray={f ? '2 4' : undefined} />
        <text x={P.l - 7} y={y(max * f)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--color-ash)" className="tabular-nums">{fmtCount(max * f)}</text>
      </g>)}
      {hover != null && <rect x={P.l + hover * cw} y={P.t} width={cw} height={H - P.t - P.b} rx={4} fill="var(--color-ridge)" opacity={0.55} />}
      {data.map((d, i) => {
        let acc = 0;
        const segs = order.map(k => [k, d.parts[k] ?? 0] as const).filter(([, v]) => v > 0);
        const x = P.l + i * cw + gap / 2;
        return <g key={d.day} opacity={hover == null || hover === i ? 1 : 0.5} className="transition-opacity duration-150">
          {segs.map(([k, v], j) => {
            const y0 = y(acc), y1 = y(acc += v), last = j === segs.length - 1, hh = Math.max(0, y0 - y1);
            const rr = last ? Math.min(3, bw / 2, hh) : 0;
            return <path key={k} fill={color(series.indexOf(k))}
              d={`M${x},${y0} V${y1 + rr} q0,-${rr} ${rr},-${rr} h${bw - 2 * rr} q${rr},0 ${rr},${rr} V${y0} Z`} />;
          })}
        </g>;
      })}
      {data.map((d, i) => i % step === 0 && <text key={d.day} x={P.l + i * cw + cw / 2} y={H - 5} textAnchor="middle" fontSize={10} fill="var(--color-ash)">{shortDay(d.day)}</text>)}
    </svg>
    {h && <div className="pop pointer-events-none absolute top-1 rounded-xl px-3 py-2.5 text-[12px] w-52 [--origin:top]"
      style={{ left: `${((P.l + (hover! + 0.5) * cw) / W) * 100}%`, transform: `translateX(${hover! > data.length / 2 ? 'calc(-100% - 10px)' : '10px'})` }}>
      <p className="font-semibold">{weekly ? `${shortDay(h.day)} – ${shortDay(h.end)}` : longDay(h.day)}</p>
      <div className="mt-1.5 space-y-0.5">
        {order.filter(k => h.parts[k]).map(k => <p key={k} className="flex items-center gap-2"><Dot c={color(series.indexOf(k))} /><span className="flex-1 truncate text-dust">{labels[k] ?? 'Other models'}</span><span className="tabular-nums">{fmtCount(h.parts[k])}</span></p>)}
        {!h.tokens && <p className="text-ash">No usage</p>}
      </div>
      {h.tokens > 0 && <p className="mt-1.5 pt-1.5 border-t border-line flex text-dust tabular-nums"><span className="flex-1">{h.sessions} session{h.sessions === 1 ? '' : 's'}</span>{h.costUsd != null && <span>~{fmtCost(h.costUsd)}</span>}</p>}
    </div>}
  </div>;
}

function Bar({ f, c }: { f: number; c: string }) {
  return <span className="block h-[5px] rounded-full bg-ridge/80 overflow-hidden"><span className="block h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(f > 0 ? 1.5 : 0, f * 100)}%`, background: c }} /></span>;
}

function Models({ r, series }: { r: UsageReport; series: string[] }) {
  const total = r.totals.tokens || 1, priced = r.models.some(m => m.costUsd != null);
  const cols = priced ? 'grid-cols-[minmax(0,1fr)_4.25rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_4.5rem_3.25rem_5rem]' : 'grid-cols-[minmax(0,1fr)_4.25rem] sm:grid-cols-[minmax(0,1fr)_4.5rem_3.25rem]';
  return <div className="text-[13px]">
    <div className={`grid ${cols} gap-x-3 pb-2 label`}><span>Model</span><span className="text-right">Tokens</span><span className="text-right hidden sm:block">Share</span>{priced && <span className="text-right">API-eq.</span>}</div>
    <ul>{r.models.map(m => {
      const i = series.indexOf(m.id);
      return <li key={m.id} className={`grid ${cols} gap-x-3 items-center py-2 border-t border-line`}>
        <span className="min-w-0 space-y-1.5">
          <span className="flex items-baseline gap-2 min-w-0"><Dot c={color(i)} /><span className="truncate text-moon" data-tip={m.id}>{m.label}</span>{m.providers.length > 0 && <span className="hidden sm:inline truncate text-[11.5px] text-ash">{m.providers.join(', ')}</span>}</span>
          <Bar f={m.tokens / total} c={color(i)} />
        </span>
        <span className={num} data-tip={`${m.sessions.toLocaleString()} sessions · ${fmtCount(m.cacheRead)} from cache`}>{fmtCount(m.tokens)}</span>
        <span className={`${num} text-dust hidden sm:block`}>{fmtPct(m.tokens / total)}</span>
        {priced && <span className={`${num} ${m.costUsd == null ? 'text-ash' : 'text-dust'}`}>{m.costUsd == null ? '—' : `~${fmtCost(m.costUsd)}`}</span>}
      </li>;
    })}</ul>
  </div>;
}

function Groups({ rows, total, limit = 6 }: { rows: { key: string; label: string; tokens: number; sessions: number }[]; total: number; limit?: number }) {
  const [all, setAll] = useState(false);
  const cut = rows.length > limit + 1 && !all; // never hide just one row behind a "Show 1 more"
  const shown = cut ? rows.slice(0, limit) : rows;
  return <div>
    <div className="flex gap-3 pb-2 label"><span className="flex-1" /><span>Sessions</span><span className="w-12 text-right">Tokens</span></div>
    <ul className="space-y-2.5">{shown.map(g => (
      <li key={g.key} className="text-[13px] space-y-1.5">
        <div className="flex items-baseline gap-3"><span className="flex-1 truncate">{g.label}</span><span className="text-[12px] text-ash tabular-nums">{g.sessions.toLocaleString()}</span><span className="w-12 tabular-nums text-right">{fmtCount(g.tokens)}</span></div>
        <Bar f={g.tokens / (total || 1)} c="var(--color-chart)" />
      </li>
    ))}</ul>
    {rows.length > limit + 1 && <button onClick={() => setAll(!all)} className="press mt-3 text-[12px] text-dust hover:text-moon">{all ? 'Show fewer' : `Show ${rows.length - limit} more`}</button>}
  </div>;
}

function Threads({ r }: { r: UsageReport }) {
  const max = Math.max(1, ...r.threads.map(t => t.tokens));
  return <ul className="-mx-2">{r.threads.map(t => (
    <li key={t.threadId}><a href={`#/t/${t.threadId}`} className="press group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-2 py-2 hover:bg-ridge/55">
      <span className="min-w-0 space-y-1.5">
        <span className="flex items-baseline gap-3"><span className="flex-1 truncate text-[13.5px]">{t.title || 'Untitled thread'}</span><span className="text-[13px] tabular-nums">{fmtCount(t.tokens)}</span></span>
        <span className="flex items-center gap-3">
          <span className="flex-1 max-w-48"><Bar f={t.tokens / max} c="var(--color-chart)" /></span>
          <span className="ml-auto text-[11.5px] text-ash tabular-nums whitespace-nowrap truncate">{t.sessions} session{t.sessions === 1 ? '' : 's'} · {t.toolCalls.toLocaleString()} tools{t.costUsd != null ? ` · ~${fmtCost(t.costUsd)}` : ''}</span>
        </span>
      </span>
      <ChevronRight size={14} className="text-ash group-hover:text-dust" />
    </a></li>
  ))}</ul>;
}

export function UsageTab() {
  const [range, setRange] = useState<Range>(() => (localStorage.getItem('gibbous.usageRange') as Range) || '7');
  useEffect(() => { localStorage.setItem('gibbous.usageRange', range); }, [range]);
  const r = useUsage(range);
  const last = useRef<UsageReport>(undefined);
  if (r) last.current = r;
  const shown = r ?? (r === undefined ? last.current : undefined); // keep the old numbers while a new range loads
  const series = useMemo(() => shown ? seriesOf(shown.models) : [], [shown]);
  const data = useMemo(() => shown ? buckets(shown.daily, series) : [], [shown, series]);
  const labels = useMemo(() => Object.fromEntries(shown?.models.map(m => [m.id, m.label]) ?? []), [shown]);
  const others = shown ? shown.models.length - series.length : 0;
  return <>
    <div className="flex items-center gap-3">
      <p className="flex-1 text-[13px] text-dust"><span className="hidden sm:inline">Across every profile and source.</span></p>
      <Segmented label="Range" value={range} onChange={setRange} options={RANGES} />
    </div>
    {r === null ? <Empty title="Usage isn't available">The agent's session database couldn't be read.</Empty>
      : !shown ? <><Skeleton className="h-52 rounded-2xl" /><Skeleton className="h-60 rounded-2xl" /></>
      : !shown.totals.sessions ? <Empty title="No usage yet">Nothing ran in {RANGE_WORDS[range]}.</Empty>
      : <div className={`space-y-4 transition-opacity duration-200 ${r ? '' : 'opacity-60'}`}>
        <Card title="Account limits" aside="your logins' session and weekly windows"><LimitsCard /></Card>
        <Headline r={shown} />
        <Card title={data.length && data[0].day !== data[0].end ? 'Per week' : 'Per day'} aside={`peak ${fmtCount(Math.max(...data.map(d => d.tokens)))}`}>
          <Chart data={data} series={series} labels={labels} />
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-[12px] text-dust">
            {series.map((id, i) => <span key={id} className="inline-flex items-center gap-1.5"><Dot c={color(i)} />{labels[id]}</span>)}
            {others > 0 && <span className="inline-flex items-center gap-1.5"><Dot c={color(-1)} />{others} other{others === 1 ? '' : 's'}</span>}
          </div>
        </Card>
        <Card title="Models" aside={`${shown.models.length}`}><Models r={shown} series={series} /></Card>
        <div className="grid sm:grid-cols-2 gap-4">
          <Card title="Where it ran"><Groups rows={shown.sources} total={shown.totals.tokens} /></Card>
          <Card title="Profiles" aside={`${shown.profiles.length}`}><Groups rows={shown.profiles} total={shown.totals.tokens} /></Card>
        </div>
        {shown.threads.length > 0 && <Card title="Top threads" aside="incl. subagents"><Threads r={shown} /></Card>}
        <p className="text-[11.5px] text-ash px-1">Tokens are input plus output; cache reads are counted separately. API-equivalent cost is an estimate at API list prices. Subscription use (a ChatGPT/Codex login) is priced at the same list prices, at the base rate (long-prompt surcharges aren't known): that's what it would have cost on the API, not what you paid.</p>
      </div>}
  </>;
}
