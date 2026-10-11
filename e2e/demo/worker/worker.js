// Gibbous demo server (demo.gibbousapp.com): the real web app (./public = web/dist) in front of a recorded imitation
// of the Gibbous server. Every visitor gets their own copy of the recorded demo in a Durable Object (keyed by a
// cookie), so threads they start, approvals they answer and settings they change stick for a day. One scripted agent
// turn (fixtures.turn) plays for every prompt; nothing ever runs on a host. Fixtures: node e2e/demo/record.ts.
import { DurableObject } from 'cloudflare:workers';
import recorded from './fixtures.json';

const AUTH = 'gibbous_auth', VISITOR = 'gibbous_demo';
const NOT_HERE = 'Not available in the demo';
const MAX_GAP = 1500;              // longest pause between replayed frames (ms)
const RESET_AFTER = 24 * 3600e3;   // a visitor's demo resets a day after it started

// ── fixtures, shifted so the demo always reads as "recorded just now" ───────────────────────────────────────────
// Lazily, inside a request: at startup a Worker's clock reads 1970.
let F, T, T0, S0, L0, R0, RESUME;
function load() {
  if (F) return;
  F = shifted();
  T = F.turn;                                   // the scripted turn
  T0 = T.thread.id; S0 = T.thread.sessionId; L0 = T.live; R0 = T.request.id;
  // Recorded answers for session.resume (first one per stored session = before any turn) and live ids.
  // Full answers (with rows) win over omit_messages ones; the first per session is the state before any turn.
  RESUME = new Map();
  for (const full of [true, false]) for (const r of F.rpc) if (r.method === 'session.resume' && r.result && !r.params.omit_messages === full && !RESUME.has(r.params.session_id)) RESUME.set(r.params.session_id, r.result);
}
function shifted() {
  const rec = recorded.recordedAt, d = Date.now() - rec, dDays = Math.round(d / 86400e3);
  const lo = rec - 400 * 86400e3, hi = rec + 2 * 86400e3;
  const day = s => { const t = Date.parse(s + 'T12:00:00Z'); return t > lo && t < hi ? new Date(t + dDays * 86400e3).toISOString().slice(0, 10) : s; };
  const walk = v => {
    if (typeof v === 'number') return v > lo && v < hi ? v + d : v > lo / 1000 && v < hi / 1000 ? v + d / 1000 : v;
    if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? day(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = k === 'recordedAt' ? v[k] : walk(v[k]); return o; }
    return v;
  };
  return walk(recorded);
}
const clone = v => structuredClone(v);
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data ?? null), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const cookie = (req, name) => (req.headers.get('Cookie') ?? '').split(';').map(s => s.trim().split('=')).find(([k]) => k === name)?.[1];
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// The entry script of the served build: /api/state reports it, so the stale-build banner never fires.
let buildId;
const build = async env => buildId ??= (async () => {
  const html = await (await env.ASSETS.fetch('https://assets.local/index.html')).text();
  return /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? null;
})();

