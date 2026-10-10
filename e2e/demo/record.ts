// Records the demo instance for the hosted demo (demo.gibbousapp.com, e2e/demo/worker): every GET the web app makes
// on the main screens, the JSON-RPC answers on /ws, and the event stream of one scripted turn (prompt → reasoning,
// tools, inline diffs → approval → reply). Output: e2e/demo/worker/fixtures.json, with demo paths neutralised and no
// tokens. Usage: node e2e/demo/record.ts   (then: cd e2e/demo/worker && npm run deploy)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Page, type CDPSession } from 'puppeteer-core';
import { start, CHROME, BASE, PORT, DEMO, SCRATCH, sleep, type Env } from './lib.ts';
import { WebSocket } from '../../server/node_modules/ws/wrapper.mjs';
import { seed, threadStatus } from './seed.ts';
import { DEMO_PROMPT } from './scripts.ts';

if (!process.argv.includes('--resnapshot')) process.argv.push('--resnapshot'); // always record the current build
const OUT_FILE = path.join(import.meta.dirname, 'worker/fixtures.json');
const NEUTRAL_HOME = '/Users/demo';

type Frame = { t: number; sock: string; dir: 'in' | 'out'; m: any };
const http = new Map<string, { status: number; type: string; body: string }>();
const frames: Frame[] = [];
const rpcs: { method: string; params: any; result?: any; error?: any }[] = [];

