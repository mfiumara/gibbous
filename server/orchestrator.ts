// Gibbous threads: Hermes sessions bound to a workspace. Work orchestration lives in Hermes' kanban (kanban.ts).
// Gibbous's own Hermes connection attaches to every thread, so it sees turn ends and owns server→client
// requests (approvals, clarify, …) whether or not a browser is open.
import { openingMessage, cleanTitle, SHORT_TITLE_PROMPT } from './titles.ts';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { HermesClient, restGet, isStaleSession, type Backend } from './hermes.ts';
import { state, save, newId, type Thread, type Project } from './store.ts';
import * as g from './git.ts';
import { projectForSession } from './importProject.ts';
import { notify } from './push.ts';
import * as Q from './queue.ts';
import { historyPage } from './history.ts';
import { defaultShell, shellArgs, sys } from './platform.ts';

export interface OpenRequest { id: string; method: string; params: any; threadId?: string; at: number; host?: string }

export class Orchestrator extends EventEmitter {
  hc: HermesClient;                              // this Mac's Hermes
  private clients = new Map<string, HermesClient>(); // host id → client ('local' = hc)
  private live = new Map<string, string>();      // stored session id → live session id
  private byLive = new Map<string, string>();    // live session id → thread id
  private attaching = new Map<string, Promise<string>>();
  requests = new Map<string, OpenRequest>();

  private getBackend: () => Promise<Backend>;
  constructor(hc: HermesClient, getBackend: () => Promise<Backend>) {
    super();
    this.hc = hc;
    this.getBackend = getBackend;
    this.timers.push(setInterval(() => this.syncSources().catch(e => console.error('[orch] sync', e.message ?? e)), 60_000));
    hc.on('ready', () => this.syncSources(5000).catch(() => {}));
    this.addClient('local', hc);
  }
  private timers: NodeJS.Timeout[] = [];
  stop() { this.timers.forEach(clearInterval); for (const c of this.clients.values()) c.stop(); }

  // Every host's events and questions flow into the same thread state; replies go back on the same client.
  addClient(id: string, c: HermesClient) {
    this.clients.set(id, c);
    c.on('ready', () => this.onReady(id));
    c.on('down', () => {
      for (const t of state.threads) if ((t.host ?? 'local') === id) { const l = this.live.get(t.sessionId); if (l) this.byLive.delete(l); this.live.delete(t.sessionId); }
      for (const [rid, r] of this.requests) if ((r.host ?? 'local') === id) this.requests.delete(rid);
      this.changed('requests');
    });
    c.on('event', ev => this.onEvent(ev).catch(e => console.error('[orch] event', ev?.type, e)));
    c.on('request', frame => this.onRequest(frame, id));
  }
  removeClient(id: string) { this.clients.get(id)?.stop(); this.clients.delete(id); }
  cl(t: Thread | { host?: string }) {
    const c = this.clients.get(t.host ?? 'local');
    if (!c) throw new Error(`host ${t.host} is not connected`);
    return c;
  }

  // ── plumbing ──────────────────────────────────────────────────────────
  changed(kind: string, data?: unknown) { this.emit('change', { kind, data }); }

  thread(id: string) { return state.threads.find(t => t.id === id); }
  project(id?: string) { return state.projects.find(p => p.id === id); }

  touch(t: Thread, patch: Partial<Thread>) {
    Object.assign(t, patch, { updatedAt: Date.now() });
    save();
    this.changed('thread', t);
  }
  private async onReady(host = 'local') {
    // Re-attach anything that may still be doing work so we keep seeing its events.
    for (const t of state.threads) {
      if ((t.host ?? 'local') === host && !t.readOnly && (t.status === 'running' || t.status === 'needs_input')) {
        this.attach(t).catch(e => this.touch(t, { status: 'error', error: String(e.message ?? e) }));
      }
    }
  }

