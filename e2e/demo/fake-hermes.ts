// A scripted stand-in for `hermes serve` for demo footage: the same REST + JSON-RPC-over-WebSocket surface Gibbous
// uses, but every agent turn is a script (scenario.ts) that streams realistic events from the gateway contract:
// reasoning, status, tool start/complete with inline diffs, subagents, approvals, streamed replies. It spends no
// model tokens. Scripts may write real files in the session cwd, so Gibbous's Changes panel shows a real git diff.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from '../../server/node_modules/ws/wrapper.mjs';

export type Row = Record<string, unknown> & { role: string };
export interface Session {
  live: string; stored: string; cwd: string; title?: string; model: string;
  rows: Row[]; running: boolean; inflight?: { user: string; assistant: string };
  source?: string; startedAt?: number; profile?: string;
  usage: { total: number; input: number; output: number; cost_usd: number; context_used: number; context_max: number; context_percent: number; calls: number };
  turn?: Promise<void>; interrupted?: boolean;
}

export interface Turn {
  s: Session; prompt: string;
  wait(ms: number): Promise<void>;
  status(text: string): Promise<void>;
  reason(text: string, cps?: number): Promise<void>;
  say(text: string, cps?: number): Promise<void>;
  tool(name: string, args: Record<string, unknown>, o?: { ms?: number; context?: string; result?: unknown; edit?: Edit | Edit[]; approval?: { command: string; description: string }; hold?: string }): Promise<void>;
  subagents(list: { goal: string; tools: [string, string][]; summary: string; ms: number }[]): Promise<void>;
  hold(name: string): Promise<void>;
  file(rel: string): string;
}
export interface Edit { path: string; content?: string; replace?: [string, string][] }
export type Script = (t: Turn) => Promise<string | void>;

// Demo data the fake serves besides live turns (demo-data.ts): stored sessions from other surfaces, Claude Code /
// Codex logs for the import screen, and a Hermes kanban board (the dashboard plugin's REST shape).
export interface Preload { id?: string; title: string; source: string; cwd?: string; startedAt: number; profile?: string; rows: { role: string; text: string; at?: number }[] }
export interface ForeignRow { id: string; source: 'claude' | 'codex'; label: string; title: string; cwd?: string; mtime: number; turn_count: number; excerpt: string; turns: { role: string; text: string }[] }
export interface KanbanTask { id: string; title: string; status: string; assignee?: string | null; priority?: number; created_at: number; started_at?: number | null; completed_at?: number | null;
  current_run_started_at?: number | null; latest_summary?: string | null; block_kind?: string | null; branch_name?: string | null; body?: string; created_by?: string;
  parents?: string[]; comments?: { author: string; body: string; at: number }[]; events?: { kind: string; payload: unknown; at: number }[];
  runs?: { id: number; profile: string; status: string; outcome?: string | null; summary?: string | null; started_at: number; ended_at?: number | null }[] }