const env = await start();
let call: (method: string, params: any) => Promise<any> = async () => { throw new Error('rpc not open'); };
let closeRpc = () => {};
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: null, args: ['--disable-features=Translate', '--hide-scrollbars'] });
try {
  console.log('seeding…');
  const s = await seed(env);
  // The demo shows finished work plus one thread waiting for approval; nothing spins forever.
  env.fake.release('flaky-forever');
  await threadStatus(env, s.threads.flaky, 'idle');

  ({ call, close: closeRpc } = await openRpc(env));
  const { page } = await openPage(env);
  const go = async (hash: string, settle = 1200) => {
    await page.evaluate(h => { location.hash = h; }, hash); await sleep(settle);
    const errs = (page as any).demoErrors as string[];
    if (errs.length) console.log(`  ! ${hash}: ${errs.splice(0).join(' | ').slice(0, 300)}`);
  };

  // ── 1. browse: every screen the visitor can reach ──
  const st = await env.api<any>('GET', '/api/state');
  console.log('browsing…');
  await go('#/', 1500);
  for (const t of st.threads.filter((t: any) => t.status !== 'archived')) await go(`#/t/${t.id}`, 1500);
  for (const h of ['#/inbox', '#/sessions', '#/automations', '#/rooms', '#/kanban', `#/board/${s.tide.id}`, `#/board/${s.docs.id}`, '#/search?q=limiter', '#/new', `#/new/${s.docs.id}`]) await go(h, 1500);
  for (const tool of ['gibbous', 'cli', 'desktop', 'acp', 'messaging', 'api', 'other', 'claude', 'codex', 'opencode']) await go(`#/sessions/${tool}`, 1200);
  for (const sec of ['general', 'appearance', 'notifications', 'phone', 'maintenance', 'usage', 'profiles', 'skills', 'mcp', 'jobs', 'platforms', 'memory', 'vault', 'config', 'hosts', 'update']) await go(`#/settings/${sec}`, 1200);
  await go('#/settings', 1000);
  // What panels and cards load on demand: fetch them the way the app does.
  const extra = async (p: string) => { try { const r = await fetch(BASE + p, { headers: { Cookie: `gibbous_auth=${env.token}` } }); http.set(p, { status: r.status, type: r.headers.get('content-type') ?? 'application/json', body: await r.text() }); } catch { /* */ } };
  const panels = async (id: string) => {
    for (const sub of ['changes', 'diff', 'git', 'files', 'subagents', 'transcript', 'pr']) await extra(`/api/threads/${id}/${sub}`);
    const ch = JSON.parse(http.get(`/api/threads/${id}/changes`)?.body ?? '{}');
    for (const f of ch.files ?? []) await extra(`/api/threads/${id}/diff?file=${encodeURIComponent(f.path)}`);
  };
  for (const t of st.threads) await panels(t.id);
  const boards = JSON.parse(http.get('/api/kanban/boards')?.body ?? '{}');
  for (const bd of boards.boards ?? []) {
    await extra(`/api/kanban/boards/${bd.slug}/tasks`); await extra(`/api/kanban/boards/${bd.slug}/tasks?archived=1`); await extra(`/api/kanban/boards/${bd.slug}/links`);
    const tasks = JSON.parse(http.get(`/api/kanban/boards/${bd.slug}/tasks`)?.body ?? '{}');
    for (const col of tasks.columns ?? []) for (const c of col.cards ?? col.tasks ?? []) await extra(`/api/kanban/boards/${bd.slug}/tasks/${c.id}`);
  }
  for (const p of [s.tide, s.docs]) { await extra(`/api/projects/${p.id}/branches`); await extra(`/api/projects/${p.id}/scripts/detect`); }
  for (const p of ['/api/smoke', '/api/push/apns', '/api/shares', '/api/maintenance', '/api/diagnostics']) await extra(p);
  for (const sess of JSON.parse(http.get('/api/sessions/dirs')?.body ?? '{}').sessions ? Object.keys(JSON.parse(http.get('/api/sessions/dirs')!.body).sessions).filter(id => !id.includes('_usage_')) : []) await extra(`/api/sessions/${sess}/transcript`);
  // Sessions screen: opening any listed session (and importing a Claude Code / Codex one) resumes it.
  await recordSessions();
  await extra('/api/state');
  const stateBefore = http.get('/api/state')!.body;

  // ── 2. the scripted turn: a new thread from Home, approval, reply ──
  console.log('recording the turn…');
  await page.evaluate(() => localStorage.setItem('gibbous.worktree', '0'));
  await go(`#/new/${s.tide.id}`, 1200);
  await page.waitForSelector('textarea[aria-label="First message"]', { visible: true });
  await page.focus('textarea[aria-label="First message"]');
  await page.keyboard.sendCharacter(DEMO_PROMPT);
  const t0 = Date.now(), f0 = frames.length;
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.startsWith('#/t/'), { timeout: 15000 });
  const turnThread = await page.evaluate(() => location.hash.slice(4));
  await threadStatus(env, turnThread, 'needs_input');
  await sleep(1500);
  const tAnswer = Date.now(), fA = frames.length;
  await clickText(page, 'Allow once');
  await threadStatus(env, turnThread, 'idle');
  await sleep(2500);
  const fEnd = frames.length;
  const created = (await env.api<any>('GET', '/api/state')).threads.find((t: any) => t.id === turnThread);
  await go('#/inbox', 800); await go(`#/t/${turnThread}`, 2000);  // the resume after the turn
  await panels(turnThread);   // Changes/Files panels of a demo thread, after its edits
  const turnAfter = await call('session.resume', { session_id: created.sessionId });   // full rows, for reloads

  // ── 3. the seeded approval (TypeScript upgrade): what happens after Allow ──
  console.log('recording the seeded approval…');
  await go(`#/t/${s.threads.ts}`, 2000);
  const pending = (await env.api<any>('GET', '/api/state')).requests as any[];
  const tsT = Date.now(), fTs = frames.length;
  await clickText(page, 'Allow once');
  await threadStatus(env, s.threads.ts, 'idle');
  await sleep(2500);
  const fTsEnd = frames.length;
  await go('#/inbox', 800); await go(`#/t/${s.threads.ts}`, 2000);
  await sleep(500);
  const tsAfter = await call('session.resume', { session_id: st.threads.find((t: any) => t.id === s.threads.ts).sessionId });

  // ── assemble ──
  const slice = (from: number, to: number, base: number) => frames.slice(from, to).filter(f => f.dir === 'in').map(f => ({ t: Math.max(0, Math.round(f.t - base)), m: f.m }));
  const live = created && rpcLive(created.sessionId);
  const turnSessions = new Set([live, created?.sessionId].filter(Boolean));
  const keepTurn = (m: any, threadId: string, sessions: Set<string>) => {
    if (m.id != null) return false;                                  // RPC answers and server→client requests
    if (m.method === 'event') return sessions.has(m.params.session_id);
    if (m.method === 'gibbous.event') {
      const { kind, data } = m.params;
      if (kind === 'thread') return data.id === threadId;
      if (kind === 'requests') return true;
      if (kind === 'notify') return String(data.url ?? '').includes(threadId);
      return false;
    }
    return false;
  };
  const turnAll = slice(f0, fEnd, t0);
  const before = turnAll.filter((_, i) => f0 + i < fA);
  const after = slice(fA, fEnd, tAnswer);
  const tsReq = pending.find(r => r.threadId === s.threads.ts);
  const tsLive = rpcLive(st.threads.find((t: any) => t.id === s.threads.ts).sessionId);
  const fixtures = {
    recordedAt: Date.now(),   // the worker shifts every timestamp by (now - recordedAt)
    stateBefore: JSON.parse(stateBefore),
    http: Object.fromEntries([...http].filter(([k]) => k !== '/api/state').map(([k, v]) => [k, v.type.includes('json') ? { status: v.status, json: safeJson(v.body) } : { status: v.status, type: v.type, body: v.body }])),
    rpc: dedupeRpc(),
    turn: {
      prompt: DEMO_PROMPT, thread: created, live, request: undefined as any,
      before: before.filter(f => keepTurn(f.m, turnThread, turnSessions)),
      after: after.filter(f => keepTurn(f.m, turnThread, turnSessions)),
      resumeAfter: turnAfter,
    },
    continuations: tsReq ? {
      [tsReq.id]: { threadId: s.threads.ts, frames: slice(fTs, fTsEnd, tsT).filter(f => keepTurn(f.m, s.threads.ts, new Set([tsLive, tsReq.params?.session_id].filter(Boolean)))), resumeAfter: tsAfter },
    } : {},
  };
  // The turn's approval request as the server listed it.
  fixtures.turn.request = before.map(f => f.m).filter(m => m.method === 'gibbous.event' && m.params.kind === 'requests').map(m => m.params.data.find((r: any) => r.threadId === turnThread)).find(Boolean);
  let text = JSON.stringify(fixtures);
  text = text.split(SCRATCH).join('/tmp/gibbous-demo').split(DEMO).join(NEUTRAL_HOME);
  for (const secret of [env.token]) if (text.includes(secret)) throw new Error('fixtures contain the demo access token');
  // Nothing personal: no other home folder, no tailnet name, not this Mac's user or host name.
  const lower = text.toLowerCase(), me = [os.userInfo().username, os.hostname().split('.')[0]].filter(x => x.length > 2).map(x => x.toLowerCase());
  const at = [/\/Users\/(?!demo\b|Shared\b)[\w.-]+|\.ts\.net/i.exec(text)?.index ?? -1, ...me.map(x => lower.indexOf(x))].find(i => i >= 0);
  const leak = at == null ? null : { index: at };
  if (leak) throw new Error(`fixtures contain personal data near: ${text.slice(Math.max(0, leak.index - 60), leak.index + 60)}`);
  fs.writeFileSync(OUT_FILE, text);
  const n = (a: unknown[]) => a.length;
  console.log(`✓ ${path.relative(process.cwd(), OUT_FILE)}  ${(text.length / 1024).toFixed(0)} KB · ${Object.keys(fixtures.http).length} GETs · ${n(fixtures.rpc)} RPC answers · turn ${n(fixtures.turn.before)}+${n(fixtures.turn.after)} frames · ${Object.keys(fixtures.continuations).length} continuation(s)`);
  const errs = (page as any).demoErrors as string[];
  if (errs.length) console.log('  ! console errors while recording:', errs.join(' | ').slice(0, 800));
} finally {
  closeRpc();
  await b.close();
  await env.stop();
}

