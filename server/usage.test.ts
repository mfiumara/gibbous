import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computeUsage, loadRows, splitRows, costOf, modelLabel, modelId, parseDays, rangeStart } from './usage.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gib-usage-'));
const NOW = new Date(2030, 4, 15, 15, 0, 0).getTime(); // a fixed local afternoon
const at = (daysAgo: number, hour = 10) => { const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.getTime() / 1000; };

function makeDb(name: string, rows: Record<string, unknown>[]) {
  const file = path.join(dir, `${name}.db`);
  const w = new DatabaseSync(file);
  w.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, model_config TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, api_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0, billing_provider TEXT, estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT)`);
  const ins = w.prepare(`INSERT INTO sessions (id, source, model, model_config, parent_session_id, started_at, message_count, tool_call_count, api_call_count,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider, estimated_cost_usd, cost_status)
    VALUES (:id, :source, :model, :cfg, :parent, :started, :msgs, :tools, :api, :inp, :out, :cr, :cw, :rs, :prov, :est, :status)`);
  for (const r of rows) ins.run({ cfg: null, parent: null, msgs: 4, tools: 1, api: 2, inp: 0, out: 0, cr: 0, cw: 0, rs: 0, prov: null, est: null, status: null, ...r } as any);
  w.close();
  return new DatabaseSync(file, { readOnly: true });
}

const main = makeDb('main', [
  // A Gibbous thread, its compaction continuation, and a subagent it delegated.
  { id: 's1', source: 'desktop', model: 'claude-opus-5-5', started: at(0), inp: 1000, out: 200, cr: 3000, cw: 500, rs: 50, prov: 'anthropic', est: 1.5, status: 'estimated' },
  { id: 's1b', source: 'desktop', model: 'claude-opus-5-5', parent: 's1', started: at(0, 12), inp: 400, out: 100, prov: 'anthropic', est: 0.5, status: 'estimated' },
  { id: 'sub', source: 'subagent', model: 'claude-opus-5-5', parent: 's1', cfg: '{"_delegate_from": "s1"}', started: at(1), inp: 300, out: 100, prov: 'anthropic', est: 0.25, status: 'estimated' },
  // A subscription session: no API-equivalent price.
  { id: 'c1', source: 'cron', model: 'openai/gpt-5.6-sol', started: at(2), inp: 5000, out: 1000, prov: 'openai-codex', est: 0, status: 'included' },
  { id: 'd1', source: 'discord', model: 'gpt-5.6-sol', started: at(3), inp: 100, out: 10, prov: 'openai-codex', status: 'included' },
  // Out of a 7-day range, and an empty probe session that never counts.
  { id: 'old', source: 'cli', model: 'kimi-k3', started: at(20), inp: 7, out: 3 },
  { id: 'nil', source: 'acp', model: 'gpt-5.6-sol', started: at(0), msgs: 0 },
]);
const prof = makeDb('prof', [{ id: 'k1', source: 'kanban', model: 'gpt-5.6-sol', started: at(0), inp: 50, out: 50, prov: 'openai-codex' }]);
const dbs = loadRows([{ profile: 'default', db: main }, { profile: 'review', db: prof }]);
after(() => { main.close(); prof.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const threads = [{ id: 'T1', title: 'Fix login', sessionId: 's1' }];

test('totals, cost and cache hit rate over the range', () => {
  const r = computeUsage(dbs, threads, 7, NOW);
  assert.equal(r.totals.sessions, 6);
  assert.equal(r.totals.input, 1000 + 400 + 300 + 5000 + 100 + 50);
  assert.equal(r.totals.tokens, r.totals.input + r.totals.output);
  assert.equal(r.totals.reasoning, 50);
  assert.equal(r.totals.costUsd, 2.25);
  assert.equal(r.totals.pricedSessions, 3);
  assert.equal(r.totals.cacheHitRate, 3000 / (r.totals.input + 3000 + 500));
});

test('models merge vendor prefixes, keep providers, and omit cost when unpriced', () => {
  const r = computeUsage(dbs, threads, 7, NOW);
  assert.deepEqual(r.models.map(m => m.id), ['gpt-5.6-sol', 'claude-opus-5-5']);
  const gpt = r.models[0];
  assert.equal(gpt.label, 'GPT-5.6 Sol');
  assert.deepEqual(gpt.providers, ['openai-codex']);
  assert.equal(gpt.costUsd, null);
  assert.equal(r.models[1].label, 'Opus 5.5');
  assert.equal(r.models[1].costUsd, 2.25);
});

test('days are local, zero-filled and stacked by model', () => {
  const r = computeUsage(dbs, threads, 7, NOW);
  assert.equal(r.daily.length, 7);
  const today = r.daily.at(-1)!;
  assert.equal(today.byModel['claude-opus-5-5'], 1700);
  assert.equal(today.byModel['gpt-5.6-sol'], 100);
  assert.equal(r.daily[0].tokens, 0);
  assert.equal(r.daily.reduce((n, d) => n + d.tokens, 0), r.totals.tokens);
});

test('sources, profiles and threads (continuations and subagents roll up into the thread)', () => {
  const r = computeUsage(dbs, threads, 7, NOW);
  const src = Object.fromEntries(r.sources.map(s => [s.key, s.sessions]));
  assert.deepEqual(src, { threads: 2, subagents: 1, cron: 1, messaging: 1, kanban: 1 });
  assert.deepEqual(r.profiles.map(p => [p.key, p.sessions]), [['default', 5], ['review', 1]]);
  assert.equal(r.threads.length, 1);
  assert.equal(r.threads[0].threadId, 'T1');
  assert.equal(r.threads[0].sessions, 3);
  assert.equal(r.threads[0].tokens, 1200 + 500 + 400);
});

test('all time starts at the first session', () => {
  const r = computeUsage(dbs, threads, null, NOW);
  assert.equal(r.since, null);
  assert.equal(r.daily.length, 21);
  assert.equal(r.totals.sessions, 7);
});

test('labels and params', () => {
  assert.equal(modelLabel('claude-sonnet-4-6'), 'Sonnet 4.6');
  assert.equal(modelLabel('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(modelLabel('gpt-5.5'), 'GPT-5.5');
  assert.equal(modelLabel('kimi-k3'), 'Kimi K3');
  assert.equal(modelLabel(modelId('')), 'Unknown model');
  assert.equal(parseDays('all'), null);
  assert.equal(parseDays('30'), 30);
  assert.equal(parseDays('x'), 7);
  assert.equal(new Date(rangeStart(1, NOW)! * 1000).getHours(), 0);
});

test('splitRows: a long session that switched models lands per model, over the hours it was active', () => {
  const H = (d: number) => Math.floor(at(d) / 3600);
  const row: any = { id: 'long', source: 'discord', model: 'claude-opus-5-5', provider: 'anthropic', parent: null, delegated: 0, started: at(60), messages: 100, tools: 10, api: 50,
    input: 1100, output: 110, cacheRead: 0, cacheWrite: 0, reasoning: 0, est: 5, status: 'estimated' };
  const pieces: any[] = [
    { id: 'long', model: 'gpt-5.6-sol', provider: 'openai-codex', api: 40, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, est: 0, first: at(60), last: at(10) },
    { id: 'long', model: 'claude-opus-5-5', provider: 'anthropic', api: 10, input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, est: 5, first: at(2), last: at(1) },
  ];
  const out = splitRows([row], pieces, [{ id: 'long', hour: H(60), n: 3 }, { id: 'long', hour: H(10), n: 1 }, { id: 'long', hour: H(2), n: 1 }, { id: 'long', hour: H(1), n: 1 }]);
  const opusEarly = out.filter(r => r.model === 'claude-opus-5-5' && r.started < at(5));
  assert.equal(opusEarly.length, 0, 'no Opus before it was used');
  const gptAt60 = out.find(r => r.model === 'gpt-5.6-sol' && r.started === H(60) * 3600)!;
  assert.equal(Math.round(gptAt60.input), 750);   // 3 of the 4 active hours in its window
  const r = computeUsage([{ profile: 'default', rows: out, parents: new Map() }], [], null, NOW);
  assert.equal(r.totals.sessions, 1);
  assert.equal(r.totals.input, 1100);
  assert.equal(r.models.find(m => m.id === 'claude-opus-5-5')!.costUsd, 5);
  const week = computeUsage([{ profile: 'default', rows: out, parents: new Map() }], [], 7, NOW);
  assert.deepEqual(week.models.map(m => m.id), ['claude-opus-5-5']);
  assert.equal(week.totals.sessions, 1);
});

test('costOf: subscription use is priced at the API list price; API use keeps Hermes\' estimate; unknown models stay unpriced', () => {
  const table = new Map([['gpt-5.6-sol', { input: 5, output: 30, cacheRead: 0.5, cacheWrite: null }]]);
  const r: any = { model: 'openai/gpt-5.6-sol', provider: 'openai-codex', status: 'included', est: 0, input: 1e6, output: 1e5, cacheRead: 2e6, cacheWrite: 0 };
  assert.deepEqual(costOf(r, table), { usd: 5 + 3 + 1, included: true });
  assert.deepEqual(costOf({ ...r, provider: 'anthropic', status: 'estimated', est: 2 }, table), { usd: 2, included: false });
  assert.equal(costOf({ ...r, model: 'k3' }, table), null);
  assert.equal(costOf({ ...r, provider: 'anthropic', status: 'estimated', est: null }, table), null);
});
