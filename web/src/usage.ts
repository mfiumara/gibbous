// Usage for Settings → Usage and the new-thread glance: pure shaping and formatting (fetching is in useUsage.ts).
import type { UsageCell, UsageReport, UsageDay } from '../../server/usage.ts';

export type { UsageReport, UsageDay };
export type Range = '7' | '30' | '90' | 'all';

// 4.2M, 812k, 1.25B: short enough for a headline, never more than three significant digits.
export function fmtCount(n: number): string {
  const a = Math.abs(n);
  const f = (v: number, u: string) => `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, '')}${u}`;
  return a >= 1e9 ? f(n / 1e9, 'B') : a >= 1e6 ? f(n / 1e6, 'M') : a >= 1e3 ? f(n / 1e3, 'k') : String(Math.round(n));
}
export const fmtCost = (n: number) => n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(2)}` : '$0';
export const fmtPct = (f: number) => f >= 0.995 ? '100%' : f < 0.005 && f > 0 ? '<1%' : `${Math.round(f * 100)}%`;

// Per-model series for the stacked chart: the top `n` models by tokens keep their own colour, the rest share "other".
export function seriesOf(models: { id: string; tokens: number }[], n = 5): string[] {
  return models.filter(m => m.tokens > 0).slice(0, n).map(m => m.id);
}

export interface Bucket { day: string; end: string; tokens: number; costUsd: number | null; sessions: number; parts: Record<string, number> }
// Days stacked by series (others folded into 'other'); long ranges fold into weeks so bars stay readable.
export function buckets(daily: UsageDay[], series: string[], maxBars = 100): Bucket[] {
  const keep = new Set(series), step = daily.length > maxBars ? 7 : 1, out: Bucket[] = [];
  for (let i = 0; i < daily.length; i += step) {
    const chunk = daily.slice(i, i + step), parts: Record<string, number> = {};
    let cost: number | null = null;
    for (const d of chunk) {
      for (const [m, v] of Object.entries(d.byModel)) { const k = keep.has(m) ? m : 'other'; parts[k] = (parts[k] ?? 0) + v; }
      if (d.costUsd != null) cost = (cost ?? 0) + d.costUsd;
    }
    out.push({ day: chunk[0].day, end: chunk.at(-1)!.day, tokens: chunk.reduce((n, d) => n + d.tokens, 0), costUsd: cost, sessions: chunk.reduce((n, d) => n + d.sessions, 0), parts });
  }
  return out;
}

// A round axis maximum (1, 2, 2.5, 5 × 10^k) at or above v.
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find(m => m * p >= v) ?? 10) * p;
}

// The one quiet line on the new-thread screen as its parts (tokens, top model, cost), or null when there's nothing
// worth saying. The caller joins them with " · " and may drop the model on narrow screens.
export function glance(r: UsageReport | null | undefined): { tokens: string; model?: string; cost?: string } | null {
  if (!r || r.totals.tokens <= 0) return null;
  const top = r.models[0];
  return {
    tokens: `This week: ${fmtCount(r.totals.tokens)} tokens`,
    model: top && top.tokens > 0 ? `${top.tokens / r.totals.tokens >= 0.5 ? 'mostly' : 'led by'} ${top.label}` : undefined,
    cost: r.totals.costUsd != null && r.totals.costUsd >= 0.01 ? `~${fmtCost(r.totals.costUsd)} API-equivalent` : undefined,
  };
}

// Breakdown: the report's cells grouped by one dimension, each row split by another, after filters.
export type Dim = 'project' | 'model' | 'source' | 'profile';
export type Metric = 'tokens' | 'cost';
export interface BreakRow { key: string; total: number; sessions: number; parts: { key: string; value: number }[] }
export function breakdown(cells: UsageCell[], group: Dim, split: Dim | null, filters: Partial<Record<Dim, string>>, metric: Metric): BreakRow[] {
  const rows = new Map<string, BreakRow & { m: Map<string, number> }>();
  for (const c of cells) {
    if (Object.entries(filters).some(([d, v]) => v != null && c[d as Dim] !== v)) continue;
    const v = metric === 'cost' ? c.costUsd : c.tokens;
    if (!v) continue;
    const k = c[group];
    let r = rows.get(k);
    if (!r) rows.set(k, r = { key: k, total: 0, sessions: 0, parts: [], m: new Map() });
    r.total += v; r.sessions += c.sessions;
    const sk = split ? c[split] : '';
    r.m.set(sk, (r.m.get(sk) ?? 0) + v);
  }
  return [...rows.values()].map(({ m, ...r }) => ({ ...r, parts: [...m].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value) }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}
/** The split values that get their own colour (largest overall first); the rest share "other". */
export function splitSeries(rows: BreakRow[], n = 6): string[] {
  const t = new Map<string, number>();
  for (const r of rows) for (const p of r.parts) t.set(p.key, (t.get(p.key) ?? 0) + p.value);
  return [...t].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}