export interface KanbanData { board: { slug: string; name: string; description: string; icon: string; color: string; default_workdir: string }; tasks: KanbanTask[]; assignees: string[] }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function fakeHermes(o: { token: string; pick: (prompt: string, s: Session) => Script; model?: string; titleFor?: (input: string) => string;
  foreign?: ForeignRow[]; kanban?: KanbanData; home?: string;
  // First-run setup (Gibbous onboarding): start without a usable model; sign-ins/keys/model choice make it usable.
  setup?: { configured?: boolean } }) {
  const home = o.home ?? os.homedir();   // sessions without a cwd sit here (the demo home, never the real one)
  const sockets = new Set<WebSocket>();
  const sessions = new Map<string, Session>();
  const pendingAnswers = new Map<string, (r: any) => void>();
  const holds = new Map<string, () => void>();
  const holdWaiters = new Map<string, (() => void)[]>();
  let n = 0, rowId = 0, reqN = 0, toolN = 0;
  const speed = { factor: 1 };   // 0 = instant (seeding), 1 = real time

  const emit = (type: string, session_id: string, payload: unknown = {}) => {
    const f = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id, payload } });
    for (const s of sockets) s.send(f);
  };
  const byAny = (id: string) => sessions.get(id) ?? [...sessions.values()].find(s => s.stored === id);
  const info = (s: Session) => ({
    model: s.model, provider: 'anthropic', reasoning_effort: 'medium', fast: false, yolo: false, approval_mode: 'manual',
    cwd: s.cwd, title: s.title, stored_session_id: s.stored, running: s.running, version: '0.11.2', usage: s.usage, profile_name: 'default',
  });
  const newSession = (cwd: string, title?: string): Session => {
    const id = (++n).toString(36).padStart(4, '0');
    const s: Session = {
      live: `live_${id}`, stored: `20261009_${id}_${Math.random().toString(16).slice(2, 8)}`, cwd, title, model: o.model ?? 'claude-sonnet-4-5',
      rows: [], running: false,
      usage: { total: 0, input: 0, output: 0, cost_usd: 0, context_used: 0, context_max: 200_000, context_percent: 0, calls: 0 },
    };
    sessions.set(s.live, s);
    return s;
  };
  // Row timestamps use a clock that slows down with the recorder's slow motion (see lib.ts), like the page's clock.
  const vclock = { slow: 1, baseReal: Date.now(), baseVirt: Date.now() };
  const vms = () => vclock.baseVirt + (Date.now() - vclock.baseReal) / vclock.slow;
  const now = () => vms() / 1000;
  const push = (s: Session, r: Row, at = now()) => { s.rows.push({ row_id: ++rowId, timestamp: at, ...r }); };

  // Unified diff in Hermes' inline format ("a/x → b/x" header), from the file before and after.
  const inlineDiff = (rel: string, before: string, after: string) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-'));
    fs.writeFileSync(path.join(tmp, 'a'), before); fs.writeFileSync(path.join(tmp, 'b'), after);
    let out = '';
    try { execFileSync('git', ['diff', '--no-index', '--no-color', '-U2', 'a', 'b'], { cwd: tmp, encoding: 'utf8' }); }
    catch (e: any) { out = String(e.stdout ?? ''); }
    fs.rmSync(tmp, { recursive: true, force: true });
    const hunks = out.split('\n'); const i = hunks.findIndex(l => l.startsWith('@@'));
    return i < 0 ? '' : `a/${rel} → b/${rel}\n${hunks.slice(i).join('\n')}`;
  };

  function runTurn(s: Session, prompt: string) {
    const script = o.pick(prompt, s);
    s.running = true; s.interrupted = false;
    s.inflight = { user: prompt, assistant: '' };
    // Row timestamps follow the script's own clock, so turns seeded at full speed still get realistic durations.
    const t0 = now(); let virt = 0;
    const at = () => t0 + virt / 1000;
    push(s, { role: 'user', text: prompt }, t0);
    let reasoning = '';
    const flushReasoning = () => { if (reasoning) { push(s, { role: 'assistant', text: '', reasoning }, at()); reasoning = ''; } };
    const check = () => { if (s.interrupted) throw new Error('interrupted'); };
    const wait = async (ms: number) => { check(); virt += ms; if (speed.factor > 0) await sleep(ms * speed.factor); check(); };
    const stream = async (type: 'reasoning.delta' | 'message.delta', text: string, cps: number) => {
      // Word-ish chunks at a steady rate, like a provider stream.
      const parts = text.match(/\S*\s*/g)!.filter(Boolean);
      let buf = '';
      for (const p of parts) {
        buf += p;
        if (buf.length >= 6 || p === parts[parts.length - 1]) { emit(type, s.live, { text: buf }); if (type === 'message.delta') s.inflight!.assistant += buf; await wait(buf.length / cps * 1000); buf = ''; }
      }
    };
    const t: Turn = {
      s, prompt, wait,
      file: rel => path.join(s.cwd, rel),
      status: async text => { emit('status.update', s.live, { kind: 'status', text }); },
      reason: async (text, cps = 220) => { reasoning += (reasoning ? '\n' : '') + text; await stream('reasoning.delta', text, cps); },
      say: async (text, cps = 260) => { flushReasoning(); await stream('message.delta', text, cps); },
      tool: async (name, args, x = {}) => {
        const id = `call_${(++toolN).toString(36)}`;
        emit('tool.generating', s.live, { name });
        await wait(250);
        flushReasoning();
        emit('tool.start', s.live, { tool_id: id, name, args, context: x.context });
        if (x.approval) {
          const rid = `req_${++reqN}`;
          const answer = new Promise<any>(r => pendingAnswers.set(rid, r));
          const frame = JSON.stringify({ jsonrpc: '2.0', id: rid, method: 'approval', params: { session_id: s.live, request_id: rid, tool_name: undefined, ...x.approval, allow_session: true, allow_permanent: true } });
          for (const so of sockets) so.send(frame);
          const r = await answer;
          if (r?.choice === 'deny') {
            emit('tool.complete', s.live, { tool_id: id, name, args, duration_s: 0.1, result: { error: 'Denied by user', exit_code: 1 } });
            push(s, { role: 'tool', name, args, tool_call_id: id, context: x.context }, at());
            throw new Error('denied');
          }
        }
        if (x.hold) await t.hold(x.hold);
        await wait(x.ms ?? 700);
        let diff = '';
        for (const e of x.edit ? [x.edit].flat() : []) {
          const f = path.join(s.cwd, e.path);
          const before = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
          let after = e.content ?? before;
          for (const [a, b] of e.replace ?? []) { if (!after.includes(a)) throw new Error(`demo edit: ${e.path} lacks ${JSON.stringify(a.slice(0, 40))}`); after = after.replace(a, b); }
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, after);
          diff += (diff ? '\n' : '') + inlineDiff(e.path, before, after);
        }
        const duration = (x.ms ?? 700) / 1000 + 0.05 + Math.random() * 0.2;
        emit('tool.complete', s.live, { tool_id: id, name, args, duration_s: duration, result: x.result ?? { success: true }, ...(diff ? { inline_diff: diff } : {}) });
        push(s, { role: 'tool', name, args, tool_call_id: id, context: x.context }, at());
        s.usage.calls++; s.usage.input += 2400 + Math.round(Math.random() * 900); s.usage.output += 180;
        s.usage.total = s.usage.input + s.usage.output; s.usage.context_used = Math.min(s.usage.context_max * 0.6, 14_000 + s.usage.total * 0.35);
        s.usage.context_percent = Math.round(s.usage.context_used / s.usage.context_max * 100); s.usage.cost_usd = +(s.usage.total * 0.0000062).toFixed(4);
        emit('session.usage', s.live, { usage: s.usage });
      },
      subagents: async list => {
        flushReasoning();
        const did = `dlg_${++toolN}`;
        const id = `call_${(++toolN).toString(36)}`;
        emit('tool.start', s.live, { tool_id: id, name: 'delegate_task', args: { tasks: list.map(l => ({ goal: l.goal })) } });
        const t0 = Date.now();
        await Promise.all(list.map(async (l, i) => {
          const sid = `${did}-${i}`;
          emit('subagent.start', s.live, { subagent_id: sid, delegation_id: did, goal: l.goal, task_index: i, task_count: list.length, model: s.model, status: 'running' });
          for (const [tool, preview] of l.tools) { await wait(l.ms / (l.tools.length + 1)); emit('subagent.tool', s.live, { subagent_id: sid, tool_name: tool, tool_preview: preview, task_index: i, task_count: list.length }); }
          await wait(l.ms / (l.tools.length + 1));
          emit('subagent.complete', s.live, { subagent_id: sid, status: 'completed', summary: l.summary, task_index: i, task_count: list.length, input_tokens: 18000 + i * 2100, output_tokens: 1400 + i * 300, duration_seconds: (Date.now() - t0) / 1000 });
        }));
        emit('tool.complete', s.live, { tool_id: id, name: 'delegate_task', duration_s: (Date.now() - t0) / 1000, result: { results: list.map(l => ({ status: 'completed', summary: l.summary })) } });
        push(s, { role: 'tool', name: 'delegate_task', args: { tasks: list.map(l => ({ goal: l.goal })) }, tool_call_id: id }, at());
      },
      hold: name => new Promise<void>(resolve => {
        holds.set(name, resolve);
        for (const w of holdWaiters.get(name) ?? []) w();
        holdWaiters.delete(name);
      }),
    };
    const first = s.rows.length === 1;
    s.turn = (async () => {
      await sleep(first && speed.factor > 0 ? 1200 * speed.factor : 30);
      emit('message.start', s.live);
      if (!s.title) { s.title = prompt.split('\n')[0].slice(0, 80); setTimeout(() => emit('session.title', s.live, { session_id: s.stored, title: s.title }), 400); }
      emit('thinking.delta', s.live, { text: '(◕‿◕) pondering...' });
      let text = '', status = 'complete';
      try { text = (await script(t)) ?? ''; }
      catch (e: any) { status = s.interrupted || e.message === 'interrupted' ? 'interrupted' : e.message === 'denied' ? 'complete' : 'error'; if (status === 'error') console.error('[fake-hermes] script failed:', e); if (e.message === 'denied') text = 'Okay, I left it alone.'; }
      if (!text) text = s.inflight?.assistant ?? '';
      flushReasoning();
      if (text) push(s, { role: 'assistant', text }, at());
      s.running = false; s.inflight = undefined;
      s.usage.output += Math.round(text.length / 3.6); s.usage.total = s.usage.input + s.usage.output;
      emit('message.complete', s.live, { text, status, usage: s.usage });
    })();
  }

  function preload(p: Preload): Session {
    const s = newSession(p.cwd ?? home, p.title);
    if (p.id) { sessions.delete(s.live); s.stored = p.id; s.live = `live_${p.id.slice(-6)}`; sessions.set(s.live, s); }
    s.source = p.source; s.startedAt = p.startedAt; s.profile = p.profile;
    p.rows.forEach((r, i) => push(s, { role: r.role, text: r.text }, r.at ?? p.startedAt + i * 40));
    return s;
  }

  const methods: Record<string, (p: any) => unknown> = {
    'client.capabilities': () => ({ ok: true }),
    'session.create': p => {
      const s = newSession(p.cwd ?? home, p.title);
      return { session_id: s.live, stored_session_id: s.stored, message_count: 0, messages: [], info: info(s) };
    },
    'session.resume': p => {
      const s = byAny(p.session_id); if (!s) throw { code: 4007, message: 'session not found' };
      return { session_id: s.live, stored_session_id: s.stored, running: s.running, message_count: s.rows.length, messages: p.omit_messages ? [] : s.rows,
        info: info(s), open_requests: [], inflight: s.running ? { ...s.inflight, streaming: true } : null, turn_started_at: null };
    },
    'session.status': p => { if (!byAny(p.session_id)) throw { code: 4007, message: 'session not found' }; return { text: 'ok' }; },
    'session.history': p => ({ messages: byAny(p.session_id)?.rows ?? [] }),
    'session.title': p => { const s = byAny(p.session_id); if (s && p.title) s.title = p.title; return { title: s?.title ?? '' }; },
    'session.interrupt': p => { const s = byAny(p.session_id); if (s?.running) s.interrupted = true; return { ok: true }; },
    'session.close': () => ({ ok: true }),
    'session.usage': p => ({ usage: byAny(p.session_id)?.usage }),
    'prompt.submit': p => {
      const s = byAny(p.session_id); if (!s) throw { code: 4007, message: 'session not found' };
      if (s.running) throw { code: 4009, message: 'busy' };
      runTurn(s, String(p.text));
      return { status: 'streaming' };
    },
    'llm.oneshot': p => ({ text: titleFor(String(p.input ?? '')) }),
    'setup.status': () => ({ provider_configured: setup.configured, ready: true }),
    'setup.runtime_check': () => setup.configured ? { ok: true, provider: setup.provider, model: setup.model, source: 'config', free_tier_route: false }
      : { ok: false, provider: 'nous', model: '', error: 'No usable credentials found for nous.' },
    'reload.env': () => ({ updated: 0 }),
    'model.options': () => ({ model: o.model ?? 'claude-sonnet-4-5', provider: 'anthropic', providers: [
      { slug: 'anthropic', name: 'Anthropic', authenticated: true, is_current: true, models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'] },
      { slug: 'openai', name: 'OpenAI', authenticated: true, models: ['gpt-5', 'gpt-5-mini'] },
    ] }),
    'rollback.list': () => ({ enabled: true, checkpoints: [] }),
    'process.list': () => ({ processes: [] }),
    'session.list': () => ({ sessions: [...sessions.values()].filter(s => !s.profile || s.profile === 'default').sort((a, b) => (b.startedAt ?? now()) - (a.startedAt ?? now()))
      .map(s => ({ id: s.stored, title: s.title, source: s.source ?? 'desktop', started_at: s.startedAt ?? now() - 3600, message_count: s.rows.length, preview: String(s.rows[0]?.text ?? '').slice(0, 80) })) }),
    'session.foreign.list': p => {
      const all = (o.foreign ?? []).filter(f => f.source === p.source).sort((a, b) => b.mtime - a.mtime), off = Number(p.offset ?? 0), lim = Math.min(50, Number(p.limit ?? 50));
      const page = all.slice(off, off + lim).map(({ turns: _, ...r }) => r);
      return { sessions: page, next_offset: off + lim < all.length ? off + lim : null, host: 'demo' };
    },
    'session.foreign.import': p => {
      const f = (o.foreign ?? []).find(x => x.id === p.id); if (!f) throw { code: 4007, message: 'foreign session not found' };
      const done = [...sessions.values()].find(x => (x as any).foreignId === f.id);
      if (done) return { session_id: done.stored, already_imported: true };
      // Like hermes_cli/foreign_sessions.py: user/assistant text only, tool calls collapsed to a marker.
      const s = preload({ title: f.title, source: f.source === 'claude' ? 'claude_code' : 'codex', cwd: f.cwd, startedAt: f.mtime - 1800, rows: f.turns });
      (s as any).foreignId = f.id;
      return { session_id: s.stored };
    },
    'profiles.list': () => ({ profiles: [{ name: 'default', is_default: true, active: true }] }),
    'mcp.servers.list': () => ({ servers: [] }),
    'complete.slash': () => ({ items: [] }),
    'complete.path': () => ({ items: [] }),
    'config.get': p => ({ value: ({ 'approvals.mode': 'manual' } as Record<string, string>)[p.key] ?? null }),
    'config.set': () => ({ ok: true }),
    'session.context_breakdown': () => ({ categories: [] }),
    'groups.list': () => ({ rooms: [] }),
    'mcp.servers.status': () => ({ servers: [] }),
    'connectors.list': () => ({ available: false, connectors: [] }),
    'vault.list': () => ({ items: [] }),
    'vault.sources': () => ({ sources: [] }),
  };
  // Providers Hermes' onboarding REST knows (oauth catalog + model options), a tiny subset with plausible models.
  const setup = { configured: o.setup?.configured ?? true, provider: 'anthropic', model: o.model ?? 'claude-sonnet-4-5', authed: new Set<string>(o.setup?.configured === false ? [] : ['anthropic']), devices: new Map<string, { provider: string; at: number }>() };
  const CATALOG: { slug: string; name: string; auth_type: string; key_env: string; models: string[] }[] = [
    { slug: 'nous', name: 'Nous Portal', auth_type: 'oauth_device_code', key_env: '', models: ['hermes-4-405b', 'hermes-4-70b'] },
    { slug: 'openai-codex', name: 'ChatGPT or Codex Subscription', auth_type: 'oauth_device_code', key_env: '', models: ['gpt-5.5', 'gpt-5.5-mini'] },
    { slug: 'anthropic', name: 'Anthropic', auth_type: 'api_key', key_env: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'] },
    { slug: 'openai-api', name: 'OpenAI API', auth_type: 'api_key', key_env: 'OPENAI_API_KEY', models: ['gpt-5', 'gpt-5-mini'] },
    { slug: 'openrouter', name: 'OpenRouter', auth_type: 'api_key', key_env: 'OPENROUTER_API_KEY', models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5'] },
    { slug: 'gemini', name: 'Google AI Studio', auth_type: 'api_key', key_env: 'GOOGLE_API_KEY', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
    { slug: 'deepseek', name: 'DeepSeek', auth_type: 'api_key', key_env: 'DEEPSEEK_API_KEY', models: ['deepseek-chat'] },
    { slug: 'zai', name: 'Z.AI / GLM', auth_type: 'api_key', key_env: 'GLM_API_KEY', models: ['glm-4.6'] },
  ];
  const setupRest = (u: URL, method: string, body: any): unknown => {
    const p = u.pathname;
    if (p === '/api/providers/oauth' && method === 'GET') return { providers: [
      ...CATALOG.filter(c => c.auth_type === 'oauth_device_code').map(c => ({ id: c.slug, name: c.name, flow: 'device_code', cli_command: `hermes auth add ${c.slug}`, docs_url: '', status: { logged_in: setup.authed.has(c.slug) } })),
      { id: 'anthropic', name: 'Anthropic Account', flow: 'external', cli_command: 'hermes auth add anthropic', docs_url: '', status: { logged_in: setup.authed.has('anthropic') } }] };
    let m = /^\/api\/providers\/oauth\/([^/]+)\/start$/.exec(p);
    if (m && method === 'POST') { const sid = `dev_${setup.devices.size + 1}`; setup.devices.set(sid, { provider: m[1], at: Date.now() });
      return { session_id: sid, flow: 'device_code', user_code: 'MOON-4821', verification_url: 'https://example.com/device', expires_in: 900, poll_interval: 2 }; }
    m = /^\/api\/providers\/oauth\/([^/]+)\/poll\/([^/]+)$/.exec(p);
    if (m) { const d = setup.devices.get(m[2]); if (!d) return { status: 'error', error_message: 'Session not found or expired' };
      if (Date.now() - d.at < 5000) return { session_id: m[2], status: 'pending' };
      setup.authed.add(d.provider); return { session_id: m[2], status: 'approved' }; }
    if (/^\/api\/providers\/oauth\/sessions\//.test(p) && method === 'DELETE') { setup.devices.delete(p.split('/').pop()!); return { ok: true }; }
    if (p === '/api/env' && method === 'PUT') { const c = CATALOG.find(x => x.key_env === body?.key); if (c && String(body?.value ?? '').trim()) setup.authed.add(c.slug); return { ok: true, key: body?.key }; }
    if (p === '/api/model/options') return { model: setup.configured ? setup.model : '', provider: setup.configured ? setup.provider : '',
      providers: CATALOG.map(c => ({ slug: c.slug, name: c.name, auth_type: c.auth_type, key_env: c.key_env, authenticated: setup.authed.has(c.slug), is_current: setup.configured && c.slug === setup.provider, models: setup.authed.has(c.slug) ? c.models : [] })) };
    if (p === '/api/model/recommended-default') { const c = CATALOG.find(x => x.slug === u.searchParams.get('provider')); return { provider: c?.slug ?? '', model: c?.models[0] ?? '', free_tier: null }; }
    if (p === '/api/model/set' && method === 'POST') {
      if (!setup.authed.has(body?.provider)) return { ok: false, detail: 'not signed in' };
      if (/opus/.test(String(body?.model)) && !body?.confirm_expensive_model) return { ok: false, scope: 'main', confirm_required: true, confirm_message: `${body.model} costs about 5× more per token than the default.` };
      Object.assign(setup, { configured: true, provider: body.provider, model: body.model }); return { ok: true, scope: 'main', provider: body.provider, model: body.model };
    }
    return undefined;
  };
  const titleFor = (input: string) => o.titleFor?.(input) ?? input.split(/\s+/).slice(0, 3).join(' ');

  const rest = (u: URL): unknown => {
    const p = u.pathname;
    if (p === '/api/status') return { version: '0.11.2', gateway_running: false };
    if (p === '/api/hermes/update/check') return { update_available: false, current: '0.11.2', latest: '0.11.2', install_method: 'git', current_version: '0.11.2', behind: 0, can_apply: true, message: 'On the latest release.' };
    if (p.startsWith('/api/actions/')) return { running: false, exit_code: null, lines: [] };
    if (p === '/api/analytics/usage') {
      const days = Number(u.searchParams.get('days') ?? 7);
      const daily = Array.from({ length: days }, (_, i) => { const d = new Date(Date.now() - (days - 1 - i) * 86400000); const k = (i * 37) % 11;
        return { day: d.toISOString().slice(0, 10), input_tokens: 380_000 + k * 41_000, output_tokens: 42_000 + k * 5_200, cache_read_tokens: 1_100_000 + k * 90_000, actual_cost: +(0.8 + k / 4).toFixed(2), estimated_cost: +(0.8 + k / 4).toFixed(2), sessions: 3 + (i % 5), api_calls: 40 + k * 6 }; });
      const sum = (f: (d: typeof daily[number]) => number) => daily.reduce((n, d) => n + f(d), 0);
      const inp = sum(d => d.input_tokens), out = sum(d => d.output_tokens), cost = +sum(d => d.actual_cost).toFixed(2);
      return { daily,
        by_model: [{ model: 'claude-sonnet-4-5', input_tokens: Math.round(inp * .72), output_tokens: Math.round(out * .7), estimated_cost: +(cost * .78).toFixed(2), sessions: Math.round(sum(d => d.sessions) * .7) },
          { model: 'claude-haiku-4-5', input_tokens: Math.round(inp * .2), output_tokens: Math.round(out * .22), estimated_cost: +(cost * .06).toFixed(2), sessions: Math.round(sum(d => d.sessions) * .2) },
          { model: 'gpt-5', input_tokens: Math.round(inp * .08), output_tokens: Math.round(out * .08), estimated_cost: +(cost * .16).toFixed(2), sessions: Math.round(sum(d => d.sessions) * .1) }],
        totals: { total_input: inp, total_output: out, total_cache_read: sum(d => d.cache_read_tokens), total_estimated_cost: cost, total_actual_cost: cost, total_sessions: sum(d => d.sessions), total_api_calls: sum(d => d.api_calls) },
        tools: [{ tool: 'terminal', count: 412 }, { tool: 'read_file', count: 388 }, { tool: 'patch', count: 203 }, { tool: 'search_files', count: 150 }, { tool: 'write_file', count: 61 }, { tool: 'delegate_task', count: 18 }] };
    }
    if (p === '/api/sessions/search') return { results: [] };
    const mm = /^\/api\/sessions\/([^/]+)\/messages$/.exec(p);
    if (mm) {
      const s = byAny(decodeURIComponent(mm[1]));
      const messages = (s?.rows ?? []).map(r => ({ id: r.row_id, session_id: s!.stored, role: r.role, content: String(r.text ?? ''), reasoning: r.reasoning ?? null, timestamp: r.timestamp, tool_name: r.role === 'tool' ? r.name : null, tool_call_id: r.tool_call_id ?? null }));
      return { messages, pagination: { returned: messages.length } };
    }
    if (p.startsWith('/api/plugins/kanban')) return kanbanRest(p.slice('/api/plugins/kanban'.length), u);
    if (p === '/api/cron/jobs') return [];
    if (p === '/api/cron/delivery-targets') return { targets: [{ id: 'discord', name: 'Discord', home_target_set: true }] };
    if (p === '/api/skills') return SKILLS;
    if (p === '/api/messaging/platforms') return { platforms: PLATFORMS };
    if (p === '/api/pairing') return { pending: [], approved: [{ platform: 'discord', user_id: '4021', username: 'tidepool-maintainer' }] };
    if (p === '/api/learning/graph') return MEMORY;
    if (p === '/api/config/schema') return CONFIG_SCHEMA;
    if (p === '/api/config') return CONFIG;
    if (p === '/api/config/raw') return { yaml: CONFIG_YAML };
    if (p === '/api/env') return ENV;
    return {};
  };

  // Hermes' kanban dashboard plugin (plugins/kanban/dashboard/plugin_api.py), read side only.
  const kb = o.kanban;
  const STATUS_ORDER = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived'];
  const children = (id: string) => (kb?.tasks ?? []).filter(t => t.parents?.includes(id));
  const card = (t: KanbanTask) => {
    const kids = children(t.id);
    return { ...t, parents: undefined, comments: undefined, events: undefined, runs: undefined, link_counts: { parents: t.parents?.length ?? 0, children: kids.length },
      comment_count: t.comments?.length ?? 0, progress: null, warnings: { count: 0 } };
  };
  function kanbanRest(p: string, u: URL): unknown {
    if (!kb) return p === '/boards' ? { boards: [], current: 'default' } : { detail: 'Not Found' }; // no demo board: an empty Hermes (e2e)
    if (p === '/boards') {
      const counts: Record<string, number> = {};
      for (const t of kb.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
      return { boards: [{ ...kb.board, project_id: null, archived: false, is_current: true, counts, total: kb.tasks.length }], current: kb.board.slug };
    }
    if (p === '/projects') return { projects: [] };
    if (p === '/board') return { columns: STATUS_ORDER.map(name => ({ name, tasks: kb.tasks.filter(t => t.status === name).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.completed_at ?? 0) - (a.completed_at ?? 0)).map(card) })), assignees: kb.assignees, now: now() };
    const m = /^\/tasks\/([^/]+)$/.exec(p);
    if (m) {
      const t = kb.tasks.find(x => x.id === decodeURIComponent(m[1]));
      if (!t) return { detail: 'task not found' };
      const linked = [...(t.parents ?? []).map(id => kb.tasks.find(x => x.id === id)!), ...children(t.id)].filter(Boolean);
      let ev = 0;
      return { task: card(t), comments: (t.comments ?? []).map((c, i) => ({ id: i + 1, author: c.author, body: c.body, created_at: c.at })),
        events: (t.events ?? []).map(e => ({ id: ++ev, kind: e.kind, payload: e.payload, created_at: e.at, run_id: null })),
        runs: (t.runs ?? []).map(r => ({ ...r, error: null })), link_tasks: linked.map(l => ({ id: l.id, title: l.title, status: l.status })), links: { parents: t.parents ?? [], children: children(t.id).map(c => c.id) } };
    }
    return { detail: 'Not Found' };
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.headers['x-hermes-session-token'] !== o.token) { res.writeHead(401); res.end('{}'); return; }
    let body: unknown;
    if (req.method !== 'GET') { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); try { body = JSON.parse(Buffer.concat(c).toString() || '{}'); } catch { body = {}; } }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(setupRest(u, req.method ?? 'GET', body) ?? rest(u)));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname !== '/api/ws' || u.searchParams.get('token') !== o.token) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, ws => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', session_id: '', payload: {} } }));
      ws.on('message', raw => {
        const m = JSON.parse(raw.toString());
        if (m.id != null && !m.method) { const r = pendingAnswers.get(String(m.id)); if (r) { pendingAnswers.delete(String(m.id)); r(m.result); } return; }
        if (m.id == null || !m.method) return;
        try {
          const f = methods[m.method];
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: f ? f(m.params ?? {}) : {} }));
        } catch (e: any) { ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message ?? String(e) } })); }
      });
    });
  });

  return {
    speed, sessions, preload, kanban: kb,
    // Move a kanban card (a worker finishing, the dispatcher starting the next one), as Hermes would.
    move: (id: string, status: string) => { const t = kb?.tasks.find(x => x.id === id); if (!t) return; t.status = status;
      if (status === 'running') { t.started_at ??= now(); t.current_run_started_at = now(); }
      if (status === 'review' || status === 'done') { t.current_run_started_at = null; if (status === 'done') t.completed_at = now(); } },
    now,
    setSlow: (x: number) => { vclock.baseVirt = vms(); vclock.baseReal = Date.now(); vclock.slow = x; },
    clockOffset: () => vms() - Date.now(),
    listen: (port = 0) => new Promise<number>(r => server.listen(port, '127.0.0.1', () => r((server.address() as { port: number }).port))),
    setup,
    close: () => new Promise<void>(r => { for (const s of sockets) s.terminate(); wss.close(); server.close(() => r()); }),
    // Let a held script continue; waitHold resolves once a script reaches that hold.
    release: (name: string) => { const r = holds.get(name); holds.delete(name); r?.(); return !!r; },
    waitHold: (name: string) => holds.has(name) ? Promise.resolve() : new Promise<void>(r => holdWaiters.set(name, [...(holdWaiters.get(name) ?? []), r])),
    idle: () => Promise.all([...sessions.values()].map(s => s.turn)),
    session: (stored: string) => byAny(stored),
  };
}