  // A turn can end without Gibbous seeing message.complete (a notification turn Hermes released, a dropped event).
  // The thread then said "running" forever: Waxing… and a Stop button with nothing happening. Ask Hermes now and then.
  async reconcileRunning() {
    for (const t of state.threads) {
      if (t.readOnly || t.status !== 'running' || Date.now() - t.updatedAt < 20_000 || !this.live.has(t.sessionId)) continue;
      if ([...this.requests.values()].some(r => r.threadId === t.id)) continue;
      const r = await this.cl(t).call('session.resume', { session_id: t.sessionId, omit_messages: true, ...(t.profile ? { profile: t.profile } : {}) }).catch(() => null);
      if (!r || r.running || r.open_requests?.length || t.status !== 'running') continue;
      console.log(`[orch] ${t.id}: Hermes finished the turn without telling us; marking idle`);
      this.touch(t, { status: 'idle' });
      this.emit('turnDone', t);
      this.afterTurn(t);
      this.drain(t);
    }
    // A queue left waiting on an idle thread (a turn end we never saw, a restart between turns): send its head.
    for (const t of state.threads) {
      if (t.readOnly || t.queuePaused || !t.queue?.length || (t.status !== 'idle' && t.status !== 'error') || Date.now() - t.updatedAt < 20_000) continue;
      console.log(`[orch] ${t.id}: idle with ${t.queue.length} queued; sending the next one`);
      this.drain(t);
    }
  }

  // Attach Gibbous's connection to a thread's session; returns the live session id.
  attach(t: Thread): Promise<string> {
    if (t.readOnly) return Promise.reject(new Error(`this conversation belongs to ${t.source ?? 'another Hermes surface'}; it is read-only in Gibbous`));
    const cur = this.live.get(t.sessionId);
    if (cur) return Promise.resolve(cur);
    let p = this.attaching.get(t.sessionId);
    if (!p) {
      p = this.cl(t).call('session.resume', { session_id: t.sessionId, omit_messages: true, ...(t.profile ? { profile: t.profile } : {}) }).then(async r => {
        this.live.set(t.sessionId, r.session_id);
        this.byLive.set(r.session_id, t.id);
        for (const req of r.open_requests ?? []) this.addRequest({ ...req, threadId: t.id, at: Date.now(), host: t.host });
        const missedEnd = t.status === 'running' && !r.running && !r.open_requests?.length;
        const status = (r.open_requests?.length ? 'needs_input' : r.running ? 'running' : (t.status === 'archived' ? 'archived' : t.status === 'error' ? 'error' : 'idle'));
        if (status !== t.status) this.touch(t, { status });
        // The turn finished while we weren't attached: replay its end (lastText, the "done" notification).
        if (missedEnd) {
          const h = await this.cl(t).call('session.history', { session_id: r.session_id }).catch(() => ({ messages: [] }));
          const last = [...(h.messages ?? [])].reverse().find((m: any) => m.role === 'assistant' && m.text);
          this.touch(t, { lastText: String(last?.text ?? '').slice(-4000) });
          this.afterTurn(t);
          this.drain(t);
        }
        return r.session_id as string;
      }).finally(() => this.attaching.delete(t.sessionId));
      this.attaching.set(t.sessionId, p);
    }
    return p;
  }

  liveId(t: Thread) { return this.live.get(t.sessionId); }

  private addRequest(r: OpenRequest) {
    this.requests.set(r.id, r);
    this.changed('requests');
    const t = r.threadId ? this.thread(r.threadId) : undefined;
    if (t) {
      this.touch(t, { status: 'needs_input' });
      const what = r.method === 'approval' ? `Approve: ${String(r.params?.command ?? r.params?.description ?? '').slice(0, 120)}`
        : r.method === 'clarify' ? String(r.params?.questions?.[0]?.question ?? 'Question').slice(0, 160)
        : `Needs ${r.method}`;
      notify({ kind: 'input', title: `⏸ ${t.title}`, body: what, url: `/#/t/${t.id}`, tag: `req-${t.id}` });
    }
  }

