// A tiny stand-in for `hermes serve`: the same JSON-RPC over WebSocket, scripted agent replies.
// The script may touch files in the session's cwd, so worktree/review/merge flows run for real.
import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeSession { live: string; stored: string; cwd: string; prompts: string[] }
export type Agent = (prompt: string, s: FakeSession) => string | Promise<string>;

export function fakeHermes(agent: Agent) {
  const wss = new WebSocketServer({ port: 0 });
  const sockets = new Set<WebSocket>();
  const sessions = new Map<string, FakeSession>(); // live (runtime) id → session
  const stored: FakeSession[] = []; // every session ever created, reaped or not
  let n = 0;
  const emit = (type: string, session_id: string, payload: unknown = {}) => {
    const f = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id, payload } });
    for (const s of sockets) s.send(f);
  };
  const byStored = (id: string) => stored.find(s => s.stored === id || s.live === id);
  const methods: Record<string, (p: any) => unknown> = {
    'client.capabilities': () => ({ server_requests: ['approval', 'clarify'] }),
    'session.create': p => {
      const s: FakeSession = { live: `L${++n}`, stored: `S${n}`, cwd: p.cwd, prompts: [] };
      sessions.set(s.live, s); stored.push(s);
      return { session_id: s.live, stored_session_id: s.stored, message_count: 0, messages: [], info: {} };
    },
    'session.resume': p => {
      const s = byStored(p.session_id);
      if (!s) throw { code: 4007, message: 'session not found' };
      if (!sessions.has(s.live)) { s.live = `L${++n}`; sessions.set(s.live, s); } // reaped: resume revives it under a new runtime id
      return { session_id: s.live, running: false, open_requests: [], message_count: s.prompts.length, messages: [], info: {} };
    },
    'prompt.submit': p => {
      const s = sessions.get(p.session_id);
      if (!s) throw { code: 4001, message: 'session not found' }; // real Hermes: stale runtime id
      s.prompts.push(p.text);
      setTimeout(async () => {
        emit('message.start', s.live);
        const text = await agent(p.text, s);
        emit('message.complete', s.live, { text, status: 'complete', usage: { total: 100, cost_usd: 0.01 } });
      }, 5);
      return { status: 'streaming' };
    },
    // Stops the running turn (its own reply never arrives in these tests: scripted turns that hang).
    'session.interrupt': p => { setTimeout(() => emit('message.complete', p.session_id, { text: '', status: 'interrupted' }), 5); return { ok: true }; },
    'session.history': p => ({ messages: (byStored(p.session_id)?.prompts ?? []).map(t => ({ role: 'user', text: t })) }),
  };
  wss.on('connection', ws => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', session_id: '', payload: {} } }));
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.id == null || !m.method) return;
      try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: (methods[m.method] ?? (() => ({})))(m.params ?? {}) })); }
      catch (e: any) { ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message ?? String(e) } })); }
    });
  });
  const port = () => (wss.address() as { port: number }).port;
  // Drop a runtime session the way Hermes' orphan reaper does (the stored session survives).
  const reap = (live: string) => { sessions.delete(live); };
  const prompts = (storedId: string) => byStored(storedId)?.prompts ?? [];
  return { port, reap, prompts, close: () => new Promise<void>(r => { for (const s of sockets) s.terminate(); wss.close(() => r()); }) };
}
