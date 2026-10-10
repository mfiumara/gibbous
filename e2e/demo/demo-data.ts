// Fictional demo data beyond the live turns: sessions from other surfaces (agent CLI, Discord, an editor over ACP),
// Claude Code / Codex logs for the import screen, a Hermes kanban board, and the read-only state.db rows Gibbous reads
// for folders and kanban worker sessions. Everything is about the made-up `tidepool` library; no real people.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Preload, ForeignRow, KanbanData } from './fake-hermes.ts';

const H = 3600, D = 86400;

export function demoData(home: string, repos: { tide: string; docs: string }) {
  const t0 = Date.now() / 1000;
  const tide = repos.tide;

  // ── Hermes sessions from other surfaces ──
  const sessions: Preload[] = [
    { title: 'Profile the Redis store under load', source: 'cli', cwd: tide, startedAt: t0 - 3 * H, rows: [
      { role: 'user', text: 'Profile RedisStore under 2k rps with three app instances and tell me where the latency comes from.' },
      { role: 'assistant', text: 'Most of the p99 is the second round trip: `get` then `set`. A single EVALSHA would cut it roughly in half. I put the flame graph in `bench/out/redis.svg`.' },
      { role: 'user', text: 'Make that a kanban task for the builder profile.' },
      { role: 'assistant', text: 'Created **Redis store: Lua script for atomic refill** on the tidepool board, assigned to `builder`.' }] },
    { title: 'Migration note for 0.9 → 1.0', source: 'cli', cwd: tide, startedAt: t0 - 26 * H, rows: [
      { role: 'user', text: 'Draft a short migration note from 0.9 to 1.0. The only breaking change is the Store interface.' },
      { role: 'assistant', text: 'Drafted `docs/migrating-to-1.0.md`: `Store.set` now takes the TTL in milliseconds, with a before/after example.' }] },
    { title: 'Tidy the CI matrix', source: 'cli', cwd: tide, startedAt: t0 - 2 * D - 4 * H, rows: [
      { role: 'user', text: 'The CI matrix runs Node 18, 20 and 22 on three OSes. Trim it to what matters.' },
      { role: 'assistant', text: 'Node 20 and 22 on Linux, plus Node 22 on macOS and Windows. Five jobs instead of nine.' }] },
    { title: '#help · token bucket across workers', source: 'discord', startedAt: t0 - 5 * H, rows: [
      { role: 'user', text: 'is the token bucket safe if I run it in 4 cluster workers?' },
      { role: 'assistant', text: 'Not with the in-memory store: each worker keeps its own buckets, so you get 4× the limit. Use `RedisStore` and all workers share one bucket per key.' },
      { role: 'user', text: 'ah that explains it. thanks!' }] },
    { title: '#releases · 1.0 timing', source: 'discord', startedAt: t0 - 30 * H, rows: [
      { role: 'user', text: 'any eta for 1.0?' },
      { role: 'assistant', text: 'Three cards left on the board: the Lua refill script, the API reference and the publish workflow. Once those land, 1.0 ships.' }] },
    { title: 'Refactor MemoryStore expiry', source: 'acp', cwd: tide, startedAt: t0 - 9 * H, rows: [
      { role: 'user', text: 'Refactor MemoryStore so expiry is checked lazily on read instead of with a timer per key.' },
      { role: 'assistant', text: 'Done: expired entries are dropped on `get`, plus a sweep every 1000 writes. No timers left.' }] },
  ];

  // The kanban worker's own session (source 'kanban', the assignee's profile), so a card can open it.
  const workerId = '20261010_081500_b7e2c1';
  const leadStart = t0 - 7 * 60;
  sessions.push({ id: workerId, title: 'Redis store: Lua script for atomic refill', source: 'kanban', profile: 'builder', cwd: tide, startedAt: leadStart, rows: [
    { role: 'user', text: 'Kanban task t_8e02: Redis store: use a Lua script for atomic refill and take, so two instances never race on the same bucket.' },
    { role: 'assistant', text: 'Reading `src/stores/redis.ts` and the token bucket\'s refill maths first.' },
    { role: 'assistant', text: 'The script does GET, refill, take and PEXPIRE in one EVALSHA. Writing a race test with two clients next.' }] });

  // ── Claude Code and Codex logs (files on disk, so /api/sessions/origins can tell the apps apart) ──
  const foreign: ForeignRow[] = [];
  const claudeDir = path.join(home, '.claude', 'projects', tide.replace(/[/.]/g, '-'));
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '10');
  const addClaude = (uuid: string, title: string, ago: number, turns: [string, string][]) => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const f = path.join(claudeDir, `${uuid}.jsonl`);
    fs.writeFileSync(f, turns.flatMap(([u, a]) => [
      JSON.stringify({ type: 'user', entrypoint: 'cli', cwd: tide, sessionId: uuid, message: { role: 'user', content: u } }),
      JSON.stringify({ type: 'assistant', entrypoint: 'cli', cwd: tide, sessionId: uuid, message: { role: 'assistant', content: [{ type: 'text', text: a }] } })]).join('\n') + '\n');
    const real = fs.realpathSync(f);
    foreign.push({ id: crypto.createHash('sha256').update(`claude:${real}`).digest('hex'), source: 'claude', label: title, title, cwd: tide, mtime: t0 - ago,
      turn_count: turns.length * 2, excerpt: turns[0][0], turns: turns.flatMap(([u, a]) => [{ role: 'user', text: u }, { role: 'assistant', text: a }]) });
  };
  const addCodex = (day: string, uuid: string, originator: string, title: string, ago: number, turns: [string, string][]) => {
    const dir = path.join(codexDir, day); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `rollout-2026-10-${day}T09-12-44-${uuid}.jsonl`);
    fs.writeFileSync(f, [JSON.stringify({ type: 'session_meta', payload: { id: uuid, originator, cwd: tide, source: 'cli' } }),
      ...turns.flatMap(([u, a]) => [JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: u }] } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: a }] } })])].join('\n') + '\n');
    const real = fs.realpathSync(f);
    foreign.push({ id: crypto.createHash('sha256').update(`codex:${real}`).digest('hex'), source: 'codex', label: title, title, cwd: tide, mtime: t0 - ago,
      turn_count: turns.length * 2, excerpt: turns[0][0], turns: turns.flatMap(([u, a]) => [{ role: 'user', text: u }, { role: 'assistant', text: a }]) });
  };
  addClaude('0f3c2a71-5d2e-4c1b-9a8e-6b1d2f3a4c50', 'Explain the sliding log trade-off', 50 * 60, [
    ['When would a sliding log beat a sliding-window counter for tidepool?', 'Only for small limits where you need exact answers: a log stores one timestamp per hit, so memory grows with the limit. For anything above a few hundred hits per window the counter is the better default.'],
    ['Write that down as a short note for the docs.', 'Added a "Choosing a limiter" note to `docs/limiters.md` with a small table: token bucket, sliding window, sliding log. [ran tool: write_file]']]);
  addClaude('7a9e4b12-0c6d-4f2a-8b3e-1d5c7e9f0a21', 'Fix the ESLint flat config', 20 * H, [
    ['ESLint 9 fails on our old .eslintrc. Move us to the flat config.', 'Moved to `eslint.config.js` with typescript-eslint\'s recommended preset. `pnpm lint` passes. [ran tool: terminal]']]);
  addClaude('c41d8e2f-9b7a-4e6c-a3d1-5f2b8c0e7d94', 'Add a Deno test task', 3 * D, [
    ['Add a deno.json with a test task so we can try the suite under Deno.', 'Added `deno.json` with a `test` task that maps the vitest imports. Two tests fail on `process.hrtime`; I left them for the Deno card on the board.']]);
  addCodex('09', '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b', 'codex-tui', 'Port the CLI to citty', 4 * H, [
    ['Port src/cli.ts from hand-rolled argv parsing to citty.', 'Ported: `simulate` and `inspect` are citty commands now, `--json` and `--rps` keep their names. [ran tool: apply_patch]']]);
  addCodex('08', '019a1f2e-3d4c-7b5a-9e8f-7a6b5c4d3e2f', 'Codex Desktop', 'Draft the 0.9 changelog', 2 * D, [
    ['Draft CHANGELOG entries for 0.9 from the git log since 0.8.', 'Drafted 0.9: sliding-window limiter, Retry-After headers, RedisStore TTL fix, and the Node 18 deprecation notice.']]);

  // ── the project's Hermes kanban board ──
  const m = (min: number) => t0 - min * 60;
  const kanban: KanbanData = {
    board: { slug: 'tidepool', name: 'tidepool', description: 'Road to 1.0', icon: '', color: '', default_workdir: tide },
    assignees: ['builder', 'writer', 'reviewer'],
    tasks: [
      { id: 't_e6a0', title: 'Rate limits per API key tier', status: 'triage', created_at: m(90), created_by: 'maintainer' },
      { id: 't_c4e6', title: 'Release 1.0', status: 'todo', priority: 2, created_at: m(3 * 1440), parents: ['t_8e02', 't_9b47', 't_a1c3', 't_d5f1'], body: 'Changelog, version bump and the migration note from 0.9.' },
      { id: 't_b2d8', title: 'Deno compatibility', status: 'todo', created_at: m(2 * 1440), parents: ['t_7d14'], assignee: 'builder' },
      { id: 't_a1c3', title: 'Publish workflow with npm provenance', status: 'ready', assignee: 'builder', priority: 1, created_at: m(2 * 1440), parents: ['t_7d14'] },
      { id: 't_8e02', title: 'Redis store: Lua script for atomic refill', status: 'running', assignee: 'builder', priority: 1, created_at: m(3 * 60), started_at: leadStart, current_run_started_at: leadStart,
        branch_name: 'kanban/t_8e02-redis-lua', created_by: 'maintainer', parents: ['t_5c20'],
        body: 'Refill and take happen in two round trips today, so two app instances can both take the last token.\n\nDo it in one Lua script (EVALSHA), keep the Store interface unchanged, and add a race test with two clients.',
        latest_summary: 'Script written; adding the two-client race test.',
        comments: [
          { author: 'maintainer', body: 'Keep the script under 30 lines; we load it with SCRIPT LOAD at connect.', at: m(150) },
          { author: 'builder', body: 'Will do. The race test uses two clients on the same key with a 1-token bucket.', at: m(6) }],
        events: [{ kind: 'created', payload: { by: 'maintainer' }, at: m(180) }, { kind: 'assigned', payload: { assignee: 'builder' }, at: m(179) },
          { kind: 'promoted', payload: { status: 'ready' }, at: m(12) }, { kind: 'claimed', payload: { profile: 'builder' }, at: m(7.2) }],
        runs: [{ id: 1, profile: 'builder', status: 'running', outcome: null, summary: null, started_at: leadStart, ended_at: null }] },
      { id: 't_9b47', title: 'Docs: API reference', status: 'running', assignee: 'writer', created_at: m(2 * 1440), started_at: m(3), current_run_started_at: m(3), latest_summary: 'Both limiters documented; the Decision type is next.' },
      { id: 't_d5f1', title: 'Drop Node 18', status: 'blocked', block_kind: 'human', created_at: m(1440), latest_summary: 'Waiting on a decision: drop it in 1.0 or in 1.1?' },
      { id: 't_7d14', title: 'Edge runtime build: ESM + CJS', status: 'review', assignee: 'builder', created_at: m(2 * 1440), completed_at: null, latest_summary: 'tsup builds ESM and CJS; exports map lists both.', branch_name: 'kanban/t_7d14-edge-build' },
      { id: 't_5c20', title: 'Benchmark suite in CI', status: 'done', assignee: 'builder', created_at: m(5 * 1440), completed_at: m(2 * 1440), latest_summary: 'Fails a PR on a >10% regression.' },
      { id: 't_3a91', title: 'Expose a limiter metrics hook', status: 'done', assignee: 'builder', created_at: m(6 * 1440), completed_at: m(3 * 1440), latest_summary: 'onDecision hook for allow/deny counts.' },
    ],
  };

  return { sessions, foreign, kanban, workerId };
}

