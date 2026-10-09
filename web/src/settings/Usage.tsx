// Usage & cost over time. Single-series marks in the validated chart token; text stays in text tokens.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import { hermes } from '../api';
import { toastError } from '../store';
import { Segmented, Skeleton, IconButton, fmtTokens, fmtUsd } from '../ui';
import { Section } from './common';

interface Day { day: string; input_tokens: number; output_tokens: number; estimated_cost: number; actual_cost: number; sessions: number; api_calls: number }
interface Usage { daily: Day[]; by_model: { model: string; input_tokens: number; output_tokens: number; estimated_cost: number; sessions: number }[]; totals: { total_input: number; total_output: number; total_cache_read: number; total_estimated_cost: number; total_actual_cost: number; total_sessions: number; total_api_calls: number }; tools: { tool: string; count: number }[] }
type Metric = 'cost' | 'tokens';

const val = (d: Day, m: Metric) => m === 'cost' ? (d.actual_cost || d.estimated_cost) : d.input_tokens + d.output_tokens;
const fmt = (v: number, m: Metric) => m === 'cost' ? fmtUsd(v) : fmtTokens(v);

// Every day in the period, zero-filled, so gaps read as quiet days rather than missing bars.
function fillDays(daily: Day[], days: number): Day[] {
  const byDay = new Map(daily.map(d => [d.day, d]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (days - 1 - i));
    const key = d.toLocaleDateString('en-CA');
    return byDay.get(key) ?? { day: key, input_tokens: 0, output_tokens: 0, estimated_cost: 0, actual_cost: 0, sessions: 0, api_calls: 0 };
  });
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="surface rounded-2xl px-4 py-3.5"><p className="label">{label}</p><p className="text-[26px] font-bold tracking-[-.02em] leading-tight mt-1 tabular-nums">{value}</p>{sub && <p className="text-[12px] text-dust">{sub}</p>}</div>;
}