// session.resume (full rows) for every listed session, and session.foreign.import + resume for every Claude Code /
// Codex one: what the Sessions screen opens.
async function recordSessions() {
  const listed = await call('session.list', { limit: 5000 });
  for (const x of listed?.sessions ?? []) await call('session.resume', { session_id: x.id });
  for (const source of ['claude', 'codex']) {
    const page = await call('session.foreign.list', { source, offset: 0, limit: 50 });
    for (const f of page?.sessions ?? []) { const r = await call('session.foreign.import', { id: f.id }); if (r?.session_id) await call('session.resume', { session_id: r.session_id }); }
  }
}

// The app's own /ws, signed in like a browser; every answer is recorded.
async function openRpc(env: Env) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: `gibbous_auth=${env.token}`, Origin: BASE } });
  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  await new Promise<void>((res, rej) => { ws.on('error', rej); ws.on('message', (raw: any) => { const m = JSON.parse(String(raw)); if (m.params?.type === 'gateway.ready') res(); if (m.id != null && !m.method) waiting.get(m.id)?.(m); }); });
  return {
    call: (method: string, params: any) => new Promise<any>(res => { const n = ++id; waiting.set(n, m => { waiting.delete(n); rpcs.push({ method, params, ...(m.error ? { error: m.error } : { result: m.result }) }); res(m.result); }); ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params })); }),
    close: () => ws.close(),
  };
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return null; } }

