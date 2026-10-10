// Model usage over time, read straight from Hermes' state.db (and every profile's own state.db), read-only.
// One cheap scan of the `sessions` table per database (a few thousand rows), aggregated in JS so days follow the
// server's local timezone. Results are cached for a minute per range.
import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStateDb } from './subagents.ts';
import { MESSAGING_SOURCES } from './sources.ts';

export interface UsageStats {
  sessions: number; apiCalls: number; toolCalls: number; messages: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number;
  tokens: number;          // input + output (fresh tokens; cache reads are reported separately)
  costUsd: number | null;  // API-equivalent estimate; null when Hermes priced none of these sessions
  pricedSessions: number;  // sessions that carry an estimate (subscriptions usually don't)
}
export interface UsageModel extends UsageStats { id: string; label: string; providers: string[] }
export interface UsageDay { day: string; tokens: number; costUsd: number | null; sessions: number; byModel: Record<string, number> }
export interface UsageGroup extends UsageStats { key: string; label: string }
export interface UsageThread extends UsageStats { threadId: string; title: string }
export interface UsageReport {
  days: number | null; since: number | null; generatedAt: number;
  totals: UsageStats & { cacheHitRate: number | null };
  models: UsageModel[]; daily: UsageDay[]; sources: UsageGroup[]; profiles: UsageGroup[]; threads: UsageThread[];
}
export interface UsageDb { profile: string; db: DatabaseSync }
export interface UsageThreadRef { id: string; title: string; sessionId: string }

const empty = (): UsageStats => ({ sessions: 0, apiCalls: 0, toolCalls: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, tokens: 0, costUsd: null, pricedSessions: 0 });

interface Row {
  id: string; source: string; model: string | null; provider: string | null; parent: string | null; delegated: number;
  started: number; messages: number; tools: number; api: number; input: number; output: number;
  cacheRead: number; cacheWrite: number; reasoning: number; est: number | null; status: string | null;
}

// Sessions that never did anything (most editor/ACP probes) are left out entirely.
const SQL = `SELECT id, source, model, billing_provider AS provider, parent_session_id AS parent,
  instr(COALESCE(model_config, ''), '"_delegate_from"') > 0 AS delegated, started_at AS started,
  COALESCE(message_count, 0) AS messages, COALESCE(tool_call_count, 0) AS tools, COALESCE(api_call_count, 0) AS api,
  COALESCE(input_tokens, 0) AS input, COALESCE(output_tokens, 0) AS output, COALESCE(cache_read_tokens, 0) AS cacheRead,
  COALESCE(cache_write_tokens, 0) AS cacheWrite, COALESCE(reasoning_tokens, 0) AS reasoning,
  estimated_cost_usd AS est, cost_status AS status
FROM sessions WHERE started_at >= ? AND (COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) > 0 OR COALESCE(message_count, 0) > 0)`;
const PARENTS = `SELECT id, parent_session_id AS parent FROM sessions WHERE parent_session_id IS NOT NULL`;

function add(s: UsageStats, r: Row) {
  s.sessions++; s.apiCalls += r.api; s.toolCalls += r.tools; s.messages += r.messages;
  s.input += r.input; s.output += r.output; s.cacheRead += r.cacheRead; s.cacheWrite += r.cacheWrite; s.reasoning += r.reasoning;
  s.tokens += r.input + r.output;
  const c = cost(r);
  if (c != null) { s.costUsd = (s.costUsd ?? 0) + c; s.pricedSessions++; }
}
// Only Hermes' own estimate counts. Subscriptions ("included", 0.0) have no API-equivalent price, so they're omitted.
const cost = (r: Row) => r.est != null && r.est > 0 && r.status !== 'included' ? r.est : null;

