// Gibbous orchestration: threads (Hermes sessions bound to a workspace), tasks, run queue, review loop, planner.
// Gibbous's own Hermes connection attaches to every thread, so it sees turn ends and owns server→client
// requests (approvals, clarify, …) whether or not a browser is open.
import { openingMessage, cleanTitle, SHORT_TITLE_PROMPT } from './titles.ts';
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { HermesClient, restGet, type Backend } from './hermes.ts';
import { state, save, newId, type Thread, type Task, type Project, type ThreadRole, type Playbook, type PlanDraft } from './store.ts';
import { BUILTIN_PLAYBOOKS, reviewPrompt, workerPrompt, extractPlanJson } from './playbooks.ts';
import { parseCron } from './cron.ts';
import * as g from './git.ts';
import { notify } from './push.ts';

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
    this.timers.push(setInterval(() => this.tick().catch(e => console.error('[orch] tick', e)), Number(process.env.GIBBOUS_TICK_MS ?? 3000)));
  }
  private timers: NodeJS.Timeout[] = [];
  stop() { this.timers.forEach(clearInterval); for (const c of this.clients.values()) c.stop(); }

  // Every host's events and questions flow into the same thread/task state; replies go back on the same client.
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
  task(id: string) { return state.tasks.find(t => t.id === id); }
  project(id?: string) { return state.projects.find(p => p.id === id); }
  playbooks() { return [...BUILTIN_PLAYBOOKS, ...state.playbooks]; }
  playbook(id?: string): Playbook | undefined { return id ? this.playbooks().find(p => p.id === id) : undefined; }
  draft(id: string) { return state.plans.find(p => p.id === id); }
  taskUsage(t: Task) {
    const ths = state.threads.filter(x => x.taskId === t.id);
    return { tokens: ths.reduce((n, x) => n + (x.usage?.tokens ?? 0), 0), costUsd: ths.reduce((n, x) => n + (x.usage?.costUsd ?? 0), 0) };
  }

  private touch(t: Thread, patch: Partial<Thread>) {
    Object.assign(t, patch, { updatedAt: Date.now() });
    save();
    this.changed('thread', t);
  }
  private touchTask(t: Task, patch: Partial<Task>) {
    Object.assign(t, patch, { updatedAt: Date.now() });
    save();
    this.changed('task', t);
  }

  private async onReady(host = 'local') {
    // Re-attach anything that may still be doing work so we keep seeing its events.
    for (const t of state.threads) {
      if ((t.host ?? 'local') === host && !t.readOnly && (t.status === 'running' || t.status === 'needs_input')) {
        this.attach(t).catch(e => this.touch(t, { status: 'error', error: String(e.message ?? e) }));
      }
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
        // The turn finished while we weren't attached: replay its end so tasks/reviews/plans advance.
        if (missedEnd) {
          const h = await this.cl(t).call('session.history', { session_id: r.session_id }).catch(() => ({ messages: [] }));
          const last = [...(h.messages ?? [])].reverse().find((m: any) => m.role === 'assistant' && m.text);
          this.touch(t, { lastText: String(last?.text ?? '').slice(-4000) });
          this.afterTurn(t, !r.inflight?.error).catch(e => console.error('[orch] catch-up', e));
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
      if (ev.type === 'session.usage') { save(); this.checkBudget(t); }
    }
    if (ev.type === 'message.start') {
      if (t.status !== 'needs_input') this.touch(t, { status: 'running', error: undefined });
    } else if (ev.type === 'message.complete') {
      const ok = (ev.payload?.status ?? 'complete') === 'complete';
      this.touch(t, {
        status: ok ? 'idle' : (ev.payload?.status === 'interrupted' ? 'idle' : 'error'),
        lastText: String(ev.payload?.text ?? '').slice(-4000),
        error: ok ? undefined : String(ev.payload?.error ?? ev.payload?.status ?? 'failed'),
      });
      this.emit('turnDone', t);
      // A stop (or the interrupt before an edit/rewind) is not a task outcome; the next turn decides.
      if (ev.payload?.status !== 'interrupted') await this.afterTurn(t, ok);
    } else if (ev.type === 'error') {
      this.touch(t, { status: 'error', error: String(ev.payload?.message ?? 'error') });
      this.emit('turnDone', t);
      await this.afterTurn(t, false);
    }
  }

  // ── threads ───────────────────────────────────────────────────────────
  async createThread(o: {
    projectId?: string; title?: string; autoTitle?: boolean; prompt?: string; worktree?: boolean; base?: string;
    role?: ThreadRole; taskId?: string; cwd?: string; model?: string; provider?: string; parentId?: string; planId?: string; profile?: string; host?: string;
  }): Promise<Thread> {
    const profile = o.profile ?? (state.settings.profile || undefined);
    const host = o.host && o.host !== 'local' ? o.host : undefined;
    // Remote threads are chats on that machine: projects, worktrees and git panels are local-only.
    if (host && (o.projectId || o.worktree)) throw new Error('projects and worktrees are only available on this Mac');
    const project = this.project(o.projectId);
    const title = o.title?.trim() || 'New thread';
    let cwd = o.cwd ?? project?.path ?? (host ? '~' : process.env.HOME!);
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
      role: o.role ?? 'chat', taskId: o.taskId, parentId: o.parentId, planId: o.planId, profile, host, status: 'idle', createdAt: Date.now(), updatedAt: Date.now(),
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

  importSession(sessionId: string, title: string, o: { projectId?: string; source?: string; startedAt?: number; readOnly?: boolean; host?: string } = {}): Thread {
    const existing = state.threads.find(t => t.sessionId === sessionId && t.host === o.host);
    if (existing) return existing;
    const at = o.startedAt ?? Date.now();
    const t: Thread = {
      id: newId('th'), projectId: o.projectId, title: title || 'Imported session', sessionId, cwd: this.project(o.projectId)?.path ?? process.env.HOME!,
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

  // Call a session method; if Hermes reaped the live session (4007), re-attach once and retry.
  async withLive<T>(t: Thread, fn: (sid: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.attach(t));
    } catch (e: any) {
      if (e?.code !== 4007) throw e;
      const stale = this.live.get(t.sessionId);
      this.live.delete(t.sessionId);
      if (stale) this.byLive.delete(stale);
      return fn(await this.attach(t));
    }
  }

  async send(t: Thread, text: string) {
    this.touch(t, { status: 'running', error: undefined });
    try {
      await this.withLive(t, sid => this.cl(t).call('prompt.submit', { session_id: sid, text }));
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
    const task = t.taskId ? this.task(t.taskId) : undefined;
    if (task && task.status !== 'done' && task.status !== 'failed' && task.status !== 'backlog')
      throw new Error(`"${task.title}" still uses this thread; finish or delete the task first`);
    await this.archiveThread(t, removeWorktree).catch(() => {});
    state.threads = state.threads.filter(x => x.id !== t.id);
    save();
    this.changed('thread-deleted', { id: t.id });
  }

  // Wait until every listed thread is idle/error (or timeout). Used by the MCP `wait_for_threads` tool.
  waitIdle(ids: string[], timeoutMs: number): Promise<Thread[]> {
    const done = () => ids.every(id => { const s = this.thread(id)?.status; return !s || s === 'idle' || s === 'error' || s === 'archived'; });
    const result = () => ids.map(id => this.thread(id)).filter(Boolean) as Thread[];
    if (done()) return Promise.resolve(result());
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.off('change', check); resolve(result()); };
      const check = () => { if (done()) finish(); };
      const timer = setTimeout(finish, timeoutMs);
      this.on('change', check);
    });
  }

  // ── tasks ─────────────────────────────────────────────────────────────
  createTask(o: { projectId: string; title: string; prompt: string; deps?: string[]; worktree?: boolean; status?: Task['status']; playbookId?: string; scheduleId?: string }): Task {
    if (!this.project(o.projectId)) throw new Error('unknown project');
    const t: Task = {
      id: newId('tk'), projectId: o.projectId, title: o.title, prompt: o.prompt, deps: o.deps ?? [],
      worktree: o.worktree ?? true, status: o.status ?? 'backlog', reviewRounds: 0, playbookId: o.playbookId, scheduleId: o.scheduleId,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    state.tasks.push(t);
    save();
    this.changed('task', t);
    return t;
  }

  updateTask(t: Task, patch: Partial<Pick<Task, 'title' | 'prompt' | 'deps' | 'worktree' | 'status'>>) {
    this.touchTask(t, patch);
  }

  deleteTask(t: Task) {
    state.tasks = state.tasks.filter(x => x.id !== t.id);
    for (const o of state.tasks) o.deps = o.deps.filter(d => d !== t.id);
    save();
    this.changed('task-deleted', { id: t.id });
  }

  private running() {
    return state.tasks.filter(t => t.status === 'running' || t.status === 'reviewing' || t.status === 'testing').length;
  }

  // The run queue: start queued tasks whose deps are done, up to maxConcurrent.
  private lastScheduleMinute = 0;
  private async tick() {
    if (!this.hc.ready) return;
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.lastScheduleMinute) { this.lastScheduleMinute = minute; this.fireSchedules(new Date(minute * 60_000)); }
    for (const t of state.tasks) {
      if (this.running() >= state.settings.maxConcurrent) return;
      if (t.status !== 'queued') continue;
      const deps = t.deps.map(d => this.task(d));
      if (deps.some(d => d && d.status === 'failed')) { this.touchTask(t, { status: 'failed', reviewNotes: 'a dependency failed' }); continue; }
      if (deps.some(d => d && d.status !== 'done')) continue;
      await this.startTask(t);
    }
  }

  async startTask(t: Task) {
    // A retry/re-queue starts from scratch: fresh worktree, fresh reviewer, rounds reset.
    for (const id of [t.threadId, t.reviewThreadId]) { const x = id && this.thread(id); if (x && x.status !== 'archived') this.archiveThread(x).catch(() => {}); }
    this.touchTask(t, { status: 'running', threadId: undefined, reviewThreadId: undefined, reviewRounds: 0, verdict: undefined, reviewNotes: undefined, testRuns: 0, startedAt: Date.now(), finishedAt: undefined });
    try {
      const deps = t.deps.map(d => this.task(d)).filter(Boolean) as Task[];
      const th = await this.createThread({
        projectId: t.projectId, title: t.title, worktree: t.worktree, role: 'worker', taskId: t.id,
        prompt: workerPrompt(t, deps.map(d => d.title), this.playbook(t.playbookId)),
      });
      this.touchTask(t, { threadId: th.id });
    } catch (e: any) {
      this.touchTask(t, { status: 'failed', reviewNotes: e.message ?? String(e) });
    }
  }

  private async afterTurn(th: Thread, ok: boolean) {
    const task = th.taskId ? this.task(th.taskId) : undefined;
    if (th.role === 'planner') { if (ok && !th.planned) { this.touch(th, { planned: true }); this.finishPlan(th); } return; }
    if (!task) {
      if (th.role === 'chat' || th.role === 'coordinator') notify({ kind: 'done', title: `✓ ${th.title}`, body: (th.lastText ?? '').slice(0, 180), url: `/#/t/${th.id}`, tag: `done-${th.id}` });
      return;
    }
    if (th.role === 'worker' && task.status === 'running') {
      if (!ok) { this.touchTask(task, { status: 'failed', reviewNotes: th.error }); notify({ kind: 'failure', title: `✗ ${task.title}`, body: th.error ?? 'failed', url: `/#/board/${task.projectId}` }); return; }
      if (this.reviewRounds(task) > 0) return this.startReview(task, th);
      return this.postApprove(task, th);
    } else if (th.role === 'reviewer' && task.status === 'reviewing') {
      const text = th.lastText ?? '';
      const verdict = /VERDICT:\s*APPROVE/i.test(text) ? 'approve' : 'changes';
      const notes = text.split(/VERDICT:/i)[1]?.replace(/^\s*(APPROVE|CHANGES)\s*/i, '').trim() || text.slice(-2000);
      if (verdict === 'approve') { this.touchTask(task, { verdict, reviewNotes: notes }); return this.postApprove(task, this.thread(task.threadId!) ?? th); }
      if (task.reviewRounds < this.reviewRounds(task)) {
        const worker = task.threadId ? this.thread(task.threadId) : undefined;
        if (worker) {
          this.touchTask(task, { status: 'running', verdict, reviewNotes: notes });
          await this.send(worker, `A code reviewer looked at your changes and asked for fixes:\n\n${notes}\n\nAddress every point, then stop.`);
          return;
        }
      }
      this.touchTask(task, { status: 'review', verdict, reviewNotes: notes });
      notify({ kind: 'task', title: `⚠ Needs attention: ${task.title}`, body: notes.slice(0, 180), url: `/#/board/${task.projectId}` });
    } else if (th.role === 'worker' && task.status === 'testing') {
      if (ok) return this.postApprove(task, th);
    }
  }

  private reviewRounds(task: Task) {
    const pb = this.playbook(task.playbookId);
    return pb ? pb.reviewRounds : state.settings.autoReview ? state.settings.maxReviewRounds : 0;
  }

  // After approval (or when there is no review): run the playbook's test gate, then its finish action.
  private async postApprove(task: Task, worker: Thread) {
    const pb = this.playbook(task.playbookId);
    const script = pb?.testScript ? this.project(task.projectId)?.scripts?.find(s => s.name === pb.testScript) : undefined;
    if (script) {
      this.touchTask(task, { status: 'testing' });
      const r = await runCapture(script.command, worker.cwd, 15 * 60_000);
      if (!r.ok) {
        if ((task.testRuns ?? 0) < 2) {
          this.touchTask(task, { testRuns: (task.testRuns ?? 0) + 1 });
          await this.send(worker, `The test gate \`${script.command}\` failed:\n\n\`\`\`\n${r.output}\n\`\`\`\n\nFix the failures, then stop.`);
          return;
        }
        this.touchTask(task, { status: 'review', reviewNotes: `Tests still failing after ${task.testRuns} fix attempts:\n\n${r.output.slice(-3000)}` });
        notify({ kind: 'failure', title: `✗ Tests failing: ${task.title}`, body: script.command, url: `/#/board/${task.projectId}` });
        return;
      }
    }
    this.touchTask(task, { status: 'review' });
    if (pb && pb.finish !== 'manual') {
      try { await this.mergeTask(task, pb.finish); notify({ kind: 'task', title: `✓ ${pb.finish === 'pr' ? 'PR opened' : 'Merged'}: ${task.title}`, body: task.mergedAs ?? '', url: task.mergedAs?.startsWith('http') ? task.mergedAs : `/#/board/${task.projectId}` }); return; }
      catch (e: any) { this.touchTask(task, { reviewNotes: `${task.reviewNotes ?? ''}\n\nAutomatic ${pb.finish} failed: ${e.message}`.trim() }); }
    }
    notify({ kind: 'task', title: `${task.verdict === 'approve' ? '✓ Approved' : 'Ready for review'}: ${task.title}`, body: (task.reviewNotes ?? worker.lastText ?? '').slice(0, 180), url: `/#/board/${task.projectId}` });
  }

  // Budget caps: interrupt a task's agents once its spend passes the playbook's limit.
  private checkBudget(t: Thread) {
    const task = t.taskId ? this.task(t.taskId) : undefined;
    const cap = task ? this.playbook(task.playbookId)?.budgetUsd : undefined;
    if (!task || !cap || task.status === 'failed' || task.status === 'done') return;
    const spent = this.taskUsage(task).costUsd;
    if (spent <= cap) return;
    for (const x of state.threads.filter(x => x.taskId === task.id && x.status === 'running')) this.interrupt(x).catch(() => {});
    this.touchTask(task, { status: 'failed', reviewNotes: `Stopped: spent $${spent.toFixed(2)}, over the $${cap.toFixed(2)} budget.` });
    notify({ kind: 'failure', title: `Budget reached: ${task.title}`, body: `$${spent.toFixed(2)} of $${cap.toFixed(2)}`, url: `/#/board/${task.projectId}` });
  }

  async startReview(task: Task, worker: Thread) {
    const pb = this.playbook(task.playbookId);
    const prompt = reviewPrompt(task, worker.worktree?.base, pb);
    this.touchTask(task, { status: 'reviewing', reviewRounds: task.reviewRounds + 1 });
    const existing = task.reviewThreadId ? this.thread(task.reviewThreadId) : undefined;
    try {
      if (existing) await this.send(existing, `The author addressed your previous feedback. Review again from scratch.\n\n${prompt}`);
      else {
        const rv = await this.createThread({ projectId: task.projectId, title: `Review: ${task.title}`, cwd: worker.cwd, role: 'reviewer', taskId: task.id, prompt, model: pb?.reviewer?.model || undefined, provider: pb?.reviewer?.provider || undefined });
        this.touchTask(task, { reviewThreadId: rv.id });
      }
    } catch (e: any) {
      this.touchTask(task, { status: 'review', reviewNotes: `review could not start: ${e.message}` });
    }
  }

  private merging = new Set<string>();
  async mergeTask(task: Task, mode: 'merge' | 'pr') {
    const p = this.project(task.projectId);
    const th = task.threadId ? this.thread(task.threadId) : undefined;
    if (!p || !th) throw new Error('task has no thread');
    if (task.status !== 'review') throw new Error(`task is ${task.status}, not ready to merge`);
    const busy = [th, task.reviewThreadId ? this.thread(task.reviewThreadId) : undefined].find(x => x && (x.status === 'running' || x.status === 'needs_input'));
    if (busy) throw new Error(`"${busy.title}" is still working; wait for it or stop it first`);
    if (this.merging.has(task.id)) throw new Error('already merging');
    this.merging.add(task.id);
    try { const r = await this.doMerge(task, mode, p, th); this.touchTask(task, { finishedAt: Date.now() }); return r; } finally { this.merging.delete(task.id); }
  }

  private async doMerge(task: Task, mode: 'merge' | 'pr', p: Project, th: Thread) {
    const msg = `${task.title}\n\n${task.prompt.slice(0, 2000)}\n\n(gibbous task ${task.id})`;
    if (!th.worktree) {
      await g.commitAll(th.cwd, msg);
      this.touchTask(task, { status: 'done', mergedAs: 'committed in place' });
      return task;
    }
    await g.commitAll(th.worktree.path, msg);
    if (mode === 'pr') {
      const url = await g.pushAndPr(th.worktree.path, th.worktree.branch, th.worktree.base, task.title, `${task.prompt}\n\n${task.reviewNotes ? `Review notes:\n${task.reviewNotes}\n\n` : ''}🤖 Orchestrated by Gibbous on Hermes`);
      this.touchTask(task, { status: 'done', mergedAs: url });
    } else {
      const sha = await g.mergeBranch(p.path, th.worktree.branch, th.worktree.base, `Merge ${th.worktree.branch}: ${task.title}`);
      this.touchTask(task, { status: 'done', mergedAs: sha.slice(0, 10) });
      await g.removeWorktree(p.path, th.worktree, true).catch(() => {});
      for (const id of [task.threadId, task.reviewThreadId]) { const x = id && this.thread(id); if (x) await this.archiveThread(x); }
    }
    return task;
  }

  // ── planner: goal → draft plan → (you edit) → tasks ──────────────────
  async plan(projectId: string, goal: string, playbookId?: string) {
    const pb = this.playbook(playbookId ?? this.project(projectId)?.playbookId);
    // Playbooks without a planner (e.g. "Quick fix") go straight onto the board as one queued task.
    if (pb && !pb.plan) return { task: this.createTask({ projectId, title: goal.split('\n')[0].slice(0, 80), prompt: goal, playbookId: pb.id, status: 'queued' }) };
    const prompt = `You are the planning lead for this repository (current directory). Goal:\n\n"""${goal}"""\n\n` +
      `Investigate the codebase as needed (read-only, do not modify files), then split the goal into small, independently ` +
      `implementable tasks for parallel coding agents, each working in its own git worktree. Prefer few, well-scoped tasks; ` +
      `only add dependencies when a task truly needs another merged first. Don't tell agents to commit, push or open PRs; Gibbous does that.${pb?.planPrompt ? `\n\n${pb.planPrompt}` : ''}\n\n` +
      'Reply with a short plan summary and then ONE fenced ```json block of the form ' +
      '{"tasks":[{"key":"a","title":"…","prompt":"full, self-contained instructions for the agent","deps":["other key"]}]}.';
    const draft: PlanDraft = { id: newId('pl'), projectId, goal, threadId: '', playbookId: pb?.id, status: 'drafting', tasks: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.plans.push(draft);
    const th = await this.createThread({ projectId, title: `Plan: ${goal.slice(0, 60)}`, role: 'planner', prompt, planId: draft.id });
    draft.threadId = th.id;
    save(); this.changed('plan', draft);
    return th;
  }

  private finishPlan(th: Thread) {
    const draft = th.planId ? this.draft(th.planId) : undefined;
    const text = th.lastText ?? '';
    if (!draft) return;
    try {
      const parsed = extractPlanJson(text) as { tasks: { key: string; title: string; prompt: string; deps?: string[] }[] };
      Object.assign(draft, { status: 'ready', error: undefined, summary: text.split('```json')[0].trim().slice(-2000), tasks: parsed.tasks.map(t => ({ key: String(t.key), title: t.title, prompt: t.prompt, deps: (t.deps ?? []).map(String) })), updatedAt: Date.now() });
      save(); this.changed('plan', draft);
      notify({ kind: 'plan', title: `Plan ready: ${draft.tasks.length} tasks`, body: draft.goal.slice(0, 120), url: `/#/board/${draft.projectId}` });
    } catch (e: any) {
      // Surface it on the draft (with re-plan) instead of leaving it "planning" forever.
      Object.assign(draft, { status: 'ready', error: e.message, tasks: [], updatedAt: Date.now() });
      save(); this.changed('plan', draft);
      notify({ kind: 'failure', title: 'Plan could not be read', body: e.message, url: `/#/board/${draft.projectId}` });
    }
  }

  // Turn a reviewed draft into board tasks (keys → ids for dependencies).
  acceptPlan(draft: PlanDraft, tasks = draft.tasks, queue = false) {
    const ids = new Map<string, string>();
    const made = tasks.map(x => { const t = this.createTask({ projectId: draft.projectId, title: x.title, prompt: x.prompt, playbookId: draft.playbookId, status: queue ? 'queued' : 'backlog' }); ids.set(x.key, t.id); return [t, x] as const; });
    for (const [t, x] of made) this.updateTask(t, { deps: x.deps.map(k => ids.get(k)).filter(Boolean) as string[] });
    Object.assign(draft, { status: 'accepted', tasks, updatedAt: Date.now() });
    save(); this.changed('plan', draft);
    const th = this.thread(draft.threadId);
    if (th) this.archiveThread(th).catch(() => {});
    return made.map(([t]) => t);
  }

  async replan(draft: PlanDraft, feedback: string) {
    const th = this.thread(draft.threadId);
    if (!th) throw new Error('planner thread is gone');
    Object.assign(draft, { status: 'drafting', updatedAt: Date.now() });
    this.touch(th, { planned: false });
    save(); this.changed('plan', draft);
    await this.send(th, `Revise the plan based on this feedback, and reply again with a summary and ONE fenced json block in the same format:\n\n${feedback}`);
  }

  discardPlan(draft: PlanDraft) {
    Object.assign(draft, { status: 'discarded', updatedAt: Date.now() });
    save(); this.changed('plan', draft);
    const th = this.thread(draft.threadId);
    if (th) this.archiveThread(th).catch(() => {});
  }

  // ── schedules: recurring tasks ────────────────────────────────────────
  private fireSchedules(now: Date) {
    for (const sc of state.schedules) {
      if (!sc.enabled) continue;
      let match = false;
      try { match = parseCron(sc.cron)(now); } catch { continue; }
      if (!match || (sc.lastRun && Math.floor(sc.lastRun / 60_000) === Math.floor(now.getTime() / 60_000))) continue;
      sc.lastRun = now.getTime();
      this.createTask({ projectId: sc.projectId, title: `${sc.title} · ${now.toLocaleDateString()}`, prompt: sc.prompt, playbookId: sc.playbookId, scheduleId: sc.id, status: 'queued' });
      save(); this.changed('schedule', sc);
    }
  }

  // ── maintenance: things that quietly go wrong ─────────────────────────
  maintenance() {
    const used = new Set(state.threads.filter(t => t.status !== 'archived' && t.worktree).map(t => t.worktree!.path));
    const orphans: string[] = [];
    const root = state.settings.worktreeRoot;
    for (const repo of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      for (const wt of fs.readdirSync(path.join(root, repo))) { const p = path.join(root, repo, wt); if (!used.has(p)) orphans.push(p); }
    }
    const hour = 3600_000;
    const stuck = state.tasks.filter(t => {
      if (t.status !== 'running' && t.status !== 'reviewing' && t.status !== 'testing') return false;
      const agents = state.threads.filter(x => x.taskId === t.id);
      const busy = agents.some(x => x.status === 'running' || x.status === 'needs_input');
      const idle = !busy && Date.now() - t.updatedAt > 10 * 60_000;           // nothing running, yet not advanced
      const hung = agents.some(x => x.status === 'running' && Date.now() - x.updatedAt > 2 * hour); // no events for hours
      return idle || hung;
    }).map(t => ({ id: t.id, title: t.title, status: t.status, projectId: t.projectId, idleMinutes: Math.round((Date.now() - t.updatedAt) / 60_000) }));
    return { orphans, stuck };
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
    const p: Project = { id: newId('pr'), name: name || real.split('/').pop()!, path: real, baseBranch: repo ? await g.currentBranch(real) : undefined, createdAt: Date.now() };
    state.projects.push(p);
    save();
    this.changed('project', p);
    return p;
  }
}

// Run a command, keep the last ~200 lines of output; used by the test gate.
export function runCapture(cmd: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    execFile('/bin/zsh', ['-lc', cmd], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim().split('\n').slice(-200).join('\n') });
    });
  });
}

export function runScript(script: string, cwd: string): Promise<void> {
  return new Promise(resolve => {
    const p = spawn('/bin/zsh', ['-lc', script], { cwd, stdio: 'ignore' });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}
