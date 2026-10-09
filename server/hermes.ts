// Hermes backend: supervise one `hermes serve` and talk JSON-RPC to it.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';
import { GIBBOUS_HOME, readJson, writeJsonAtomic } from './store.ts';

const BACKEND_FILE = `${GIBBOUS_HOME}/hermes-backend.json`;
const HERMES_BIN = process.env.HERMES_BIN ?? `${process.env.HOME}/.local/bin/hermes`;

export interface Backend { port: number; token: string; pid?: number }

async function alive(b: Backend): Promise<boolean> {
  try {
    // /api/config is token-checked (/api/status is not), so a stale saved token fails here, not at WS 401.
    const r = await fetch(`http://127.0.0.1:${b.port}/api/config`, {
      headers: { 'X-Hermes-Session-Token': b.token }, signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch { return false; }
}

// `serve` is spawned detached and its port/token persisted, so restarting Gibbous never kills running agents.
// Desktop mode (HERMES_DESKTOP=1 + minted token on loopback) is the only way past the dashboard's password gate.
export async function ensureBackend(port = Number(process.env.GIBBOUS_HERMES_PORT ?? 9120)): Promise<Backend> {
  const saved = readJson<Backend | null>(BACKEND_FILE, null);
  if (saved && await alive(saved)) return saved;
  const b: Backend = { port, token: randomBytes(24).toString('hex') };
  const log = fs.openSync(`${GIBBOUS_HOME}/hermes-serve.log`, 'a');
  const child = spawn(HERMES_BIN, ['serve', '--port', String(port), '--skip-build'], {
    detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, HERMES_DESKTOP: '1', HERMES_DASHBOARD_SESSION_TOKEN: b.token },
  });
  child.unref();
  b.pid = child.pid;
  for (let i = 0; i < 120; i++) {
    if (await alive(b)) { writeJsonAtomic(BACKEND_FILE, b); return b; }
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`hermes serve did not come up on :${port} (see ${GIBBOUS_HOME}/hermes-serve.log)`);
}

// Read-only REST on `hermes serve` (opens state.db read-only; safe for sessions other processes own).
export async function restGet<T = any>(b: Backend, p: string): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${b.port}${p}`, { headers: { 'X-Hermes-Session-Token': b.token }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`hermes ${p.split('?')[0]}: ${r.status}`);
  return r.json() as Promise<T>;
}

export function upstreamUrl(b: Backend) {
  return `ws://127.0.0.1:${b.port}/api/ws?token=${b.token}`;
}

export interface RpcError { code: number; message: string; data?: unknown }

// A JSON-RPC client for Gibbous's own use (orchestration, notifications). Browsers get raw pipes instead.
// Emits: 'ready', 'down', 'event' (params: {type, session_id, payload}), 'request' (frame), 'cancel'.
export class HermesClient extends EventEmitter {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: RpcError) => void }>();
  ready = false;
  private stopped = false;
  private getBackend: () => Promise<Backend>;
  constructor(getBackend: () => Promise<Backend>) {
    super();
    this.getBackend = getBackend;
  }

  async start() {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        return;
      } catch (e) {
        console.error('[hermes] connect failed:', (e as Error).message);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  private connectOnce(): Promise<void> {
    return this.getBackend().then(b => new Promise((resolve, reject) => {
      this.ws?.removeAllListeners().terminate(); // never keep two live sockets (duplicate events, lost answers)
      const ws = new WebSocket(upstreamUrl(b), { maxPayload: 512 * 1024 * 1024 });
      this.ws = ws;
      ws.on('error', reject);
      ws.on('close', () => {
        reject(new Error('closed')); // no-op once settled
        const wasReady = this.ready;
        this.ready = false;
        for (const p of this.pending.values()) p.reject({ code: -32000, message: 'hermes disconnected' });
        this.pending.clear();
        // Only a socket that was up reconnects from here; failed handshakes are retried by start()'s loop.
        if (wasReady) { this.emit('down'); if (!this.stopped) setTimeout(() => this.start(), 1000); }
      });
      ws.on('message', raw => {
        let m: any;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.id != null && !m.method) {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          m.error ? p.reject(m.error) : p.resolve(m.result);
          return;
        }
        if (m.method && m.id != null) { this.emit('request', m); return; }
        if (m.method === 'event') {
          const ev = m.params;
          if (ev?.type === 'gateway.ready') {
            this.call('client.capabilities', { server_requests: true }).then(() => {
              this.ready = true;
              this.emit('ready');
              resolve();
            }, reject);
            return;
          }
          this.emit('event', ev);
        }
      });
    }));
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject({ code: -32000, message: 'hermes not connected' });
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject({ code: -32001, message: `${method} timed out` }); }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(t); resolve(v); },
        reject: e => { clearTimeout(t); reject(e); },
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  // Answer a server→client request (approval/clarify) on behalf of a user acting through Gibbous.
  respond(id: string, result: unknown) {
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  respondError(id: string, code: number, message: string) {
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  stop() { this.stopped = true; this.ws?.close(); }
}