  private onRequest(frame: { id: string; method: string; params: any }, host = 'local') {
    const threadId = this.byLive.get(frame.params?.session_id);
    // Read/act bridges (terminal.read, window.read, preview.*) are desktop-only surfaces: fail fast.
    if (['terminal.read', 'window.read', 'preview.read', 'preview.act', 'tour', 'display.install.sudo'].includes(frame.method)) {
      this.clients.get(host)?.respondError(frame.id, -32601, `${frame.method} is not supported by Gibbous`);
      return;
    }
    this.addRequest({ id: frame.id, method: frame.method, params: frame.params, threadId, at: Date.now(), host: host === 'local' ? undefined : host });
  }

  answer(id: string, result: unknown) {
    const r = this.requests.get(id);
    if (!r) throw new Error('request no longer open');
    this.cl(r).respond(id, result);
    this.requests.delete(id);
    this.changed('requests');
    const t = r.threadId ? this.thread(r.threadId) : undefined;
    if (t && ![...this.requests.values()].some(x => x.threadId === t.id)) this.touch(t, { status: 'running' });
  }

  private async onEvent(ev: { type: string; session_id: string; payload: any }) {
    if (ev.type === 'request.cancel') {
      const id = ev.payload?.id;
      const r = this.requests.get(id);
      if (r) {
        this.requests.delete(id);
        this.changed('requests');
        const t = r.threadId ? this.thread(r.threadId) : undefined;
        if (t?.status === 'needs_input' && ![...this.requests.values()].some(x => x.threadId === t.id)) this.touch(t, { status: 'running' });
      }
      return;
    }
    if (ev.type === 'session.title') {
      const t = state.threads.find(x => x.sessionId === ev.payload?.session_id);
      // Hermes titles a session right away from its first message. That is our cue: show it, then replace it with a
      // short (2–4 word) title of our own, which also stops Hermes' longer model title from landing.
      if (t && ev.payload?.title && (t.autoTitle || t.title.startsWith('New thread'))) {
        this.touch(t, { title: String(ev.payload.title).slice(0, 200) });
        this.shortTitle(t, String(ev.payload.title)).catch(() => {});
      }
      return;
    }
    const tid = this.byLive.get(ev.session_id);
    const t = tid ? this.thread(tid) : undefined;
    if (!t) return;
    if ((ev.type === 'session.usage' || ev.type === 'message.complete') && ev.payload?.usage) {
      const u = ev.payload.usage;
      t.usage = { tokens: u.total ?? ((u.prompt ?? 0) + (u.completion ?? 0)), costUsd: u.cost_usd ?? t.usage?.costUsd ?? 0 };
      if (ev.type === 'session.usage') save();
    }
    if (ev.type === 'message.start') {
      this.awaitingStart.delete(t.id);
      if (t.status !== 'needs_input') this.touch(t, { status: 'running', error: undefined });
    } else if (ev.type === 'message.complete') {
      const ok = (ev.payload?.status ?? 'complete') === 'complete';
      this.touch(t, {
        status: ok ? 'idle' : (ev.payload?.status === 'interrupted' ? 'idle' : 'error'),
        lastText: String(ev.payload?.text ?? '').slice(-4000),
        error: ok ? undefined : String(ev.payload?.error ?? ev.payload?.status ?? 'failed'),
      });
      this.emit('turnDone', t);
      // A stop (or the interrupt before an edit/rewind) is not a finished turn worth a notification.
      if (ev.payload?.status !== 'interrupted') this.afterTurn(t);
      this.turnEnded(t, ev.payload?.status ?? 'complete');
    } else if (ev.type === 'error') {
      this.touch(t, { status: 'error', error: String(ev.payload?.message ?? 'error') });
      this.emit('turnDone', t);
      this.afterTurn(t);
      this.turnEnded(t, 'error');
    }
  }

  // ── the prompt queue (queue.ts) ─────────────────────────────────────────
  private sendNowAfterStop = new Set<string>(); // thread ids whose next interrupted end is our own "send now"
  private draining = new Set<string>();         // a queue send in flight
  private awaitingStart = new Map<string, number>(); // sent from the queue, Hermes hasn't started it yet (→ when)

