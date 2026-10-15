// Subagents (delegate_task children) of a thread's Hermes session, read straight from state.db (read-only).
// Hermes stores each child as its own session tagged `model_config._delegate_from = <parent session id>`, so this sees
// every subagent, including background delegations and ones started before Gibbous was watching.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { hermesHome } from './platform.ts';

export interface SubagentRow {
  sessionId: string; parentSessionId: string; depth: number;
  goal: string; title?: string; model?: string; effort?: string;
  startedAt?: number; endedAt?: number; endReason?: string;
  lastActivityAt?: number; activity?: string;
  messages: number; toolCalls: number; tokens: number;
  lastText?: string;
}

const dbs = new Map<string, DatabaseSync>();
// Read-only handle on a profile's state.db (also used by kanban.ts to find worker sessions).
export function openStateDb(profile?: string): DatabaseSync | undefined {
  const home = hermesHome();
  const file = profile && profile !== 'default' ? path.join(home, 'profiles', profile, 'state.db') : path.join(home, 'state.db');
  if (!fs.existsSync(file)) return undefined;
  let db = dbs.get(file);
  if (!db) { db = new DatabaseSync(file, { readOnly: true }); db.exec('PRAGMA busy_timeout = 2000'); dbs.set(file, db); }
  return db;
}

// The thread's own session and its compaction continuations (not branches, not subagents), then every subagent
// delegated from any of them, recursively (subagents can delegate too).
const SQL = `
WITH RECURSIVE chain(id) AS (
  SELECT ?
  UNION
  SELECT s.id FROM sessions s JOIN chain c ON s.parent_session_id = c.id
  WHERE json_extract(s.model_config, '$._delegate_from') IS NULL AND json_extract(s.model_config, '$._branched_from') IS NULL
),
subs(id, parent, depth) AS (
  SELECT s.id, json_extract(s.model_config, '$._delegate_from'), 0 FROM sessions s
  WHERE json_extract(s.model_config, '$._delegate_from') IN (SELECT id FROM chain)
  UNION
  SELECT s.id, json_extract(s.model_config, '$._delegate_from'), d.depth + 1 FROM sessions s JOIN subs d
  ON json_extract(s.model_config, '$._delegate_from') = d.id
)
SELECT s.id, d.parent, d.depth, s.title, s.model, s.started_at, s.ended_at, s.end_reason, s.last_activity_at,
  s.last_activity_description, s.message_count, s.tool_call_count, COALESCE(s.input_tokens, 0) + COALESCE(s.output_tokens, 0) AS tokens,
  json_extract(s.model_config, '$.reasoning_config.effort') AS effort, json_extract(s.model_config, '$.reasoning_config.enabled') AS reasoning_on,
  (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS goal,
  (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'assistant' AND COALESCE(m.content, '') != '' ORDER BY m.id DESC LIMIT 1) AS last_text
FROM subs d JOIN sessions s ON s.id = d.id
ORDER BY s.started_at, s.id`;

const text = (v: unknown, n: number) => typeof v === 'string' ? v.trim().slice(0, n) : undefined;

export function listSubagents(sessionId: string, profile?: string): SubagentRow[] {
  const db = openStateDb(profile);
  if (!db) return [];
  return (db.prepare(SQL).all(sessionId) as any[]).map(r => ({
    sessionId: r.id, parentSessionId: r.parent, depth: r.depth,
    goal: text(r.goal, 600) || text(r.title, 200)?.replace(/^Subagent:\s*/, '') || 'Subagent',
    title: text(r.title, 200), model: r.model ?? undefined, effort: r.reasoning_on === 0 ? 'off' : text(r.effort, 20),
    startedAt: r.started_at ? r.started_at * 1000 : undefined, endedAt: r.ended_at ? r.ended_at * 1000 : undefined, endReason: r.end_reason ?? undefined,
    lastActivityAt: r.last_activity_at ? r.last_activity_at * 1000 : undefined, activity: text(r.last_activity_description, 160),
    messages: r.message_count ?? 0, toolCalls: r.tool_call_count ?? 0, tokens: r.tokens ?? 0,
    lastText: text(r.last_text, 400),
  }));
}

// Threads whose subagents are still working while the thread itself sits idle (delegate_task in the background):
// open children (no end, active in the last 5 minutes, like the card's QUIET_MS) walked up to a thread's session.
const LIVE_SQL = `SELECT id, json_extract(model_config, '$._delegate_from') AS up FROM sessions
  WHERE json_extract(model_config, '$._delegate_from') IS NOT NULL AND ended_at IS NULL
  AND COALESCE(last_activity_at, started_at) > ?`;
const UP_SQL = `SELECT COALESCE(json_extract(model_config, '$._delegate_from'), parent_session_id) AS up FROM sessions WHERE id = ?`;
export function busyThreads(threads: { id: string; sessionId: string; profile?: string; status: string; host?: string }[], now = Date.now()): string[] {
  const out = new Set<string>();
  const byProfile = new Map<string, typeof threads>();
  for (const t of threads) if (!t.host && t.status !== 'archived' && t.sessionId) (byProfile.get(t.profile ?? '') ?? byProfile.set(t.profile ?? '', []).get(t.profile ?? '')!).push(t);
  for (const [profile, ts] of byProfile) {
    let db: DatabaseSync | undefined;
    try { db = openStateDb(profile || undefined); } catch { continue; }
    if (!db) continue;
    const bySession = new Map(ts.map(t => [t.sessionId, t.id]));
    try {
      const up = db.prepare(UP_SQL);
      for (const r of db.prepare(LIVE_SQL).all((now - 5 * 60_000) / 1000) as { id: string; up: string | null }[]) {
        for (let cur: string | null = r.up, n = 0; cur && n < 32; n++) {
          const hit = bySession.get(cur);
          if (hit) { out.add(hit); break; }
          cur = (up.get(cur) as { up: string | null } | undefined)?.up ?? null;
        }
      }
    } catch { /* older db or locked: skip this profile */ }
  }
  return [...out].sort();
}
