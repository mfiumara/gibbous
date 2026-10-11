// Stateless Streamable HTTP: no global "current thread", no orchestration tools.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { GIBBOUS_HOME, readJson, writeJsonAtomic, state, type Thread } from './store.ts';
import { openStateDb } from './subagents.ts';
import { threadForSession } from './humanTasks.ts';

const file = path.join(GIBBOUS_HOME, 'human-task-mcp-secret.json');
export const mcpSecret: { token: string } = readJson(file, null as any) ?? (() => {
  const s = { token: randomBytes(32).toString('base64url') }; writeJsonAtomic(file, s); return s;
})();
export function authorized(header: unknown, token = mcpSecret.token) {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header), b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function resolveThread(ref: unknown, session?: string): Thread {
  if (ref != null && (typeof ref !== 'string' || !ref)) throw new Error('thread must be a thread id or your Hermes session id');
  const id = typeof ref === 'string' ? ref : session;
  if (!id) throw new Error('Pass thread: your Gibbous thread id or the HERMES_SESSION_ID from your terminal. No caller identity was supplied; refusing to guess.');
  const exact = state.threads.find(t => t.id === id);
  if (exact) return exact;
  // Each profile has an independent session store. Never attribute local sessions to remote hosts.
  for (const profile of new Set(state.threads.filter(t => !t.host).map(t => t.profile ?? ''))) {
    const candidates = state.threads.filter(t => !t.host && (t.profile ?? '') === profile);
    const direct = candidates.find(t => t.sessionId === id);
    if (direct) return direct;
    const db = openStateDb(profile || undefined);
    if (!db) continue;
    try {
      const q = db.prepare('SELECT parent_session_id FROM sessions WHERE id = ?');
      const t = threadForSession(candidates, id, sid => (q.get(sid) as { parent_session_id?: string } | undefined)?.parent_session_id);
      if (t) return t;
    } catch { /* Older/unavailable session stores cannot supply ancestry; fail closed below. */ }
  }
  throw new Error('Unknown thread or session; supply the Gibbous thread id explicitly (required for remote sessions).');
}
const description = 'Use when the user must do something by hand that you cannot (physical hardware, approvals in third-party UIs, purchases, signing in). Write one short imperative sentence. Pass thread = your Gibbous thread id; if unknown, read HERMES_SESSION_ID using your terminal and pass that value. Never guess another thread.';
const properties = { thread: { type: 'string', description: 'Your Gibbous thread id or your Hermes HERMES_SESSION_ID (including compression continuations). Required unless the transport supplies X-Hermes-Session-Id.' } };
export const tools = [
  { name: 'gibbous_request_human_task', description, inputSchema: { type: 'object', properties: { ...properties, text: { type: 'string', minLength: 1, maxLength: 1000, description: 'One short imperative sentence for the human.' } }, required: ['text'], additionalProperties: false } },
  { name: 'gibbous_complete_human_task', description: 'Mark your thread’s human task done only after the user confirms it was performed. Identify your thread as for gibbous_request_human_task.', inputSchema: { type: 'object', properties, additionalProperties: false } },
];
export async function rpc(body: any, mutate: (t: Thread, text?: unknown) => unknown, session?: string) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  if (body.id == null) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: body.id, result });
  if (body.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'gibbous', version: '1.1.0' }, instructions: description });
  if (body.method === 'ping') return reply({});
  if (body.method === 'tools/list') return reply({ tools });
  if (body.method !== 'tools/call') return { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } };
  if (!tools.some(t => t.name === body.params?.name)) return { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unknown tool' } };
  try {
    const a = body.params.arguments ?? {};
    const t = resolveThread(a.thread, session);
    if (body.params.name === 'gibbous_request_human_task' && typeof a.text !== 'string') throw new Error('text is required');
    await mutate(t, body.params.name === 'gibbous_request_human_task' ? a.text : undefined);
    return reply({ content: [{ type: 'text', text: JSON.stringify({ thread: t.id, humanTask: t.humanTask }) }] });
  } catch (e) { return reply({ isError: true, content: [{ type: 'text', text: (e as Error).message }] }); }
}
export async function handleMcp(req: IncomingMessage, res: ServerResponse, read: () => Promise<unknown>, mutate: (t: Thread, text?: unknown) => unknown) {
  if (!authorized(req.headers.authorization)) { res.writeHead(401).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
  if (String(req.headers['content-type']).split(';')[0].trim() !== 'application/json') { res.writeHead(415).end(); return; }
  const session = typeof req.headers['x-hermes-session-id'] === 'string' ? req.headers['x-hermes-session-id'] : undefined;
  const out = await rpc(await read(), mutate, session);
  if (!out) { res.writeHead(202).end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
}