  private turnEnded(t: Thread, status: string) {
    const sendNow = this.sendNowAfterStop.delete(t.id);
    const what = Q.onTurnEnd({ queue: t.queue, paused: t.queuePaused, sendNow }, status);
    if (what === 'pause') this.touch(t, { queuePaused: true });
    else if (what === 'send') { if (sendNow && t.queuePaused) t.queuePaused = undefined; this.drain(t); }
  }

  // Hand the head to Hermes. Only while the thread is idle, one at a time, and never twice for one turn end: a second
  // end (duplicate complete, reconcile) before Hermes started the last one we sent is ignored for 30s.
  async drain(t: Thread) {
    if (t.readOnly || t.queuePaused || !t.queue?.length || t.status === 'running' || t.status === 'needs_input' || t.status === 'archived') return;
    if (this.draining.has(t.id) || Date.now() - (this.awaitingStart.get(t.id) ?? 0) < 30_000) return;
    const [head, ...rest] = t.queue;
    this.draining.add(t.id);
    this.awaitingStart.set(t.id, Date.now());
    this.touch(t, { queue: rest.length ? rest : undefined });
    this.changed('queueSent', { threadId: t.id, id: head.id, shown: head.shown });
    try {
      // queued: if Hermes is busy after all (a turn we didn't see start), it waits instead of redirecting that turn.
      await this.send(t, head.text, { queued: true });
    } catch (e: any) {
      console.error(`[orch] ${t.id}: queued send failed`, e.message ?? e);
      this.awaitingStart.delete(t.id);
      this.touch(t, { queue: [head, ...(t.queue ?? [])], queuePaused: true }); // back in front; the user resumes
    } finally { this.draining.delete(t.id); }
  }

  // A message typed while a turn runs. Idle: it goes out now.
  async enqueue(t: Thread, text: string, shown = text): Promise<{ sent: boolean; id: string }> {
    const m: Q.QueueItem = { id: newId('q'), text, shown, at: Date.now() };
    if (t.status === 'running' || t.status === 'needs_input' || this.draining.has(t.id)) {
      this.touch(t, { queue: Q.add(t.queue, m) });
      return { sent: false, id: m.id };
    }
    this.changed('queueSent', { threadId: t.id, id: m.id, shown });
    await this.send(t, text, { queued: true });
    return { sent: true, id: m.id };
  }
  // Callers (main.ts routes) check that `qid` is still queued.
  editQueued(t: Thread, qid: string, text: string, shown?: string) { this.touch(t, { queue: Q.edit(t.queue, qid, text, shown) }); }
  removeQueued(t: Thread, qid: string) { const q = Q.remove(t.queue, qid); this.touch(t, { queue: q.length ? q : undefined, ...(q.length ? {} : { queuePaused: undefined }) }); }
  reorderQueued(t: Thread, ids: string[]) { this.touch(t, { queue: Q.reorder(t.queue, ids) }); }
  // "Send now": first in line and unpaused. A running turn is stopped and this goes out right after its end.
  async sendQueuedNow(t: Thread, qid: string) {
    this.touch(t, { queue: Q.toFront(t.queue, qid), queuePaused: undefined });
    if (t.status !== 'running' && t.status !== 'needs_input') return this.drain(t);
    this.sendNowAfterStop.add(t.id);
    try { await this.interrupt(t); } catch (e) { this.sendNowAfterStop.delete(t.id); throw e; }
  }
  async resumeQueue(t: Thread) {
    this.touch(t, { queuePaused: undefined });
    await this.drain(t);
  }