export default {
  async fetch(req, env) {
    load();
    const u = new URL(req.url);
    const authed = !!env.DEMO_TOKEN && cookie(req, AUTH) === env.DEMO_TOKEN;
    if (u.pathname === '/login') {
      if (!env.DEMO_TOKEN || (u.searchParams.get('token') ?? '') !== env.DEMO_TOKEN) return json({ error: 'bad token' }, 401);
      const next = u.searchParams.get('next') ?? '';
      const h = signIn(req, env);
      h.set('Location', /^#\/[\w/?=&%.~-]*$/.test(next) ? `/${next}` : '/');
      return new Response(null, { status: 302, headers: h });
    }
    if (u.pathname === '/api/login' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (!env.DEMO_TOKEN || String(b.token ?? '') !== env.DEMO_TOKEN) return json({ error: 'bad token' }, 401);
      const h = signIn(req, env); h.set('Content-Type', 'application/json');
      return new Response('{"ok":true}', { status: 200, headers: h });
    }
    if (u.pathname.startsWith('/s/')) return json({ error: 'this share link was removed' }, 404);
    if (u.pathname === '/pty') {
      if (req.headers.get('Upgrade') !== 'websocket' || !authed) return new Response('Forbidden', { status: 403 });
      // The terminal panel: say so, then close with 4001 so it doesn't retry.
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.send('\x1b[2mThe terminal is not available in the demo: nothing runs on a real machine here.\x1b[0m\r\n');
      server.close(4001, 'demo');
      return new Response(null, { status: 101, webSocket: client });
    }
    if (u.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket' || !authed) return new Response('Forbidden', { status: 403 });
      return visitor(req, env).fetch(req);
    }
    if (u.pathname.startsWith('/api/')) {
      if (!authed) return json({ error: 'login required' }, 401);
      if (u.pathname === '/api/image' || u.pathname === '/api/media') return json({ error: 'file not found' }, 404);
      if (req.method !== 'GET' && (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'JSON only' }, 415);
      const fwd = new Request(req); fwd.headers.set('X-Demo-Build', (await build(env)) ?? '');
      return visitor(req, env).fetch(fwd);
    }
    return env.ASSETS.fetch(req);
  },
};

function signIn(req, env) {
  const h = new Headers();
  const opts = '; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000; Secure';
  h.append('Set-Cookie', `${AUTH}=${env.DEMO_TOKEN}${opts}`);
  if (!/^[\w-]{8,64}$/.test(cookie(req, VISITOR) ?? '')) h.append('Set-Cookie', `${VISITOR}=${crypto.randomUUID()}${opts}`);
  return h;
}
const visitor = (req, env) => {
  const id = cookie(req, VISITOR);
  return env.DEMO.get(env.DEMO.idFromName(/^[\w-]{8,64}$/.test(id ?? '') ? id : 'shared'));
};

// ── one visitor's demo ─────────────────────────────────────────────────────────────────────────────────────────
const fresh = () => ({
  projects: clone(F.stateBefore.projects), threads: clone(F.stateBefore.threads), requests: clone(F.stateBefore.requests),
  settings: clone(F.stateBefore.settings), created: {}, extra: {}, done: {}, active: {}, started: Date.now(),
});
const swap = (v, pairs) => { let s = JSON.stringify(v); for (const [a, b] of pairs) if (a && a !== b) s = s.split(a).join(b); return JSON.parse(s); };
const FALLBACK_RPC = {
  'groups.list': { rooms: [] }, 'mcp.servers.list': { servers: [] }, 'mcp.servers.status': { servers: [] }, 'mcp.catalog': { servers: [] },
  'vault.list': { items: [] }, 'vault.sources': { sources: [] }, 'connectors.list': { available: false, connectors: [] },
  'complete.slash': { items: [] }, 'complete.path': { items: [] }, 'rollback.list': { enabled: true, checkpoints: [] }, 'process.list': { processes: [] },
  'profiles.list': { profiles: [{ name: 'default', is_default: true, active: true }] }, 'session.list': { sessions: [] }, 'config.get': { value: null },
  'session.context_breakdown': { categories: [] }, 'skills.reload': { ok: true }, 'reload.mcp': { ok: true }, 'config.set': { ok: true },
  'display.status': { running: false }, 'session.usage': { usage: null }, 'client.capabilities': { ok: true },
};
const REFUSE_RPC = new Set(['image.attach_bytes', 'file.attach', 'mcp.servers.add', 'mcp.servers.remove', 'mcp.servers.test',
  'mcp.servers.oauth.start', 'vault.add', 'vault.remove', 'vault.unlock', 'profiles.create', 'profiles.configure', 'groups.create', 'groups.send',
  'connectors.connect', 'browser.manage', 'display.start', 'process.kill', 'rollback.restore', 'session.branch', 'session.compress', 'prompt.btw', 'prompt.background', 'subagent.steer']);

export class Demo extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rt = new Map();   // threadId → { timer, cancelled } of a turn being replayed
    ctx.blockConcurrencyWhile(async () => {
      load();
      this.s = await ctx.storage.get('s');
      if (!this.s) { this.s = fresh(); await ctx.storage.put('s', this.s); await ctx.storage.setAlarm(Date.now() + RESET_AFTER); }
      // A replay cut short by an eviction: finish it on the spot (a waiting approval stays waiting).
      for (const [tid, a] of Object.entries(this.s.active)) if (a.phase !== 'waiting') this.finish(tid, false);
    });
  }
  save() { return this.ctx.storage.put('s', this.s); }
  async alarm() {
    load();
    for (const r of this.rt.values()) { r.cancelled = true; clearTimeout(r.timer); }
    this.rt.clear();
    await this.ctx.storage.deleteAll();
    this.s = fresh(); await this.save(); await this.ctx.storage.setAlarm(Date.now() + RESET_AFTER);
    this.broadcast('reload', null);
  }

  // ── transport ──
  async fetch(req) {
    load();
    const u = new URL(req.url);
    if (req.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', session_id: '', payload: {} } }));
      return new Response(null, { status: 101, webSocket: client });
    }
    try {
      const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
      const out = await this.route(req.method, u, body, req.headers.get('X-Demo-Build') || null);
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return json({ error: e.message ?? String(e) }, e.status ?? 500);
    }
  }
  async webSocketMessage(ws, raw) {
    load();
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id == null || !m.method) return;   // answers to server→client requests: the server side handles approvals
    try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: await this.rpc(m.method, m.params ?? {}) })); }
    catch (e) { ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message ?? String(e) } })); }
  }
  webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch { /* closed */ } }
  webSocketError() {}
  send(frame) { const s = JSON.stringify(frame); for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch { /* gone */ } } }
  broadcast(kind, data) { this.send({ jsonrpc: '2.0', method: 'gibbous.event', params: { kind, data } }); }
  event(type, session_id, payload) { this.send({ jsonrpc: '2.0', method: 'event', params: { type, session_id, payload } }); }

  // ── ids ──
  thread(id) { const t = this.s.threads.find(t => t.id === id); if (!t) throw new HttpError(404, 'thread not found'); return t; }
  liveOf(t) { return this.s.created[t.id]?.live ?? RESUME.get(t.sessionId)?.session_id ?? `live_${t.sessionId.slice(-6)}`; }
  bySession(sid) { return this.s.threads.find(t => t.sessionId === sid || this.liveOf(t) === sid); }
  // A thread made in the demo answers with the scripted turn's thread's recordings, ids swapped.
  ids(t) { return t && this.s.created[t.id] ? this.turnIds(t) : []; }
  turnIds(t) { return [[T0, t.id], [S0, t.sessionId], [L0, this.liveOf(t)]]; }
  touch(t, patch) { Object.assign(t, patch, { updatedAt: Date.now() }); this.broadcast('thread', t); }

  // ── REST ──
  async route(method, u, b, buildId) {
    const p = u.pathname, s = this.s;
    let m;
    if (method === 'GET') {
      if (p === '/api/state') return { ...F.stateBefore, projects: s.projects, threads: s.threads, settings: s.settings, requests: s.requests, build: buildId ?? F.stateBefore.build, tailnetUrl: null, tailnetLogin: null };
      if ((m = /^\/api\/threads\/([^/]+)\/(\w+)$/.exec(p))) {
        const t = s.threads.find(x => x.id === m[1]);
        if (!t) throw new HttpError(404, 'thread not found');
        if (m[2] === 'history') {
          // The stored rows (server/history.ts display shape = session.resume rows), all in one page.
          if (Number(u.searchParams.get('offset')) > 0) return { messages: [], next: 0, more: false };
          const rows = this.rows(t);
          return { messages: rows, next: rows.length, more: false, first: rows[0]?.row_id };
        }
        const tpl = this.s.created[t.id] ? p.replace(t.id, T0) : p;
        const hit = F.http[tpl + u.search] ?? (Number(u.searchParams.get('offset')) > 0 ? { status: 200, json: { messages: [] } } : F.http[tpl])
          ?? (m[2] === 'transcript' ? F.http[`/api/sessions/${t.sessionId}/transcript`] : undefined);
        if (hit) return this.served(hit, this.ids(t));
        return { changes: { repo: false, files: [] }, diff: { diff: '' }, files: { files: [] }, subagents: { subagents: [] }, transcript: { messages: [] }, pr: { pr: null },
          git: { branch: 'main', branches: ['main'], ahead: 0, behind: 0, dirty: false, conflicts: [], stashes: 0, rebasing: false } }[m[2]] ?? {};
      }
      // The demo's Hermes is a recording: its compatibility check reads as a healthy install's.
      if (p === '/api/smoke' && F.http[p]?.json) { const r = F.http[p].json; return { ...r, ok: true, checks: (r.checks ?? []).map(c => ({ name: c.name, ok: true })) }; }
      const hit = F.http[p + u.search] ?? F.http[p] ?? Object.entries(F.http).find(([k]) => k.split('?')[0] === p)?.[1];
      if (hit) return this.served(hit, []);
      if (p === '/api/fs/ls') return { path: '/Users/demo/code', parent: '/Users/demo', entries: ['tidepool', 'tidepool-docs'], repo: false };
      if (p === '/api/shares' || p === '/api/tailnet/peers' || p.startsWith('/api/hermes/cron/')) return [];
      if (p === '/api/push/apns') return { configured: false, devices: 0 };
      if (/^\/api\/sessions\/[^/]+\/transcript$/.test(p)) return { messages: [] };
      if (p.startsWith('/api/kanban/')) throw new HttpError(404, 'not found');
      return {};
    }
    // Mutations
    if (p === '/api/threads' && method === 'POST') return this.createThread(b);
    if ((m = /^\/api\/threads\/([^/]+)$/.exec(p))) {
      const t = this.thread(m[1]);
      if (method === 'PATCH') {
        if (b.title && String(b.title) !== t.title) { t.title = String(b.title).slice(0, 200); t.autoTitle = undefined; }
        if ('projectId' in b) t.projectId = b.projectId || undefined;
        if ('pinned' in b) t.pinned = b.pinned ? true : undefined;
        if (b.status === 'idle' && t.status === 'archived') t.status = 'idle';
        this.touch(t, {}); await this.save(); return t;
      }
      if (method === 'DELETE') {
        this.stop(t.id, true);
        s.threads = s.threads.filter(x => x.id !== t.id); s.requests = s.requests.filter(r => r.threadId !== t.id);
        this.broadcast('thread-deleted', { id: t.id }); this.broadcast('requests', s.requests); await this.save(); return { ok: true };
      }
    }
    if ((m = /^\/api\/threads\/([^/]+)\/(attach|send|interrupt|archive|continue|reply|revert|commit|pr|fix-ci|file|git)$/.exec(p)) && method === 'POST') {
      const t = this.thread(m[1]);
      switch (m[2]) {
        case 'attach': return { session_id: this.liveOf(t) };
        case 'send': this.startTurn(t, String(b.text ?? '')); return { ok: true };
        case 'interrupt': this.interrupt(t); return { ok: true };
        case 'archive': this.stop(t.id, true); this.touch(t, { status: 'archived' }); await this.save(); return { ok: true };
        default: throw new HttpError(403, NOT_HERE);
      }
    }
    if ((m = /^\/api\/threads\/([^/]+)\/queue(?:\/([^/]+))?(?:\/(now))?$/.exec(p))) return this.queue(method, this.thread(m[1]), m[2], m[3], b);
    if ((m = /^\/api\/requests\/([^/]+)\/answer$/.exec(p)) && method === 'POST') { this.answer(decodeURIComponent(m[1]), b.result ?? {}); await this.save(); return { ok: true }; }
    if (p === '/api/settings' && method === 'PATCH') {
      const st = s.settings;
      for (const k of ['model', 'provider', 'profile']) if (typeof b[k] === 'string') st[k] = b[k];
      if (Array.isArray(b.syncSources)) st.syncSources = b.syncSources.map(String);
      if (b.notify && typeof b.notify === 'object') for (const k of Object.keys(st.notify)) if (typeof b.notify[k] === 'boolean') st.notify[k] = b.notify[k];
      if (Array.isArray(b.snippets)) st.snippets = b.snippets.filter(x => x && typeof x.name === 'string' && typeof x.text === 'string').slice(0, 50).map(x => ({ name: x.name.slice(0, 40), text: x.text.slice(0, 4000) }));
      for (const k of ['autoArchiveDays', 'monthlyBudgetUsd']) if (Number.isFinite(b[k])) st[k] = Math.max(0, Number(b[k]));
      this.broadcast('settings', st); await this.save(); return st;
    }
    if (p === '/api/projects/order' && method === 'POST') {
      const rank = new Map((b.ids ?? []).map((id, i) => [String(id), i]));
      s.projects.sort((x, y) => (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9)); this.broadcast('reload', null); await this.save(); return { ok: true };
    }
    if ((m = /^\/api\/projects\/([^/]+)$/.exec(p))) {
      const pr = s.projects.find(x => x.id === m[1]); if (!pr) throw new HttpError(404, 'project not found');
      if (method === 'PATCH') { for (const k of ['name', 'baseBranch']) if (k in b) pr[k] = b[k]; this.broadcast('project', pr); await this.save(); return pr; }
      if (method === 'DELETE') { s.projects = s.projects.filter(x => x !== pr); for (const t of s.threads) if (t.projectId === pr.id) t.projectId = undefined; this.broadcast('reload', null); await this.save(); return { ok: true }; }
    }
    if (p === '/api/import' && method === 'POST') {
      // Sessions screen: attach a listed session (read-only for other surfaces), like orch.importSession.
      const sid = String(b.sessionId ?? ''), have = s.threads.find(t => t.sessionId === sid);
      if (have) return have;
      if (!RESUME.has(sid)) throw new HttpError(404, 'session not found');
      const at = Number(b.startedAt) || Date.now();
      const t = { id: `th_${rand()}`, projectId: b.projectId, title: String(b.title || 'Imported session').slice(0, 200), sessionId: sid, cwd: s.projects.find(x => x.id === b.projectId)?.path ?? '/Users/demo',
        role: 'chat', status: 'idle', source: b.source, readOnly: b.readOnly !== false, createdAt: at, updatedAt: at };
      s.threads.unshift(t); this.broadcast('thread', t); await this.save(); return t;
    }
    if (p === '/api/push/test') { this.broadcast('notify', { kind: 'input', title: 'Gibbous', body: 'Notifications work.', url: '/', test: true }); return { ok: true, apns: { configured: false, devices: 0 } }; }
    if (p.startsWith('/api/push/')) return { ok: true, configured: false };
    if (p === '/api/sync') return { added: 0 };
    if (p === '/api/threads/retitle') return {};
    if (p === '/api/diff') return { diff: '' };
    throw new HttpError(403, NOT_HERE);
  }
  served(hit, pairs) {
    if ('json' in hit) { const v = swap(hit.json, pairs); if (hit.status >= 400) throw new HttpError(hit.status, v?.error ?? 'error'); return v; }
    return new Response(hit.body, { status: hit.status, headers: { 'Content-Type': hit.type } });
  }

  async createThread(b) {
    const project = this.s.projects.find(p => p.id === b.projectId);
    if (b.host) throw new HttpError(403, NOT_HERE);
    const id = `th_${rand()}`, title = String(b.title || 'New thread').trim().slice(0, 70) || 'New thread';
    const t = { id, projectId: project?.id, title, autoTitle: b.autoTitle || title === 'New thread' || undefined, sessionId: `20261009_demo_${rand().slice(0, 6)}`, cwd: project?.path ?? '/Users/demo', role: 'chat', status: 'idle', createdAt: Date.now(), updatedAt: Date.now() };
    this.s.created[id] = { live: `live_${id.slice(3, 9)}` };
    this.s.threads.unshift(t);
    this.broadcast('thread', t);
    if (b.prompt) this.startTurn(t, String(b.prompt), true);
    await this.save();
    return t;
  }

  async queue(method, t, qid, now, b) {
    if (t.readOnly) throw new HttpError(409, 'this conversation is read-only in Gibbous');
    const q = t.queue ?? [];
    if (!qid && method === 'POST') {
      const item = { id: `q_${rand()}`, text: String(b.text ?? ''), shown: String(b.shown ?? b.text ?? ''), at: Date.now() };
      if (this.s.active[t.id]) { this.touch(t, { queue: [...q, item] }); await this.save(); return { sent: false, id: item.id }; }
      this.broadcast('queueSent', { threadId: t.id, id: item.id, shown: item.shown });
      this.startTurn(t, item.text); await this.save(); return { sent: true, id: item.id };
    }
    if (qid === 'resume') { this.touch(t, { queuePaused: undefined }); this.drain(t); await this.save(); return { ok: true }; }
    if (qid === 'reorder') { const rank = new Map((b.ids ?? []).map((id, i) => [id, i])); this.touch(t, { queue: [...q].sort((x, y) => (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9)) }); await this.save(); return { ok: true }; }
    const item = q.find(x => x.id === qid); if (!item) throw new HttpError(404, 'queued message not found');
    if (now) { this.touch(t, { queue: q.filter(x => x !== item) }); this.interrupt(t, false); this.broadcast('queueSent', { threadId: t.id, id: item.id, shown: item.shown }); this.startTurn(t, item.text); }
    else if (method === 'PATCH') this.touch(t, { queue: q.map(x => x === item ? { ...x, text: String(b.text ?? x.text), shown: String(b.shown ?? b.text ?? x.shown) } : x) });
    else if (method === 'DELETE') { const rest = q.filter(x => x !== item); this.touch(t, { queue: rest.length ? rest : undefined, ...(rest.length ? {} : { queuePaused: undefined }) }); }
    await this.save(); return { ok: true };
  }
  drain(t) {
    if (this.s.active[t.id] || t.queuePaused || !t.queue?.length) return;
    const [head, ...rest] = t.queue;
    this.touch(t, { queue: rest.length ? rest : undefined });
    this.broadcast('queueSent', { threadId: t.id, id: head.id, shown: head.shown });
    this.startTurn(t, head.text);
  }

  // ── JSON-RPC (the Hermes side) ──
  async rpc(method, p) {
    if (method === 'session.resume') return this.resume(p);
    if (method === 'prompt.submit') {
      const t = this.bySession(p.session_id);
      if (!t) throw { code: 4001, message: 'session not found' };
      if (this.s.active[t.id]) throw { code: 4009, message: 'busy' };
      this.startTurn(t, String(p.text ?? '')); await this.save();
      return { status: 'streaming' };
    }
    if (method === 'session.interrupt') { const t = this.bySession(p.session_id); if (t) { this.interrupt(t); await this.save(); } return { ok: true }; }
    if (method === 'slash.exec') return { output: `Slash commands are ${NOT_HERE.toLowerCase()}.` };
    if (REFUSE_RPC.has(method)) throw { code: -32000, message: NOT_HERE };
    // Recorded answers; a demo-made session answers like the scripted turn's session.
    const t = p.session_id ? this.bySession(p.session_id) : undefined, pairs = this.ids(t);
    const back = pairs.map(([a, b]) => [b, a]);
    const key = method + ' ' + JSON.stringify(swap(p, back));
    const hit = F.rpc.find(r => r.method + ' ' + JSON.stringify(r.params ?? {}) === key) ?? F.rpc.find(r => r.method === method && (!p.session_id || r.params?.session_id));
    if (hit) { if (hit.error) throw hit.error; return swap(hit.result, pairs); }
    return FALLBACK_RPC[method] ?? {};
  }
  // A thread's stored rows now: recorded, plus finished demo turns, plus the prompt of a running one.
  rows(t) {
    const rows = [...(this.base(t).messages ?? []), ...(this.s.extra[t.id]?.rows ?? [])];
    const a = this.s.active[t.id];
    if (a && !a.continuation) rows.push({ row_id: this.nextRow(rows), timestamp: a.at / 1000, role: 'user', text: a.prompt });
    return rows;
  }
  resume(p) {
    const t = this.bySession(p.session_id);
    const base = t ? this.base(t) : RESUME.get(p.session_id);
    if (!base) throw { code: 4007, message: 'session not found' };
    const rows = t ? this.rows(t) : base.messages ?? [];
    const a = t && this.s.active[t.id];
    let running = !!base.running, inflight = base.inflight ?? null;
    if (a && !a.continuation) { running = true; inflight = { user: a.prompt, assistant: a.assistant ?? '', streaming: true }; }
    else if (a) running = true;
    return { ...base, running, message_count: rows.length, messages: p.omit_messages ? [] : rows, info: { ...base.info, running }, open_requests: [], inflight };
  }
  base(t) {
    if (this.s.created[t.id]) {
      const r = swap(RESUME.get(S0), this.ids(t));
      return { ...r, messages: [], message_count: 0, running: false, inflight: null, info: { ...r.info, cwd: t.cwd, running: false } };
    }
    const c = Object.values(F.continuations).find(c => c.threadId === t.id);
    if (c && this.s.done[t.id]) return c.resumeAfter;
    const r = RESUME.get(t.sessionId);
    return r ? r : { session_id: this.liveOf(t), stored_session_id: t.sessionId, running: false, message_count: 0, messages: [], info: {}, open_requests: [], inflight: null };
  }
  nextRow(rows) { return rows.reduce((n, r) => Math.max(n, Number(r.row_id) || 0), 0) + 1; }

  // ── the scripted turn ──
  startTurn(t, prompt, created = false) {
    if (this.s.active[t.id]) throw new HttpError(409, 'a turn is already running');
    if (t.readOnly) throw new HttpError(409, 'this conversation is read-only in Gibbous');
    if (this.s.requests.some(r => r.threadId === t.id)) throw new HttpError(409, 'the agent is waiting for your answer in this thread');
    const a = { prompt, phase: 'before', req: `req_${rand().slice(0, 8)}`, assistant: '', at: Date.now() };
    this.s.active[t.id] = a;
    this.touch(t, { status: 'running', error: undefined });
    const frames = created ? T.before : T.before.filter(f => !(f.m.params?.kind === 'thread' && f.m.params.data.status === 'idle'));
    this.play(t, frames, [...this.turnIds(t), [R0, a.req]], () => {
      a.phase = 'waiting';
      if (a.answered) this.afterAnswer(t, a.answered);
      this.save();
    });
  }
  answer(id, result) {
    const s = this.s, r = s.requests.find(x => x.id === id);
    if (!r) throw new HttpError(409, 'request no longer open');
    s.requests = s.requests.filter(x => x !== r);
    this.broadcast('requests', s.requests);
    const t = s.threads.find(x => x.id === r.threadId);
    if (!t) return;
    if (!s.requests.some(x => x.threadId === t.id)) this.touch(t, { status: 'running' });
    const a = s.active[t.id];
    if (a && a.req === id) { if (a.phase === 'waiting') this.afterAnswer(t, result); else a.answered = result; return; }
    // A request recorded in the seeded demo (the TypeScript upgrade): play what came after it.
    const c = F.continuations[id];
    if (!c) return;
    s.active[t.id] = { prompt: '', phase: 'after', req: id, assistant: '', at: Date.now(), continuation: id };
    if (result?.choice === 'deny') return this.play(t, this.denied(c.frames, this.liveOf(t), t), [], () => this.finish(t.id, false, true));
    this.play(t, c.frames, [], () => { s.done[t.id] = true; this.finish(t.id, false); });
  }
  afterAnswer(t, result) {
    const a = this.s.active[t.id];
    a.phase = 'after';
    const pairs = [...this.turnIds(t), [R0, a.req]];
    if (result?.choice === 'deny') { a.denied = true; return this.play(t, this.denied(T.after, L0, t), pairs, () => this.finish(t.id, true, true)); }
    this.play(t, T.after, pairs, () => this.finish(t.id, true));
  }
  // What Hermes does on Deny: the tool fails, the agent leaves it alone.
  denied(after, live, t) {
    const done = after.find(f => f.m.method === 'event' && f.m.params.type === 'tool.complete')?.m.params.payload ?? {};
    const text = 'Okay, I left it alone.';
    const ev = (type, payload, at) => ({ t: at, m: { jsonrpc: '2.0', method: 'event', params: { type, session_id: live, payload } } });
    return [ev('tool.complete', { tool_id: done.tool_id, name: done.name, args: done.args, duration_s: 0.1, result: { error: 'Denied by user', exit_code: 1 } }, 200),
      ev('message.delta', { text }, 500), { t: 700, m: { jsonrpc: '2.0', method: 'gibbous.event', params: { kind: 'thread', data: { ...t, status: 'idle', lastText: text } } } },
      ev('message.complete', { text, status: 'complete' }, 720)];
  }
  // Replays recorded frames with their original spacing (capped), ids swapped to this thread's.
  play(t, frames, pairs, done) {
    const r = { cancelled: false, timer: undefined };
    const old = this.rt.get(t.id); if (old) { old.cancelled = true; clearTimeout(old.timer); }
    this.rt.set(t.id, r);
    let i = 0, prev = 0;
    const step = () => {
      if (r.cancelled) return;
      do { this.emit(t, swap(frames[i].m, pairs)); prev = frames[i].t; i++; } while (i < frames.length && frames[i].t - prev < 25);
      if (i >= frames.length) { this.rt.delete(t.id); return done(); }
      r.timer = setTimeout(step, Math.min(MAX_GAP, frames[i].t - prev));
    };
    if (!frames.length) { this.rt.delete(t.id); return done(); }
    r.timer = setTimeout(step, Math.min(MAX_GAP, frames[0].t));
  }
  emit(t, m) {
    const a = this.s.active[t.id];
    if (m.method === 'gibbous.event') {
      const { kind, data } = m.params;
      if (kind === 'thread') {
        const patch = {}; for (const k of ['status', 'lastText', 'error', 'usage']) if (k in data) patch[k] = data[k];
        if (a?.answered && patch.status === 'needs_input') delete patch.status;
        this.touch(t, patch); return;
      }
      if (kind === 'requests') {
        const mine = a && data.find(x => x.id === a.req);
        if (mine && !this.s.requests.some(x => x.id === mine.id) && a.phase === 'before') { this.s.requests.push({ ...mine, threadId: t.id, at: Date.now() }); this.broadcast('requests', this.s.requests); this.save(); }
        return;
      }
      if (kind === 'notify') { const title = `${String(data.title).split(' ')[0]} ${t.title}`; this.broadcast('notify', { ...data, title }); return; }
      return;
    }
    if (m.params?.type === 'session.title') {
      // Like Gibbous's own title pass: a short title replaces the first-message placeholder.
      if (t.autoTitle && a?.prompt) { const w = a.prompt.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().split(/\s+/).slice(0, 4).join(' '); if (w) this.touch(t, { title: w[0].toUpperCase() + w.slice(1), autoTitle: undefined }); }
      return;
    }
    if (a && m.params?.type === 'message.delta') a.assistant += m.params.payload?.text ?? '';
    this.send(m);
  }
  // The turn ended: its rows join the session (so a reload shows them), the queue moves on.
  finish(tid, scripted, denied = false) {
    const s = this.s, a = s.active[tid], t = s.threads.find(x => x.id === tid);
    delete s.active[tid];
    if (!t || !a) return this.save();
    if (scripted) {
      const extra = s.extra[tid] ??= { rows: [] };
      const all = [...this.base(t).messages, ...extra.rows];
      let row = this.nextRow(all);
      const t0 = Number(T.resumeAfter.messages[0]?.timestamp ?? 0), now = a.at / 1000;
      let rows = T.resumeAfter.messages.map(x => ({ ...x }));
      if (denied) {
        const tool = T.after.find(f => f.m.params?.type === 'tool.complete')?.m.params.payload.tool_id;
        const cut = rows.findIndex(x => x.role === 'tool' && x.tool_call_id === tool);
        rows = [...rows.slice(0, cut >= 0 ? cut + 1 : rows.length - 1), { role: 'assistant', text: 'Okay, I left it alone.', timestamp: rows[rows.length - 1]?.timestamp }];
      }
      for (const x of rows) { x.row_id = row++; x.timestamp = now + (Number(x.timestamp ?? t0) - t0); if (x.role === 'user') x.text = a.prompt; }
      extra.rows.push(...swap(rows, [...this.ids(t), [S0, t.sessionId]]));
    }
    if (t.status !== 'idle') this.touch(t, { status: 'idle' });
    this.save();
    this.drain(t);
  }
  stop(tid, silent) {
    const r = this.rt.get(tid); if (r) { r.cancelled = true; clearTimeout(r.timer); this.rt.delete(tid); }
    if (silent) delete this.s.active[tid];
  }
  interrupt(t, pause = true) {
    const a = this.s.active[t.id];
    if (!a) return;
    this.stop(t.id, false);
    const before = this.s.requests.length;
    this.s.requests = this.s.requests.filter(r => r.id !== a.req);
    if (this.s.requests.length !== before) this.broadcast('requests', this.s.requests);
    this.event('message.complete', this.liveOf(t), { text: a.assistant, status: 'interrupted' });
    const extra = this.s.extra[t.id] ??= { rows: [] };
    if (!a.continuation) {
      let row = this.nextRow([...this.base(t).messages, ...extra.rows]);
      extra.rows.push({ row_id: row++, timestamp: a.at / 1000, role: 'user', text: a.prompt });
      if (a.assistant) extra.rows.push({ row_id: row++, timestamp: Date.now() / 1000, role: 'assistant', text: a.assistant });
    }
    delete this.s.active[t.id];
    this.touch(t, { status: 'idle', ...(pause && t.queue?.length ? { queuePaused: true } : {}) });
  }
}