function DailyBars({ days, metric }: { days: Day[]; metric: Metric }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real width, so labels stay 10.5px on a phone instead of shrinking with the SVG.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => { const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width)))); ro.observe(box.current!); return () => ro.disconnect(); }, []);
  const H = 200, PAD = { l: 44, r: 8, t: 10, b: 24 };
  const max = Math.max(...days.map(d => val(d, metric)), metric === 'cost' ? 1 : 1000);
  const ticks = [0, max / 2, max];
  const bw = (W - PAD.l - PAD.r) / days.length;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const h = hover != null ? days[hover] : null;
  return (
    <div ref={box} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Daily ${metric} for the last ${days.length} days`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => <g key={i}><line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} strokeDasharray={i ? '2 4' : undefined} /><text x={PAD.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10.5} fill="var(--color-ash)">{fmt(t, metric)}</text></g>)}
        {days.map((d, i) => {
          const v = val(d, metric), x = PAD.l + i * bw, top = y(v), bh = H - PAD.b - top;
          return <g key={d.day} onMouseEnter={() => setHover(i)}>
            {/* Hit target spans the full column, wider than the bar. */}
            <rect x={x} y={PAD.t} width={bw} height={H - PAD.t - PAD.b} fill="transparent" />
            {bh > 0 && <path d={`M${x + 1},${H - PAD.b} V${top + 4} q0,-4 4,-4 h${Math.max(0, bw - 10)} q4,0 4,4 V${H - PAD.b} Z`} fill="var(--color-chart)" opacity={hover == null || hover === i ? 1 : 0.45} className="transition-opacity" />}
          </g>;
        })}
        {days.map((d, i) => (i % Math.ceil(days.length / Math.max(2, Math.floor(W / 90))) === 0) && <text key={d.day} x={PAD.l + i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize={10.5} fill="var(--color-ash)">{new Date(d.day + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text>)}
      </svg>
      {h && <div className="pop pointer-events-none absolute top-0 rounded-lg px-3 py-2 text-[12px] [--origin:bottom]" style={{ left: `${((PAD.l + (hover! + 0.5) * bw) / W) * 100}%`, transform: `translateX(${hover! > days.length / 2 ? '-105%' : '5%'})` }}>
        <p className="font-bold">{new Date(h.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
        <p className="text-dust">{fmtUsd(h.actual_cost || h.estimated_cost)} · {fmtTokens(h.input_tokens + h.output_tokens)} tokens</p>
        <p className="text-dust">{h.sessions} sessions · {h.api_calls} model calls</p>
      </div>}
    </div>
  );
}

function HBars({ rows }: { rows: { label: string; value: number; text: string }[] }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return <ul className="space-y-2">{rows.map(r => (
    <li key={r.label} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-[13px]">
      <span className="font-mono truncate text-moon/90" data-tip={r.label}>{r.label}</span>
      <span className="block h-2.5 rounded-r-[4px] bg-ridge overflow-hidden"><span className="block h-full rounded-r-[4px] bg-chart transition-[width] duration-700" style={{ width: `${(r.value / max) * 100}%` }} /></span>
      <span className="text-dust tabular-nums text-right w-16">{r.text}</span>
    </li>
  ))}</ul>;
}

export function UsageTab() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [metric, setMetric] = useState<Metric>('cost');
  const [table, setTable] = useState(false);
  const [u, setU] = useState<Usage>();
  useEffect(() => { setU(undefined); hermes.get<Usage>(`analytics/usage?days=${days}`).then(setU, toastError); }, [days]);
  const filled = useMemo(() => u ? fillDays(u.daily, Number(days)) : [], [u, days]);
  if (!u) return <Skeleton className="h-96 rounded-2xl" />;
  const t = u.totals;
  const cost = t.total_actual_cost || t.total_estimated_cost;
  const models = [...u.by_model].map(m => ({ label: m.model, value: metric === 'cost' ? m.estimated_cost : m.input_tokens + m.output_tokens, text: metric === 'cost' ? fmtUsd(m.estimated_cost) : fmtTokens(m.input_tokens + m.output_tokens) })).filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label="Period" value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      <Segmented label="Measure" value={metric} onChange={setMetric} options={[{ value: 'cost', label: 'Spend' }, { value: 'tokens', label: 'Tokens' }]} />
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Tile label="Spend" value={fmtUsd(cost)} sub={t.total_actual_cost ? 'billed' : 'estimated at list prices'} />
      <Tile label="Tokens" value={fmtTokens(t.total_input + t.total_output)} sub={`${fmtTokens(t.total_cache_read)} from cache`} />
      <Tile label="Sessions" value={String(t.total_sessions)} />
      <Tile label="Model calls" value={t.total_api_calls.toLocaleString()} />
    </div>
    <Section title={`Daily ${metric === 'cost' ? 'spend' : 'tokens'}`} aside={<IconButton label={table ? 'Show chart' : 'Show as table'} onClick={() => setTable(!table)}>{table ? <BarChart3 size={15} /> : <Table2 size={15} />}</IconButton>}>
      {table ? <div className="max-h-80 overflow-y-auto"><table className="w-full text-[13px]"><thead><tr className="text-left text-dust"><th className="py-1 font-normal">Day</th><th className="font-normal text-right">Spend</th><th className="font-normal text-right">Tokens</th><th className="font-normal text-right">Sessions</th></tr></thead>
        <tbody>{[...filled].reverse().map(d => <tr key={d.day} className="border-t border-line"><td className="py-1">{d.day}</td><td className="text-right tabular-nums">{fmtUsd(d.actual_cost || d.estimated_cost)}</td><td className="text-right tabular-nums">{fmtTokens(d.input_tokens + d.output_tokens)}</td><td className="text-right tabular-nums">{d.sessions}</td></tr>)}</tbody></table></div>
        : <DailyBars days={filled} metric={metric} />}
    </Section>
    <div className="grid lg:grid-cols-2 gap-4">
      <Section title={`By model · ${metric === 'cost' ? 'spend' : 'tokens'}`}>{models.length ? <HBars rows={models} /> : <p className="text-sm text-dust">No usage in this period.</p>}</Section>
      <Section title="Most used tools"><HBars rows={u.tools.slice(0, 8).map(x => ({ label: x.tool, value: x.count, text: x.count.toLocaleString() }))} /></Section>
    </div>
  </>;
}