  // ── threads ───────────────────────────────────────────────────────────
  async createThread(o: {
    projectId?: string; title?: string; autoTitle?: boolean; prompt?: string; worktree?: boolean; base?: string;
    cwd?: string; model?: string; provider?: string; profile?: string; host?: string;
  }): Promise<Thread> {
    const profile = o.profile ?? (state.settings.profile || undefined);
    const host = o.host && o.host !== 'local' ? o.host : undefined;
    // Remote threads are chats on that machine: projects, worktrees and git panels are local-only.
    if (host && (o.projectId || o.worktree)) throw new Error('projects and worktrees are only available on this computer');
    const project = this.project(o.projectId);
    const title = o.title?.trim() || 'New thread';
    let cwd = o.cwd ?? project?.path ?? (host ? '~' : sys().home);
    let worktree: Thread['worktree'];
    if (o.worktree) {
      if (!project) throw new Error('worktree threads need a project');
      const base = o.base ?? project.baseBranch ?? await g.currentBranch(project.path);
      worktree = await g.addWorktree(project.path, state.settings.worktreeRoot, `${g.slug(title)}-${newId('w').slice(-4)}`, base);
      cwd = worktree.path;
      if (project.setupScript) await runScript(project.setupScript, cwd);
    }
    const model = o.model ?? state.settings.model;
    const provider = o.model ? o.provider : state.settings.provider;
    const r = await this.cl({ host }).call('session.create', {
      // A placeholder title stays out of Hermes: a set title blocks its AI title generation for the session.
      ...(host && cwd === '~' ? {} : { cwd, cwd_explicit: true }), title: title === 'New thread' || o.autoTitle ? undefined : title,
      ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(profile ? { profile } : {}),
    });
    const t: Thread = {
      id: newId('th'), projectId: project?.id, title, autoTitle: o.autoTitle || title === 'New thread' || undefined, sessionId: r.stored_session_id, cwd, worktree,
      role: 'chat', profile, host, status: 'idle', createdAt: Date.now(), updatedAt: Date.now(),
    };
    state.threads.unshift(t);
    this.live.set(t.sessionId, r.session_id);
    this.byLive.set(r.session_id, t.id);
    save();
    this.changed('thread', t);
    if (o.prompt) await this.send(t, o.prompt);
    return t;
  }

  // Adopt an existing Hermes session (from the "All sessions" list) as a Gibbous thread.
  // Adopt a session from another surface as a read-only thread. Never resumed here: its owner
  // (the Discord gateway, a CLI, Paseo…) may still be writing to it.
  private titling = new Set<string>();
  // A short AI title from the thread's opening message (fallback: Hermes' first-line title). Clears autoTitle, so a
  // later rename or Hermes title never fights it. Returns the new title, or undefined when nothing changed.
  async shortTitle(t: Thread, fallback?: string): Promise<string | undefined> {
    if (this.titling.has(t.id)) return;
    this.titling.add(t.id);
    try {
      let input = openingMessage(t.sessionId, t.profile);
      if (!input) { await new Promise(r => setTimeout(r, 1500)); input = openingMessage(t.sessionId, t.profile) ?? fallback; }
      if (!input) return;
      const r = await this.cl(t).call('llm.oneshot', { instructions: SHORT_TITLE_PROMPT, input, task: 'title_generation', max_tokens: 400, temperature: 0.2, ...(t.profile ? { profile: t.profile } : {}) });
      const title = cleanTitle(String(r?.text ?? ''));
      if (!title) return;
      t.autoTitle = undefined;
      this.touch(t, { title });
      if (!t.readOnly) this.withLive(t, sid => this.cl(t).call('session.title', { session_id: sid, title })).catch(() => {});
      return title;
    } finally { this.titling.delete(t.id); }
  }

  // Imported threads that landed loose (before imports were filed by folder, or before their project was added)
  // move into the project they ran in. Only threads that came from another tool; never ones you started here.
  fileImported() {
    let moved = 0;
    for (const t of state.threads) {
      if (!t.source || t.projectId || t.host) continue;
      const p = projectForSession(t.sessionId, state.projects, sys().home, state.settings.profile || undefined);
      if (!p) continue;
      t.projectId = p.id; if (!t.cwd || t.cwd === sys().home) t.cwd = p.path; moved++;
      this.changed('thread', t);
    }
    if (moved) save();
    return moved;
  }