// Hermes' state.db, read-only to Gibbous: the folder each session ran in (Sessions groups by project) and the kanban
// worker's session in the assignee's profile. Only the columns Gibbous reads.
export function writeStateDb(hermesHome: string, sessions: Preload[], stored: Map<Preload, string>) {
  const SCHEMA = `CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, model_config TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
    ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cwd TEXT, title TEXT, git_repo_root TEXT, last_activity_at REAL, last_activity_description TEXT, billing_provider TEXT, api_call_count INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, estimated_cost_usd REAL, cost_status TEXT);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);`;
  const open = (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new DatabaseSync(file); db.exec(SCHEMA); return db; };
  const dbs = new Map<string, DatabaseSync>();
  for (const s of sessions) {
    const prof = s.profile ?? 'default';
    const file = prof === 'default' ? path.join(hermesHome, 'state.db') : path.join(hermesHome, 'profiles', prof, 'state.db');
    if (!dbs.has(file)) dbs.set(file, open(file));
    dbs.get(file)!.prepare('INSERT INTO sessions (id, source, model, started_at, message_count, cwd, title, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(stored.get(s)!, s.source, 'claude-sonnet-4-5', s.startedAt, s.rows.length, s.cwd ?? null, s.title, s.startedAt + s.rows.length * 40);
  }
  if (!dbs.size) dbs.set(path.join(hermesHome, 'state.db'), open(path.join(hermesHome, 'state.db')));
  // A month of past usage (Settings → Usage, the Home glance): token counts and API-equivalent cost per session.
  const main = dbs.get(path.join(hermesHome, 'state.db'))!;
  const ins = main.prepare(`INSERT INTO sessions (id, source, model, billing_provider, started_at, message_count, tool_call_count, api_call_count, input_tokens, output_tokens,
    cache_read_tokens, reasoning_tokens, estimated_cost_usd, cost_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const models: [string, string, number, number][] = [['claude-sonnet-4-5', 'anthropic', 3, 15], ['claude-haiku-4-5', 'anthropic', 1, 5], ['gpt-5', 'openai', 1.25, 10]];
  const now = Date.now() / 1000;
  for (let i = 0; i < 90; i++) {
    const k = (i * 37) % 23, [model, provider, pin, pout] = models[i % 7 === 3 ? 2 : i % 4 === 1 ? 1 : 0];
    const input = 60_000 + k * 9_000, output = 6_000 + k * 700, cache = input * 4, tools = 6 + (k % 15);
    ins.run(`20260${9 + Math.floor(i / 60)}${String(10 + (i % 18)).padStart(2, '0')}_usage_${i}`, ['cli', 'desktop', 'desktop', 'discord', 'cli'][i % 5], model, provider,
      now - (i / 3) * 86400 - k * 600, 8 + (k % 12), tools, tools + 3, input, output, cache, Math.round(output * 0.4), +((input * pin + output * pout + cache * pin * 0.1) / 1e6).toFixed(4), 'estimated');
  }
  for (const db of dbs.values()) db.close();
}