// "openai/gpt-5.6-sol" and "gpt-5.6-sol" are the same model.
export const modelId = (m?: string | null) => (m ?? '').trim().replace(/^[\w.-]+\//, '').toLowerCase() || 'unknown';
const cap = (w: string) => w ? w[0].toUpperCase() + w.slice(1) : w;
// claude-opus-5-5 → Opus 5.5, gpt-5.6-sol → GPT-5.6 Sol, kimi-k3 → Kimi K3.
export function modelLabel(id: string): string {
  if (id === 'unknown') return 'Unknown model';
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/.exec(id);
  if (claude) return `${cap(claude[1])} ${claude[2]}${claude[3] ? '.' + claude[3] : ''}`;
  const gpt = /^gpt-([\d.]+[a-z]?)(?:-(.+))?$/.exec(id);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].split('-').map(cap).join(' ') : ''}`;
  return id.split('-').map(w => /^[a-z]\d/.test(w) ? w.toUpperCase() : cap(w)).join(' ');
}

const SOURCE_GROUPS: Record<string, string> = { threads: 'Threads', subagents: 'Subagents', cron: 'Scheduled jobs', kanban: 'Kanban workers', messaging: 'Messaging', acp: 'Editors', cli: 'Terminal', desktop: 'Desktop app', oneshot: 'One-shot calls', other: 'Other' };
function sourceGroup(r: Row, inThread: boolean) {
  if (r.source === 'subagent' || r.delegated) return 'subagents';
  if (inThread) return 'threads';
  if (r.source === 'cron' || r.source === 'kanban' || r.source === 'acp' || r.source === 'desktop') return r.source;
  if (r.source === 'cli' || r.source === 'codex-cli') return 'cli';
  if (r.source === 'oneshot' || r.source === 'tool') return 'oneshot';
  if (MESSAGING_SOURCES.has(r.source)) return 'messaging';
  return 'other';
}

const dayKey = (t: number) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Start of the local day `days - 1` days ago, so "7 days" = today plus the six before it.
export function rangeStart(days: number | null, now = Date.now()): number | null {
  if (days == null) return null;
  const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1));
  return d.getTime() / 1000;
}

// One scan per database, shared by every range: the costly part is walking the rows (each carries its system prompt),
// so ranges are cut from this in memory.
export interface UsageRows { profile: string; rows: Row[]; parents: Map<string, string> }
export function loadRows(dbs: UsageDb[]): UsageRows[] {
  const out: UsageRows[] = [];
  for (const { profile, db } of dbs) {
    try {
      out.push({ profile, rows: db.prepare(SQL).all(0) as unknown as Row[], parents: new Map((db.prepare(PARENTS).all() as { id: string; parent: string }[]).map(r => [r.id, r.parent])) });
    } catch { /* a profile db mid-migration or locked: skip it rather than fail the page */ }
  }
  return out;
}

export function computeUsage(sets: UsageRows[], threads: UsageThreadRef[], days: number | null, now = Date.now()): UsageReport {
  const since = rangeStart(days, now);
  const totals = empty();
  const models = new Map<string, UsageModel>(), sources = new Map<string, UsageGroup>(), profiles = new Map<string, UsageGroup>();
  const perThread = new Map<string, UsageThread>(), daily = new Map<string, UsageDay>();
  const bySession = new Map(threads.filter(t => t.sessionId).map(t => [t.sessionId, t]));
  let first = Infinity;
  for (const { profile, rows, parents } of sets) {
    // A thread owns its session's compaction continuations and its subagents (both point up via parent_session_id).
    const owner = (id: string) => { for (let cur: string | undefined = id, n = 0; cur && n < 64; cur = parents.get(cur), n++) { const t = bySession.get(cur); if (t) return t; } };
    for (const r of rows) {
      if (since != null && r.started < since) continue;
      const thread = owner(r.id);
      add(totals, r);
      first = Math.min(first, r.started);
      const mid = modelId(r.model);
      let m = models.get(mid);
      if (!m) models.set(mid, m = { ...empty(), id: mid, label: modelLabel(mid), providers: [] });
      add(m, r);
      if (r.provider && !m.providers.includes(r.provider)) m.providers.push(r.provider);
      const sk = sourceGroup(r, !!thread);
      let s = sources.get(sk);
      if (!s) sources.set(sk, s = { ...empty(), key: sk, label: SOURCE_GROUPS[sk] });
      add(s, r);
      let p = profiles.get(profile);
      if (!p) profiles.set(profile, p = { ...empty(), key: profile, label: profile === 'default' ? 'Default' : profile });
      add(p, r);
      if (thread) {
        let t = perThread.get(thread.id);
        if (!t) perThread.set(thread.id, t = { ...empty(), threadId: thread.id, title: thread.title });
        add(t, r);
      }
      const dk = dayKey(r.started);
      let d = daily.get(dk);
      if (!d) daily.set(dk, d = { day: dk, tokens: 0, costUsd: null, sessions: 0, byModel: {} });
      d.tokens += r.input + r.output; d.sessions++;
      d.byModel[mid] = (d.byModel[mid] ?? 0) + r.input + r.output;
      const c = cost(r); if (c != null) d.costUsd = (d.costUsd ?? 0) + c;
    }
  }
  // Every day in the range, zero-filled, so quiet days read as quiet rather than missing.
  const days_: UsageDay[] = [];
  const start = since ?? (Number.isFinite(first) ? first : null);
  if (start != null) {
    const d = new Date(start * 1000); d.setHours(12, 0, 0, 0);
    const end = dayKey(now / 1000);
    for (let i = 0; i < 4000; i++) {
      const k = dayKey(d.getTime() / 1000);
      days_.push(daily.get(k) ?? { day: k, tokens: 0, costUsd: null, sessions: 0, byModel: {} });
      if (k >= end) break;
      d.setDate(d.getDate() + 1);
    }
  }
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  const byTokens = <T extends UsageStats>(a: T, b: T) => b.tokens - a.tokens || b.sessions - a.sessions;
  return {
    days, since: since == null ? null : since * 1000, generatedAt: now,
    totals: { ...totals, cacheHitRate: prompt ? totals.cacheRead / prompt : null },
    models: [...models.values()].filter(m => m.tokens > 0 || m.cacheRead > 0).sort(byTokens),
    daily: days_,
    sources: [...sources.values()].sort(byTokens),
    profiles: [...profiles.values()].sort(byTokens),
    threads: [...perThread.values()].sort(byTokens).slice(0, 8),
  };
}

// Every state.db Hermes keeps: the default one and one per profile.
export function usageDbs(): UsageDb[] {
  const home = process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes');
  const out: UsageDb[] = [];
  const main = openStateDb();
  if (main) out.push({ profile: 'default', db: main });
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(home, 'profiles')); } catch {}
  for (const n of names.sort()) {
    if (n === 'default' || n.startsWith('.')) continue;
    try { const db = openStateDb(n); if (db) out.push({ profile: n, db }); } catch {}
  }
  return out;
}

export const parseDays = (v: string | null): number | null => {
  if (v === 'all') return null;
  const n = Number(v ?? 7);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : 7;
};

// Rows are re-read at most once a minute; each range is then a few ms of arithmetic (also cached for that minute).
let loaded: { at: number; sets: UsageRows[] } | undefined;
const cache = new Map<string, UsageReport>();
export function usage(days: number | null, threads: UsageThreadRef[], ttlMs = 60_000): UsageReport {
  const now = Date.now();
  if (!loaded || now - loaded.at >= ttlMs) { loaded = { at: now, sets: loadRows(usageDbs()) }; cache.clear(); }
  const key = String(days);
  let report = cache.get(key);
  if (!report) cache.set(key, report = computeUsage(loaded.sets, threads, days, now));
  return report;
}
