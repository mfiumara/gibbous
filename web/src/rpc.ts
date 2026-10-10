// Browser side of the Hermes pipe: typed JSON-RPC over /ws, per-session event fan-out, auto-reconnect.
import { createContext, useContext } from 'react';
import type { RpcMethods } from './hermes/contract';

export type Method = keyof RpcMethods;
export type Params<M extends Method> = RpcMethods[M] extends { params: infer P } ? P : never;
export type Result<M extends Method> = RpcMethods[M] extends { result: infer R } ? R : never;
export interface HermesEvent { type: string; session_id: string; payload: any; seq?: number }
export interface RpcError { code: number; message: string; data?: unknown }

// Hermes reaped the live (runtime) session id: re-attach via session.resume on the stored id.
// Session-scoped calls answer 4001 "session not found" for a dead runtime id; resume answers 4007.
export const isStaleSession = (e: unknown) => {
  const r = e as Partial<RpcError> | undefined;
  return r?.code === 4007 || (r?.code === 4001 && /session not found/.test(String(r.message ?? '')));
};

type Listener = (ev: HermesEvent) => void;

export class Rpc {
  private host?: string;
  constructor(host?: string) { this.host = host; }
  private ws?: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: RpcError) => void }>();
  private waiters: (() => void)[] = [];
  private sessionListeners = new Map<string, Set<Listener>>();
  private readyListeners = new Set<() => void>();
  ready = false;
  onGibbous: (kind: string, data: any) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};
  private backoff = 500;

  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${this.host ? `?host=${encodeURIComponent(this.host)}` : ''}`);
    this.ws = ws;
    ws.onmessage = e => this.onFrame(JSON.parse(e.data));
    ws.onclose = () => {
      this.ready = false;
      this.onStatus(false);
      for (const p of this.pending.values()) p.reject({ code: -32000, message: 'connection lost' });
      this.pending.clear();
      this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
  }
  private retry: ReturnType<typeof setTimeout> | undefined;

  // Back from the background (iPhone app): a suspended socket can look open but be dead, and a pending retry may
  // be at the 8s backoff. Reconnect now; views re-resume their session on ready as after any reconnect.
  kick() {
    this.backoff = 500;
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; this.connect(); return; }
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) { this.connect(); return; }
    ws.close(); // onclose reconnects after 500ms
  }

  private onFrame(m: any) {
    if (m.id != null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(m.error) : p.resolve(m.result);
      return;
    }
    // Server→client requests are answered by Gibbous's server (see orchestrator); browsers ignore them.
    if (m.id != null) return;
    if (m.method === 'gibbous.event') return this.onGibbous(m.params.kind, m.params.data);
    if (m.method !== 'event') return;
    const ev = m.params as HermesEvent;
    if (ev.type === 'gateway.ready') {
      this.ready = true;
      this.backoff = 500;
      this.onStatus(true);
      for (const w of this.waiters.splice(0)) w();
      for (const l of this.readyListeners) l();
      return;
    }
    for (const l of this.sessionListeners.get(ev.session_id) ?? []) l(ev);
  }

  private whenReady() {
    return this.ready ? Promise.resolve() : new Promise<void>(r => this.waiters.push(r));
  }

  async call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    await this.whenReady();
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  onSession(sessionId: string, l: Listener) {
    let set = this.sessionListeners.get(sessionId);
    if (!set) this.sessionListeners.set(sessionId, (set = new Set()));
    set.add(l);
    return () => { set!.delete(l); };
  }

  // Fires after every (re)connect; views re-resume their session here.
  onReady(l: () => void) {
    this.readyListeners.add(l);
    return () => { this.readyListeners.delete(l); };
  }
}

export const rpc = new Rpc();

// Threads on other machines talk to that machine's Hermes through their own socket.
const remotes = new Map<string, Rpc>();
export function rpcFor(host?: string) {
  if (!host) return rpc;
  let r = remotes.get(host);
  if (!r) { r = new Rpc(host); r.onGibbous = () => {}; remotes.set(host, r); r.connect(); }
  return r;
}
export const RpcContext = createContext<Rpc>(rpc);
export const useRpc = () => useContext(RpcContext);