  importSession(sessionId: string, title: string, o: { projectId?: string; source?: string; startedAt?: number; readOnly?: boolean; host?: string } = {}): Thread {
    const existing = state.threads.find(t => t.sessionId === sessionId && t.host === o.host);
    if (existing) return existing;
    const at = o.startedAt ?? Date.now();
    // No project picked: file it under the project it ran in (a Paseo/Claude Code worktree counts as its repo).
    const projectId = o.projectId ?? (o.host ? undefined : projectForSession(sessionId, state.projects, sys().home, state.settings.profile || undefined)?.id);
    const t: Thread = {
      id: newId('th'), projectId, title: title || 'Imported session', sessionId, cwd: this.project(projectId)?.path ?? sys().home,
      role: 'chat', status: 'idle', source: o.source, readOnly: o.readOnly ?? true, host: o.host, createdAt: at, updatedAt: at,
    };
    state.threads.unshift(t);
    save();
    this.changed('thread', t);
    return t;
  }

  // Latest page of a session's stored transcript (read-only). `offset` pages further back.
  hostBackend: (host: string) => Backend | undefined = () => undefined; // set by main: remote tunnels
  async transcript(t: Thread, offset = 0) {
    const b = t.host ? this.hostBackend(t.host) : await this.getBackend();
    if (!b) throw new Error('that host is not connected');
    return restGet<{ messages: any[]; pagination: { returned: number } }>(b, `/api/sessions/${encodeURIComponent(t.sessionId)}/messages?limit=500&order=latest&offset=${offset}`);
  }

  // A page of the thread's conversation for display (history.ts): the newest first, older ones by `offset`.
  async history(t: Thread, o: { offset?: number; limit?: number; before?: number }) {
    const b = t.host ? this.hostBackend(t.host) : await this.getBackend();
    if (!b) throw new Error('that host is not connected');
    return historyPage(b, t.sessionId, { ...o, profile: t.profile });
  }

  // Copy a read-only conversation into a new Gibbous-owned session (text turns only) and continue there.
  async continueThread(t: Thread): Promise<Thread> {
    const { messages } = await this.transcript(t);
    const seed = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.display_kind !== 'internal_notification')
      .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : (m.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') }))
      .filter(m => m.content.trim());
    // The copy lives on the same machine as the original (its cwd only makes sense there).
    const r = await this.cl(t).call('session.create', { ...(t.host ? {} : { cwd: t.cwd, cwd_explicit: true }), title: `${t.title} (continued)`, messages: seed, ...(state.settings.model ? { model: state.settings.model, provider: state.settings.provider || undefined } : {}) });
    const nt: Thread = {
      id: newId('th'), projectId: t.projectId, title: `${t.title} (continued)`, sessionId: r.stored_session_id, cwd: t.cwd,
      role: 'chat', status: 'idle', host: t.host, createdAt: Date.now(), updatedAt: Date.now(),
    };
    state.threads.unshift(nt);
    this.live.set(nt.sessionId, r.session_id);
    this.byLive.set(r.session_id, nt.id);
    save();
    this.changed('thread', nt);
    return nt;
  }

  // Mirror new sessions from the sources the user chose (e.g. Discord) into the sidebar.
  // limit: the periodic pass only scans the newest sessions; enabling a source scans all of history once.
  async syncSources(limit = 200) {
    const want = new Set(state.settings.syncSources);
    if (!want.size || !this.hc.ready) return 0;
    const { sessions } = await this.hc.call('session.list', { limit });
    let added = 0;
    for (const s of sessions as any[]) {
      if (!want.has(s.source) || state.threads.some(t => t.sessionId === s.id)) continue;
      this.importSession(s.id, s.title || String(s.preview ?? '').slice(0, 60), { source: s.source, startedAt: s.started_at ? s.started_at * 1000 : undefined });
      added++;
    }
    return added;
  }