// The live (runtime) session id the browser saw for a stored id: from session.resume answers.
function rpcLive(stored: string) { return rpcs.filter(r => r.method === 'session.resume' && r.params?.session_id === stored && r.result).map(r => r.result.session_id).pop(); }

// One answer per (method, params); session.resume keeps the FIRST answer per session (the state before any turn),
// later ones live in the turn/continuation resumeAfter.
function dedupeRpc() {
  const out = new Map<string, any>();
  for (const r of rpcs) {
    const k = r.method + ' ' + JSON.stringify(r.params ?? {});
    if (r.method === 'session.resume' && out.has(k)) continue;
    if (r.method === 'prompt.submit') continue;
    out.set(k, r);
  }
  return [...out.values()];
}

async function clickText(page: Page, text: string) {
  await page.waitForFunction(t => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === t), { timeout: 15000 }, text);
  await page.evaluate(t => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.innerText.trim() === t)!.click(), text);
}

// A desktop tab on the demo instance with every /api GET and every /ws frame captured.
async function openPage(env: Env): Promise<{ page: Page; cdp: CDPSession }> {
  const page = await b.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { get: () => false });
    localStorage.setItem('gibbous.location', JSON.stringify({ lat: 0, lon: 0, src: 'ip', at: Date.now() }));
  });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_ABORTED|ERR_BLOCKED|geojs|ipapi|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  (page as any).demoErrors = errors;
  page.on('dialog', d => d.accept().catch(() => {}));
  page.on('response', async r => {
    const u = new URL(r.url());
    if (u.origin !== BASE || !u.pathname.startsWith('/api/') || r.request().method() !== 'GET') return;
    try { http.set(u.pathname + u.search, { status: r.status(), type: r.headers()['content-type'] ?? '', body: await r.text() }); } catch { /* body gone */ }
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*geojs*', '*ipapi.co*', '*ipwho*'] });
  const socks = new Set<string>(), pending = new Map<string, { method: string; params: any }>();
  cdp.on('Network.webSocketCreated', e => { if (new URL(e.url).pathname === '/ws') socks.add(e.requestId); });
  const onFrame = (dir: 'in' | 'out') => (e: any) => {
    if (!socks.has(e.requestId)) return;
    let m: any; try { m = JSON.parse(e.response.payloadData); } catch { return; }
    frames.push({ t: Date.now(), sock: e.requestId, dir, m });
    if (dir === 'out' && m.method && m.id != null) pending.set(`${e.requestId}:${m.id}`, { method: m.method, params: m.params });
    if (dir === 'in' && m.id != null && !m.method) {
      const q = pending.get(`${e.requestId}:${m.id}`);
      if (q) { pending.delete(`${e.requestId}:${m.id}`); rpcs.push({ ...q, ...(m.error ? { error: m.error } : { result: m.result }) }); }
    }
  };
  cdp.on('Network.webSocketFrameSent', onFrame('out'));
  cdp.on('Network.webSocketFrameReceived', onFrame('in'));
  await page.goto(`${BASE}/login?token=${env.token}`, { waitUntil: 'networkidle0' });
  await page.bringToFront();
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitForFunction(() => !!document.querySelector('[data-pane]'), { timeout: 15000 });
  await sleep(800);
  return { page, cdp };
}