// ── Settings screens: plausible Hermes answers so every tab renders (shapes from web/src/settings/*) ──────────
const SKILLS = [
  { name: 'github-pr-workflow', description: 'Branch, commit, open a PR and watch CI with gh.', category: 'github', enabled: true, provenance: 'bundled', usage: { total_count: 41 } },
  { name: 'systematic-debugging', description: 'Understand a bug before fixing it: reproduce, isolate, fix, verify.', category: 'software-development', enabled: true, provenance: 'bundled', usage: { total_count: 23 } },
  { name: 'test-driven-development', description: 'Red, green, refactor: tests before code.', category: 'software-development', enabled: true, provenance: 'hub', usage: { total_count: 12 } },
  { name: 'release-notes', description: 'Draft release notes from merged PRs since the last tag.', category: 'productivity', enabled: true, provenance: 'agent', usage: { total_count: 5 } },
  { name: 'arxiv', description: 'Search arXiv papers by keyword, author or category.', category: 'research', enabled: false, provenance: 'bundled', usage: { total_count: 0 } },
];
const PLATFORMS = [
  { id: 'discord', name: 'Discord', description: 'Chat with the agent in DMs and channels.', enabled: true, configured: true, state: 'connected', home_channel: '#tidepool-dev',
    env_vars: [{ key: 'DISCORD_BOT_TOKEN', required: true, is_set: true, redacted_value: '••••••••3f9a', is_password: true, description: 'Bot token from the Discord developer portal.' }] },
  { id: 'telegram', name: 'Telegram', description: 'Talk to the agent from a Telegram bot.', enabled: false, configured: false, state: 'disabled',
    env_vars: [{ key: 'TELEGRAM_BOT_TOKEN', required: true, is_set: false, is_password: true, description: 'Token from @BotFather.' }] },
  { id: 'slack', name: 'Slack', description: 'A Slack app in your workspace.', enabled: false, configured: false, state: 'disabled',
    env_vars: [{ key: 'SLACK_BOT_TOKEN', required: true, is_set: false, is_password: true }, { key: 'SLACK_APP_TOKEN', required: true, is_set: false, is_password: true }] },
];
const MEMORY = {
  nodes: [
    { id: 'memory:profile:p1', label: 'Prefers small PRs with a test per behaviour change.', kind: 'memory', memorySource: 'profile', timestamp: Date.now() / 1000 - 86400 * 6 },
    { id: 'memory:profile:p2', label: 'Writes British English in docs; American in code identifiers.', kind: 'memory', memorySource: 'profile', timestamp: Date.now() / 1000 - 86400 * 12 },
    { id: 'memory:memory:m1', label: 'tidepool: run `pnpm vitest run` for tests, `pnpm tsc --noEmit` for types.', kind: 'memory', memorySource: 'memory', timestamp: Date.now() / 1000 - 86400 * 2 },
    { id: 'memory:memory:m2', label: 'The Redis tests need REDIS_URL; CI uses a service container.', kind: 'memory', memorySource: 'memory', timestamp: Date.now() / 1000 - 86400 * 4 },
  ],
  memory: [
    { fingerprint: 'p1', body: 'Prefers small PRs with a test per behaviour change.', source: 'profile' },
    { fingerprint: 'p2', body: 'Writes British English in docs; American in code identifiers.', source: 'profile' },
    { fingerprint: 'm1', body: 'tidepool: run `pnpm vitest run` for tests, `pnpm tsc --noEmit` for types.', source: 'memory' },
    { fingerprint: 'm2', body: 'The Redis tests need REDIS_URL; CI uses a service container.', source: 'memory' },
  ],
};
const CONFIG_SCHEMA = {
  category_order: ['model', 'agent', 'display', 'memory', 'terminal'],
  fields: {
    'model.default': { type: 'string', category: 'model', description: 'Model new sessions start with.' },
    'model.provider': { type: 'select', category: 'model', options: ['anthropic', 'openai', 'openrouter'], description: 'Provider for the default model.' },
    'agent.reasoning_effort': { type: 'select', category: 'agent', options: ['low', 'medium', 'high'], description: 'How long the model thinks before answering.' },
    'agent.max_turns': { type: 'number', category: 'agent', description: 'Tool-call budget per turn.' },
    'approvals.mode': { type: 'select', category: 'agent', options: ['manual', 'smart', 'off'], description: 'Ask before risky commands.' },
    'display.busy_input_mode': { type: 'select', category: 'display', options: ['interrupt', 'queue'], description: 'What a message sent mid-turn does.' },
    'display.streaming': { type: 'boolean', category: 'display', description: 'Stream replies as they are written.' },
    'memory.enabled': { type: 'boolean', category: 'memory', description: 'Keep working notes between sessions.' },
    'terminal.timeout': { type: 'number', category: 'terminal', description: 'Seconds before a foreground command is stopped.' },
  },
};
const CONFIG = { model: { default: 'claude-sonnet-4-5', provider: 'anthropic' }, agent: { reasoning_effort: 'medium', max_turns: 90 }, approvals: { mode: 'manual' },
  display: { busy_input_mode: 'interrupt', streaming: true }, memory: { enabled: true }, terminal: { timeout: 180 } };
const CONFIG_YAML = 'model:\n  default: claude-sonnet-4-5\n  provider: anthropic\nagent:\n  reasoning_effort: medium\n  max_turns: 90\napprovals:\n  mode: manual\ndisplay:\n  busy_input_mode: interrupt\n  streaming: true\nmemory:\n  enabled: true\nterminal:\n  timeout: 180\n';
const ENV = {
  ANTHROPIC_API_KEY: { is_set: true, redacted_value: 'sk-ant-…7c2e', is_password: true, provider_label: 'Anthropic' },
  OPENAI_API_KEY: { is_set: true, redacted_value: 'sk-…41d0', is_password: true, provider_label: 'OpenAI' },
  OPENROUTER_API_KEY: { is_set: false, is_password: true, provider_label: 'OpenRouter' },
  GITHUB_TOKEN: { is_set: true, redacted_value: 'ghp_…9b1f', is_password: true, description: 'Used by gh and the PR tools.' },
};