  // Call a session method; if Hermes reaped the live session, re-attach once and retry.
  async withLive<T>(t: Thread, fn: (sid: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.attach(t));
    } catch (e: any) {
      if (!isStaleSession(e)) throw e;
      const stale = this.live.get(t.sessionId);
      this.live.delete(t.sessionId);
      if (stale) this.byLive.delete(stale);
      return fn(await this.attach(t));
    }
  }

  async send(t: Thread, text: string, o: { queued?: boolean } = {}) {
    this.touch(t, { status: 'running', error: undefined });
    try {
      await this.withLive(t, sid => this.cl(t).call('prompt.submit', { session_id: sid, text, ...(o.queued ? { queued: true } : {}) }));
    } catch (e: any) {
      this.touch(t, { status: 'error', error: e.message ?? String(e) });
      throw e;
    }
  }

  async interrupt(t: Thread) {
    await this.withLive(t, sid => this.cl(t).call('session.interrupt', { session_id: sid }));
  }

  async archiveThread(t: Thread, removeWorktree = false) {
    if (removeWorktree && t.worktree) {
      const p = this.project(t.projectId);
      if (p) await g.removeWorktree(p.path, t.worktree, false);
    }
    const sid = this.liveId(t);
    if (sid) await this.cl(t).call('session.close', { session_id: sid }).catch(() => {});
    this.live.delete(t.sessionId);
    if (sid) this.byLive.delete(sid);
    for (const [id, r] of this.requests) if (r.threadId === t.id) this.requests.delete(id);
    this.changed('requests');
    this.touch(t, { status: 'archived' });
  }

  async deleteThread(t: Thread, removeWorktree = false) {
    await this.archiveThread(t, removeWorktree).catch(() => {});
    state.threads = state.threads.filter(x => x.id !== t.id);
    save();
    this.changed('thread-deleted', { id: t.id });
  }

  // A chat turn finished: tell your devices (in-app toast, push, the Mac app).
  private afterTurn(th: Thread) {
    notify({ kind: 'done', title: `✓ ${th.title}`, body: (th.lastText ?? '').slice(0, 180), url: `/#/t/${th.id}`, tag: `done-${th.id}` });
  }

  // ── maintenance: things that quietly go wrong ─────────────────────────
  maintenance() {
    const used = new Set(state.threads.filter(t => t.status !== 'archived' && t.worktree).map(t => t.worktree!.path));
    const orphans: string[] = [];
    const root = state.settings.worktreeRoot;
    for (const repo of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      for (const wt of fs.readdirSync(path.join(root, repo))) { const p = path.join(root, repo, wt); if (!used.has(p)) orphans.push(p); }
    }
    return { orphans };
  }

  async removeOrphan(dir: string) {
    const root = path.resolve(state.settings.worktreeRoot);
    const p = path.resolve(dir);
    if (!p.startsWith(root + path.sep)) throw new Error('not a Gibbous worktree');
    if (this.maintenance().orphans.indexOf(p) < 0) throw new Error('this worktree is still in use');
    const repo = state.projects.find(pr => path.basename(pr.path) === path.basename(path.dirname(p)));
    if (repo) await g.git(repo.path, 'worktree', 'remove', '--force', p).catch(() => {});
    fs.rmSync(p, { recursive: true, force: true });
    if (repo) await g.git(repo.path, 'worktree', 'prune').catch(() => {});
  }

  // ── projects ──────────────────────────────────────────────────────────
  async addProject(dir: string, name?: string): Promise<Project> {
    const real = fs.realpathSync(dir);
    const existing = state.projects.find(p => p.path === real);
    if (existing) return existing;
    const repo = await g.isRepo(real);
    const p: Project = { id: newId('pr'), name: name || path.basename(real) || real, path: real, baseBranch: repo ? await g.currentBranch(real) : undefined, createdAt: Date.now() };
    state.projects.push(p);
    save();
    this.changed('project', p);
    return p;
  }
}

export function runScript(script: string, cwd: string): Promise<void> {
  return new Promise(resolve => {
    const shell = defaultShell(); // $SHELL (zsh/bash) login shell, PowerShell on Windows
    const p = spawn(shell, shellArgs(shell, script), { cwd, stdio: 'ignore', windowsHide: true });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}
