// Gibbous server: auth, REST, browser↔Hermes WebSocket pipe, terminals, Hermes kanban, static web app.
import http from 'node:http';
import fs from 'node:fs';
import { spaceName, assignSpace } from './spaces.ts';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ensureBackend, upstreamUrl, restGet, HermesClient, HermesMissing, type Backend } from './hermes.ts';
import { Installer, detectHermes, hermesVersion, modelState, installerCommand, manualInstallCommand, setupOs, INSTALL_DOCS, type InstallResult, type ModelState } from './setup.ts';
import { ensureRemoteBackend, closeHost, testHost } from './hosts.ts';
import { Orchestrator } from './orchestrator.ts';
import { state, save, saveNow, backup, restore, secret, newId, readJson, GIBBOUS_HOME, type Host } from './store.ts';
import * as kanban from './kanban.ts';
import { attentionCount, openHumanTask, humanTasks, addHumanTasks, patchHumanTask, removeHumanTask, completeHumanTask, taskNotifier } from './humanTasks.ts';
import { handleMcp } from './mcp.ts';
import { gatewayChat, gatewayAvailable } from './gateway.ts';
import { MESSAGING_SOURCES } from './sources.ts';
import { attachTerminal } from './pty.ts';
import { subscribe, vapidPublicKey, notify, notifications, registerApns, unregisterApns, apnsStatus, setBadgeSource, badgeChanged } from './push.ts';
import { parseDevice, validToken } from './apns.ts';
import * as g from './git.ts';
import { smoke } from './smoke.ts';
import { redact, tail } from './diagnostics.ts';
import { watchBuild } from './build.ts';
import { listSubagents } from './subagents.ts';
import { usage, parseDays } from './usage.ts';
import { sessionDirs } from './sessionDirs.ts';
import { foreignOrigins } from './foreignOrigins.ts';
import { openingMessage } from './titles.ts';
import { liveBranch, prBadges, threadPrs, refreshPrs } from './prs.ts';
import { MAX_QUEUE, MAX_TEXT as MAX_QUEUE_TEXT } from './queue.ts';
import { sys, isInside, badFolderName, downloadsDir, revealCommand, launch, mediaAllowed, serviceInfo, exitSignals, hermesHome, knownHermesBins } from './platform.ts';

const PORT = Number(process.env.GIBBOUS_PORT ?? 7878);
const DIST = path.resolve(import.meta.dirname, '../web/dist');
// A rebuild (pnpm build) is announced to open tabs, which offer a reload.
const webBuild = watchBuild(path.join(DIST, 'index.html'), id => broadcast('build', id));

// ── Hermes ──────────────────────────────────────────────────────────────
// Hermes health for the banner: version, gateway, update availability (pollHealth below).
const health: { version?: string; gatewayRunning?: boolean; updateAvailable?: boolean } = {};
let backend: Backend | undefined;
// Single-flight: concurrent callers (daemon + reconnecting browsers) must not each spawn a `hermes serve`.
// Fails fast (HermesMissing → 503) when Hermes isn't installed, so routes answer instead of hanging.
let pendingBackend: Promise<Backend> | undefined;
const getBackend = () => pendingBackend ??= ensureBackend().then(
  b => { backend = b; setSetup({ installed: true, error: undefined }); return b; },
  e => { setSetup(e instanceof HermesMissing ? { installed: false, error: undefined } : { error: (e as Error).message }); throw e; },
).finally(() => { pendingBackend = undefined; });

// First-run setup state (setup.ts): installed? which binary, version, why `hermes serve` won't start, model ready?
const setupState: { installed: boolean; bin?: string; version?: string; error?: string } & ModelState = { ...detectHermes(), configured: null };
const setupPublic = () => ({
  installed: setupState.installed || hc.ready, bin: setupState.bin, version: health.version ?? setupState.version, error: hc.ready ? undefined : setupState.error,
  configured: setupState.configured, provider: setupState.provider, model: setupState.model, freeTier: setupState.freeTier, reason: setupState.reason,
});
function setSetup(patch: Partial<typeof setupState>) {
  const before = JSON.stringify(setupPublic());
  Object.assign(setupState, patch);
  if (JSON.stringify(setupPublic()) !== before) broadcast('setup', setupPublic());
}
let versionOf = '';
function redetectHermes() {
  const d = detectHermes();
  setSetup({ installed: d.installed || !!backend, bin: d.bin });
  if (d.bin && d.bin !== versionOf) { versionOf = d.bin; hermesVersion(d.bin).then(v => setSetup({ version: v })); }
  return d;
}
if (setupState.bin) { versionOf = setupState.bin; hermesVersion(setupState.bin).then(v => setSetup({ version: v })); }

// Gibbous's own client and every browser pipe wait here until Hermes is installed and `serve` answers: missing Hermes
// is re-checked every 15s (an install from a terminal is picked up on its own), a failing `serve` backs off to 1 min.
const sleepers = new Set<() => void>();
const wakeBackend = () => { for (const w of [...sleepers]) w(); };
const nap = (ms: number) => new Promise<void>(r => { const done = () => { clearTimeout(t); sleepers.delete(done); r(); }; const t = setTimeout(done, ms); sleepers.add(done); });
let serveFailures = 0;
async function waitBackend(): Promise<Backend> {
  for (;;) {
    try { const b = await getBackend(); serveFailures = 0; return b; }
    catch (e) {
      if (e instanceof HermesMissing) { await nap(15_000); redetectHermes(); continue; }
      console.error('[hermes]', (e as Error).message);
      await nap(Math.min(60_000, 2000 * 2 ** Math.min(serveFailures++, 5)));
    }
  }
}
const hc = new HermesClient(waitBackend);

// Is a model/provider usable? Hermes' own readiness RPCs, the ones Hermes Desktop's onboarding uses.
async function checkModel(reloadEnv = false) {
  if (!hc.ready) return;
  if (reloadEnv) await hc.call('reload.env', {}, 10_000).catch(() => {}); // a key saved through /api/env reaches the gateway
  const status = await hc.call('setup.status', {}, 30_000).catch(() => null);
  const runtime = await hc.call('setup.runtime_check', {}, 30_000).catch(() => null);
  const m = modelState(status, runtime);
  setSetup({ configured: m.configured, provider: m.provider, model: m.model, freeTier: m.freeTier, reason: m.reason });
}

// The official installer, one run at a time; every line goes to open tabs, the last 500 stay for GET /api/setup/log.
const installer = new Installer();
installer.on('line', (line: string, replace: boolean) => broadcast('setupLog', { line, replace }));
installer.on('done', (r: InstallResult) => {
  let out: InstallResult = r;
  if (r.ok) {
    const d = redetectHermes();
    if (!d.installed) out = { ok: false, at: r.at, error: `The installer finished, but no hermes command turned up (looked on PATH and in ${knownHermesBins().join(', ')}).` };
    else wakeBackend();
  }
  installer.result = out;
  broadcast('setupDone', out);
});
// ~/.hermes rather than /Users/you/.hermes in setup copy.
const shortHome = (p: string) => isInside(p, sys().home) ? path.join('~', path.relative(sys().home, p)) : p;
const setupInfo = () => ({
  hermes: { ...setupPublic(), ready: hc.ready, home: hermesHome(), homeShown: shortHome(hermesHome()) },
  configured: setupState.configured, os: setupOs(),
  install: { running: installer.running, result: installer.result, command: manualInstallCommand(), docs: INSTALL_DOCS },
  serveLog: !hc.ready && setupState.error ? tail(path.join(GIBBOUS_HOME, 'hermes-serve.log'), 30).split('\n').filter(Boolean) : undefined,
});

// Hermes health for the banner: version, gateway, update availability. "Update available" comes from Hermes's own
// update check (the one the Update tab shows), hourly, and again whenever Hermes restarts or the tab checks.
let updateCheckedAt = 0;
const setHealth = (patch: Partial<typeof health>) => {
  const before = JSON.stringify(health);
  Object.assign(health, patch);
  if (JSON.stringify(health) !== before) broadcast('health', health);
};
async function pollHealth(force = false) {
  try {
    const b = backend ?? await getBackend();
    const s = await restGet(b, '/api/status');
    setHealth({ version: s.version, gatewayRunning: s.gateway_running });
    if (force || Date.now() - updateCheckedAt > 3600_000) {
      updateCheckedAt = Date.now();
      setHealth({ updateAvailable: !!(await restGet(b, '/api/hermes/update/check')).update_available });
    }
  } catch { /* banner shows hermes not ready */ }
}
setInterval(pollHealth, 300_000);

// Hourly housekeeping: archive long-idle chats (if enabled) and the once-a-month budget alert.
async function housekeeping() {
  const days = state.settings.autoArchiveDays;
  if (days > 0) {
    const cutoff = Date.now() - days * 86_400_000;
    for (const t of state.threads.filter(t => t.role === 'chat' && !t.readOnly && !t.pinned && !openHumanTask(t) && t.status === 'idle' && t.updatedAt < cutoff))
      await orch.archiveThread(t).catch(() => {});
  }
  const budget = state.settings.monthlyBudgetUsd, month = new Date().toISOString().slice(0, 7);
  if (budget > 0 && state.budgetAlerted !== month) {
    try {
      const u = await restGet(backend ?? await getBackend(), `/api/analytics/usage?days=${new Date().getDate()}`);
      const spent = (u.daily ?? []).filter((d: any) => String(d.day).startsWith(month)).reduce((n: number, d: any) => n + (d.actual_cost || d.estimated_cost || 0), 0);
      if (spent >= budget) {
        state.budgetAlerted = month; save();
        notify({ kind: 'failure', title: `Monthly budget passed: $${spent.toFixed(2)}`, body: `Hermes has spent $${spent.toFixed(2)} this month, over your $${budget.toFixed(0)} budget.`, url: '/#/settings/usage' });
      }
    } catch { /* Hermes down: next hour */ }
  }
}
setInterval(() => housekeeping().catch(e => console.error('[housekeeping]', e)), 3600_000);
setTimeout(() => housekeeping().catch(() => {}), 60_000);
setTimeout(pollHealth, 5000);
const orch = new Orchestrator(hc, getBackend);
hc.start();

// Remote Hermes hosts: one client each, backends reached through SSH tunnels.
const remote = new Map<string, { client: HermesClient; backend?: Backend }>();
function connectHost(h: Host) {
  const entry: { client: HermesClient; backend?: Backend } = { client: undefined as unknown as HermesClient };
  entry.client = new HermesClient(async () => (entry.backend = await ensureRemoteBackend(h)));
  remote.set(h.id, entry);
  orch.addClient(h.id, entry.client);
  entry.client.on('ready', () => broadcast('hosts', hostStatus()));
  entry.client.on('down', () => broadcast('hosts', hostStatus()));
  entry.client.start();
}
orch.hostBackend = id => remote.get(id)?.backend;
const hostStatus = () => state.hosts.map(h => ({ ...h, connected: !!remote.get(h.id)?.client.ready }));
for (const h of state.hosts) connectHost(h);

// ── auth ────────────────────────────────────────────────────────────────
function tailnet(): { host?: string } {
  try {
    const s = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000 }));
    return { host: String(s.Self?.DNSName ?? '').replace(/\.$/, '') };
  } catch { return {}; }
}
const ts = tailnet();
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...(process.env.GIBBOUS_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)]);
if (ts.host) { allowedHosts.add(ts.host); allowedHosts.add(`${ts.host}:${process.env.GIBBOUS_TS_PORT ?? 8444}`); }

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookie = (req: http.IncomingMessage, name: string) =>
  (req.headers.cookie ?? '').split(';').map(s => s.trim().split('=')).find(([k]) => k === name)?.[1];

function hostOk(req: http.IncomingMessage) {
  return allowedHosts.has(String(req.headers.host ?? ''));
}
// Token cookie only. Tailscale's identity header is NOT trusted: the sandboxed macOS Tailscale app can only
// proxy over loopback TCP, where any local process could forge it.
function authed(req: http.IncomingMessage) {
  const c = cookie(req, 'gibbous_auth');
  try { return !!c && eq(decodeURIComponent(c), secret.accessToken); } catch { return false; /* malformed cookie */ }
}
function setAuthCookie(req: http.IncomingMessage, res: http.ServerResponse) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gibbous_auth=${encodeURIComponent(secret.accessToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`);
}

// ── http ────────────────────────────────────────────────────────────────
class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
const need = <T>(v: T | undefined, what: string): T => { if (!v) throw new HttpError(404, `${what} not found`); return v; };

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 10 * 1024 * 1024) throw new HttpError(413, 'body too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString();
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function publicState() {
  return {
    projects: state.projects, threads: state.threads.map(t => ({ ...t, prs: threadPrs()[t.id] ?? [], pr: prBadges()[t.id] ?? null })), settings: state.settings,
    gatewayReplies: gatewayAvailable(), hosts: hostStatus(),
    requests: [...orch.requests.values()], hermes: { ready: hc.ready, port: backend?.port, ...health, ...setupPublic() },
    tailnetUrl: ts.host ? `https://${ts.host}:${process.env.GIBBOUS_TS_PORT ?? 8444}` : null,
    tailnetLogin: ts.host ? `https://${ts.host}:${process.env.GIBBOUS_TS_PORT ?? 8444}/login?token=${secret.accessToken}` : null,
    vapidPublicKey: vapidPublicKey(), apns: apnsStatus(), build: webBuild(), prs: prBadges(), threadPrs: threadPrs(),
    platform: process.platform, service: serviceInfo(), // per-OS copy in the web app ("this Mac", restart command)
  };
}

type Handler = (p: Record<string, string>, body: any, url: URL) => unknown;
const routes: [string, RegExp, string[], Handler][] = [];
function route(method: string, pattern: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push([method, re, keys, h]);
}

route('GET', '/api/state', () => publicState());

// First-run setup (setup.ts): install Hermes with the official installer, then the model step (the web talks to
// Hermes' own provider/OAuth REST through /api/hermes/*; these routes only re-check what Hermes reports).
route('GET', '/api/setup', () => setupInfo());
route('GET', '/api/setup/log', () => ({ lines: installer.lines, running: installer.running, result: installer.result }));
route('POST', '/api/setup/hermes/install', (_, b) => {
  if (installer.running) throw new HttpError(409, 'Hermes is already being installed');
  if (redetectHermes().installed && !b.reinstall) throw new HttpError(409, 'Hermes is already installed');
  installer.start(installerCommand());
  return setupInfo();
});
route('POST', '/api/setup/hermes/cancel', () => ({ cancelled: installer.cancel() }));
// "Check again" after installing by hand: look again now instead of at the next 15s tick.
route('POST', '/api/setup/hermes/check', () => { redetectHermes(); serveFailures = 0; wakeBackend(); return setupInfo(); });
// After a key/sign-in/model change: reload Hermes' env and ask it again whether a model is usable.
route('POST', '/api/setup/check', async () => { await checkModel(true); return setupInfo(); });

route('POST', '/api/spaces', (_, b) => {
  const space = { id: newId('space'), name: checkedSpaceName(b.name) };
  state.settings.spaces.push(space); save(); orch.changed('settings', state.settings); return space;
});
route('PATCH', '/api/spaces/:id', (p, b) => {
  const space = need(state.settings.spaces.find(s => s.id === p.id), 'space');
  space.name = checkedSpaceName(b.name, p.id); save(); orch.changed('settings', state.settings); return space;
});
route('DELETE', '/api/spaces/:id', p => {
  need(state.settings.spaces.find(s => s.id === p.id), 'space');
  state.settings.spaces = state.settings.spaces.filter(s => s.id !== p.id);
  for (const project of state.projects) if (project.space === p.id) { delete project.space; orch.changed('project', project); }
  save(); orch.changed('settings', state.settings); return { ok: true };
});
function checkedSpaceName(name: unknown, except?: string) {
  try { return spaceName(name, state.settings.spaces, except); } catch (e) { throw new HttpError(400, (e as Error).message); }
}

route('POST', '/api/projects', (_, b) => orch.addProject(b.path, b.name));
// Sidebar order: the given ids first, in that order; anything not listed keeps its place after them.
route('POST', '/api/projects/order', (_, b) => {
  const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : [];
  const rank = new Map(ids.map((id, i) => [id, i]));
  state.projects = [...state.projects].sort((x, y) => (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9));
  save(); orch.changed('reload'); return { ok: true };
});
route('PATCH', '/api/projects/:id', (p, b) => {
  const pr = need(orch.project(p.id), 'project');
  if ('space' in b) {
    try { assignSpace(pr, b.space, state.settings.spaces); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  for (const k of ['name', 'baseBranch', 'setupScript', 'scripts'] as const) if (k in b) (pr as any)[k] = b[k];
  if ('kanbanBoard' in b) pr.kanbanBoard = b.kanbanBoard ? kanban.slug(b.kanbanBoard) : undefined;
  save(); orch.changed('project', pr); return pr;
});
route('DELETE', '/api/projects/:id', p => {
  state.projects = state.projects.filter(x => x.id !== p.id);
  for (const t of state.threads) if (t.projectId === p.id) t.projectId = undefined;
  save(); orch.changed('reload'); return { ok: true };
});
route('GET', '/api/projects/:id/branches', async p => g.branches(need(orch.project(p.id), 'project').path));

route('POST', '/api/threads', (_, b) => orch.createThread(b));

function humanTaskChanged(t: import('./store.ts').Thread) {
  save(); orch.changed('thread', t); return t;
}
const notifyTasks = taskNotifier((t, tasks) => notify({ kind: 'input', title: tasks.length > 1 ? `Gibbous needs you · ${tasks.length} things` : 'Gibbous needs you', body: tasks.length === 1 ? tasks[0].text : tasks.map(task => task.text).join('\n'), url: `/#/t/${t.id}` }));
function agentHumanTask(t: import('./store.ts').Thread, action: import('./mcp.ts').TaskAction) {
  if ('tasks' in action) {
    const created = addHumanTasks(t, action.tasks, 'agent'); humanTaskChanged(t); notifyTasks(t, created); return created.map(task => task.id);
  }
  completeHumanTask(t, action); humanTaskChanged(t);
}
function taskMutation(id: string, mutate: (t: import('./store.ts').Thread) => unknown) {
  const t = need(orch.thread(id), 'thread');
  try { mutate(t); } catch (e) { throw new HttpError((e as Error).message === 'Task not found' ? 404 : 400, (e as Error).message); }
  return humanTaskChanged(t);
}
route('POST', '/api/threads/:id/human-tasks', (p, b) => taskMutation(p.id, t => addHumanTasks(t, [b.text], 'user')));
route('PATCH', '/api/threads/:id/human-tasks/:taskId', (p, b) => taskMutation(p.id, t => patchHumanTask(t, p.taskId, b)));
route('DELETE', '/api/threads/:id/human-tasks/:taskId', p => taskMutation(p.id, t => removeHumanTask(t, p.taskId)));
// Legacy clients edit/finish/remove only a single unambiguous open task, never the whole list.
route('PUT', '/api/threads/:id/human-task', (p, b) => taskMutation(p.id, t => {
  const open = humanTasks(t).filter(task => task.doneAt == null);
  if (open.length > 1) throw new Error('Use the task-list routes to identify a task');
  if (open.length) patchHumanTask(t, open[0].id, { text: b.text }); else addHumanTasks(t, [b.text], 'user');
}));
route('POST', '/api/threads/:id/human-task/done', p => taskMutation(p.id, t => completeHumanTask(t)));
route('DELETE', '/api/threads/:id/human-task', p => taskMutation(p.id, t => {
  const open = humanTasks(t).filter(task => task.doneAt == null);
  if (open.length !== 1) throw new Error('Use the task-list routes to identify a task');
  removeHumanTask(t, open[0].id);
}));

route('PATCH', '/api/threads/:id', (p, b) => {
  const t = need(orch.thread(p.id), 'thread');
  if (b.title && String(b.title) !== t.title) {
    t.title = String(b.title).slice(0, 200);
    t.autoTitle = undefined; // renamed by hand: Hermes' titles no longer replace it
    // Keep Hermes' own title in step (CLI, Discord lists, dashboard) for sessions Gibbous owns.
    if (!t.readOnly) orch.withLive(t, sid => orch.cl(t).call('session.title', { session_id: sid, title: t.title })).catch(() => {}); // on the thread's own host
  }
  if ('projectId' in b) t.projectId = b.projectId || undefined;
  if ('pinned' in b) t.pinned = b.pinned ? true : undefined;
  if (b.status === 'idle' && t.status === 'archived') t.status = 'idle';
  save(); orch.changed('thread', t); return t;
});
route('POST', '/api/threads/:id/attach', async p => ({ session_id: await orch.withLive(need(orch.thread(p.id), 'thread'), async sid => {
  await orch.cl(orch.thread(p.id)!).call('session.status', { session_id: sid }); // probes for a reaped live id, on the thread's own host
  return sid;
}) }));
route('POST', '/api/threads/:id/send', async (p, b) => { await orch.send(need(orch.thread(p.id), 'thread'), String(b.text)); return { ok: true }; });
// The prompt queue (queue.ts): messages typed while a turn runs wait here, editable, and go out one turn at a time.
const queueText = (v: unknown, what = 'text') => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${what} must be a non-empty string`);
  if (v.length > MAX_QUEUE_TEXT) throw new HttpError(413, `${what} is too long`);
  return v;
};
const queued = (p: Record<string, string>) => {
  const t = need(orch.thread(p.id), 'thread');
  if (t.readOnly) throw new HttpError(409, 'this conversation is read-only in Gibbous');
  return { t, m: p.qid ? need(t.queue?.find(x => x.id === p.qid), 'queued message') : undefined };
};
route('POST', '/api/threads/:id/queue', (p, b) => {
  const { t } = queued(p);
  if ((t.queue?.length ?? 0) >= MAX_QUEUE) throw new HttpError(409, `the queue holds at most ${MAX_QUEUE} messages`);
  return orch.enqueue(t, queueText(b.text), b.shown == null ? undefined : queueText(b.shown, 'shown'));
});
route('POST', '/api/threads/:id/queue/resume', async p => { await orch.resumeQueue(queued(p).t); return { ok: true }; });
route('POST', '/api/threads/:id/queue/reorder', (p, b) => {
  if (!Array.isArray(b.ids)) throw new HttpError(400, 'ids must be a list');
  orch.reorderQueued(queued(p).t, b.ids.map(String)); return { ok: true };
});
route('PATCH', '/api/threads/:id/queue/:qid', (p, b) => { const { t, m } = queued(p); orch.editQueued(t, m!.id, queueText(b.text), b.shown == null ? undefined : queueText(b.shown, 'shown')); return { ok: true }; });
route('DELETE', '/api/threads/:id/queue/:qid', p => { const { t, m } = queued(p); orch.removeQueued(t, m!.id); return { ok: true }; });
route('POST', '/api/threads/:id/queue/:qid/now', async p => { const { t, m } = queued(p); await orch.sendQueuedNow(t, m!.id); return { ok: true }; });
route('POST', '/api/threads/:id/interrupt', async p => { await orch.interrupt(need(orch.thread(p.id), 'thread')); return { ok: true }; });
route('POST', '/api/threads/:id/archive', async (p, b) => { await orch.archiveThread(need(orch.thread(p.id), 'thread'), !!b.removeWorktree); return { ok: true }; });
route('DELETE', '/api/threads/:id', async (p, _, u) => { await orch.deleteThread(need(orch.thread(p.id), 'thread'), u.searchParams.get('removeWorktree') === '1'); return { ok: true }; });
// Each local Hermes session's folder (session.list has none), so the import picker can group by project.
route('GET', '/api/sessions/dirs', () => sessionDirs(state.settings.profile || undefined));
// Which app ran each Claude Code / Codex session (Codex Desktop, CLI, T3 Code…), keyed by Hermes' foreign handle.
route('GET', '/api/sessions/origins', () => foreignOrigins());
route('POST', '/api/import', (_, b) => orch.importSession(String(b.sessionId), String(b.title ?? ''), { projectId: b.projectId, source: b.source, startedAt: b.startedAt, readOnly: b.readOnly !== false, host: b.host && state.hosts.some(h => h.id === b.host) ? b.host : undefined }));
// Machines on your tailnet, so adding a remote Hermes is a pick instead of typing a hostname.
route('GET', '/api/tailnet/peers', () => {
  try {
    const s = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000 }));
    return Object.values<any>(s.Peer ?? {}).filter(p => p.OS === 'linux' || p.OS === 'macOS')
      .map(p => ({ name: p.HostName, dns: String(p.DNSName ?? '').replace(/\.$/, ''), os: p.OS, online: !!p.Online })).sort((a, b) => Number(b.online) - Number(a.online));
  } catch { return []; }
});
// Re-title threads whose title is still a slice of their first message (never ones you renamed).
route('POST', '/api/threads/retitle', async (_, b) => {
  const want = Array.isArray(b.ids) ? new Set(b.ids.map(String)) : undefined;
  const out: Record<string, string | null> = {};
  for (const t of state.threads) {
    if (t.readOnly || t.host || t.status === 'archived' || (want && !want.has(t.id))) continue;
    const first = openingMessage(t.sessionId, t.profile);
    const stale = t.autoTitle || t.title.startsWith('New thread') || (!!first && first.replace(/\s+/g, ' ').startsWith(t.title.replace(/[…\s]+$/, '').replace(/\s+/g, ' ')));
    if (!stale && !want) continue;
    out[t.title] = (await orch.shortTitle(t).catch(() => undefined)) ?? null;
  }
  return out;
});
// Every subagent (delegate_task child) of this thread, live or finished; remote hosts keep their own state.db.
// Model usage (tokens, sessions, API-equivalent cost) from every Hermes state.db, grouped for Settings → Usage.
route('GET', '/api/usage', (_, __, u) => usage(parseDays(u.searchParams.get('days')), state.threads.filter(t => !t.host).map(t => ({ id: t.id, title: t.title, sessionId: t.sessionId }))));
route('GET', '/api/threads/:id/subagents', p => { const t = need(orch.thread(p.id), 'thread'); return { subagents: t.host ? [] : listSubagents(t.sessionId, t.profile) }; });
route('GET', '/api/threads/:id/history', (p, _, u) => {
  const n = (k: string) => { const v = u.searchParams.get(k); return v == null || v === '' ? undefined : Number(v) || 0; };
  return orch.history(need(orch.thread(p.id), 'thread'), { offset: n('offset'), limit: n('limit'), before: n('before') });
});
route('GET', '/api/threads/:id/transcript', (p, _, u) => orch.transcript(need(orch.thread(p.id), 'thread'), Number(u.searchParams.get('offset') ?? 0) || 0));
route('POST', '/api/threads/:id/continue', p => orch.continueThread(need(orch.thread(p.id), 'thread')));
// Reply to a gateway-owned conversation (Discord, Telegram…): the gateway runs the turn on its own session.
route('POST', '/api/threads/:id/reply', async (p, b) => {
  const t = need(orch.thread(p.id), 'thread');
  if (!t.readOnly || !MESSAGING_SOURCES.has(t.source ?? '')) throw new HttpError(400, 'only messaging-platform conversations reply through the gateway');
  const r = await gatewayChat(t.sessionId, String(b.text ?? ''));
  t.updatedAt = Date.now(); save(); orch.changed('thread', t);
  return r;
});
route('GET', '/api/backup', () => backup());
route('POST', '/api/restore', (_, b) => { restore(b); broadcast('reload', null); return { ok: true }; });
route('GET', '/api/diagnostics', () => {
  const pkg = readJson<{ version?: string }>(path.join(import.meta.dirname, '../package.json'), {});
  const bundle = {
    gibbous: pkg.version, node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, uptimeMin: Math.round(process.uptime() / 60),
    hermes: { ready: hc.ready, ...health }, hosts: hostStatus().map(h => ({ name: h.name, connected: h.connected })),
    counts: { projects: state.projects.length, threads: state.threads.length, pushDevices: state.push.subs.length, apnsDevices: state.push.apns.length },
    stateBytes: fs.statSync(path.join(GIBBOUS_HOME, 'state.json'), { throwIfNoEntry: false })?.size ?? 0,
    settings: state.settings,
    logs: { gibbous: tail(path.join(GIBBOUS_HOME, 'gibbous.log')), hermesServe: tail(path.join(GIBBOUS_HOME, 'hermes-serve.log'), 60) },
  };
  return { text: redact(JSON.stringify(bundle, null, 2), [secret.accessToken, backend?.token ?? '']) };
});
route('GET', '/api/smoke', async () => smoke(hc, backend ?? await getBackend()));
route('POST', '/api/sync', async () => ({ added: await orch.syncSources(5000) }));
// Full-text search over every Hermes session (FTS in state.db, read-only).
route('GET', '/api/search', async (_, __, u) => {
  const q = (u.searchParams.get('q') ?? '').trim();
  if (!q) return { results: [] };
  return restGet(backend ?? await getBackend(), `/api/sessions/search?q=${encodeURIComponent(q)}&limit=60`);
});


// Workspace (git + files) — all scoped to the thread's cwd.
const thr = (id: string) => need(orch.thread(id), 'thread');
route('GET', '/api/threads/:id/changes', async p => {
  const t = thr(p.id);
  if (!await g.isRepo(t.cwd)) return { repo: false, files: [] };
  return { repo: true, branch: await g.currentBranch(t.cwd).catch(() => ''), base: t.worktree?.base, files: await g.changes(t.cwd, t.worktree?.base) };
});
route('GET', '/api/threads/:id/diff', async (p, _, u) => {
  const t = thr(p.id);
  const file = u.searchParams.get('file');
  if (!await g.isRepo(t.cwd)) return { diff: '' };
  return { diff: file ? await g.fileDiff(t.cwd, file, t.worktree?.base) : await g.fullDiff(t.cwd, t.worktree?.base) };
});
route('POST', '/api/threads/:id/revert', async (p, b) => { await g.revertFile(thr(p.id).cwd, String(b.file)); return { ok: true }; });
route('POST', '/api/threads/:id/commit', async (p, b) => ({ committed: await g.commitAll(thr(p.id).cwd, String(b.message || 'Changes from Gibbous')) }));
route('POST', '/api/threads/:id/pr', async (p, b) => {
  const t = thr(p.id);
  if (!t.worktree) throw new HttpError(400, 'PRs need a worktree thread');
  await g.commitAll(t.cwd, String(b.message || t.title));
  const url = await g.pushAndPr(t.cwd, await liveBranch(t.cwd, t.worktree.branch), t.worktree.base, t.title, String(b.body ?? '🤖 Made with Gibbous on Hermes'));
  pollPrs();
  return { url };
});
route('GET', '/api/projects/:id/scripts/detect', p => g.detectScripts(need(orch.project(p.id), 'project').path));
route('POST', '/api/threads/:id/file', (p, b) => {
  const f = g.safeJoin(thr(p.id).cwd, String(b.path ?? ''));
  if (typeof b.content !== 'string') throw new HttpError(400, 'content required');
  fs.writeFileSync(f, b.content);
  return { ok: true };
});
// Git toolbelt for the thread's workspace.
route('GET', '/api/threads/:id/git', async p => { const t = thr(p.id); return g.info(t.cwd, t.worktree?.base); });
route('POST', '/api/threads/:id/git', async (p, b) => {
  const t = thr(p.id);
  const act: Record<string, () => Promise<unknown>> = {
    switch: () => g.switchBranch(t.cwd, String(b.branch)), stash: () => g.stash(t.cwd), unstash: () => g.unstash(t.cwd),
    sync: () => g.syncWithBase(t.cwd, t.worktree?.base), abort: () => g.abortInProgress(t.cwd), push: () => g.git(t.cwd, 'push'),
  };
  if (!act[b.action]) throw new HttpError(400, 'unknown git action');
  try { await act[b.action](); } catch (e: any) { return { ok: false, error: e.message, info: await g.info(t.cwd, t.worktree?.base) }; }
  return { ok: true, info: await g.info(t.cwd, t.worktree?.base) };
});
route('GET', '/api/threads/:id/pr', async p => { const t = thr(p.id); return { prs: threadPrs()[t.id] ?? [], pr: await g.prStatus(t.cwd, await g.currentBranch(t.cwd)).catch(() => null) }; });
route('POST', '/api/threads/:id/fix-ci', async p => {
  const t = thr(p.id);
  const logs = await g.failingCiLogs(t.cwd, await g.currentBranch(t.cwd));
  if (!logs) throw new HttpError(409, 'no failing CI runs found for this branch');
  await orch.send(t, `CI is failing on this branch. Here are the logs of the failing jobs:\n\n\`\`\`\n${logs.slice(-30000)}\n\`\`\`\n\nFix the cause, run the relevant checks locally, and commit the fix (don't push; the user pushes from Gibbous).`);
  return { ok: true };
});
route('GET', '/api/threads/:id/files', async p => ({ files: await g.listFiles(thr(p.id).cwd) }));
route('GET', '/api/threads/:id/file', async (p, _, u) => {
  const f = g.safeJoin(thr(p.id).cwd, u.searchParams.get('path') ?? '');
  const st = fs.statSync(f);
  if (st.size > 2 * 1024 * 1024) return { path: f, tooLarge: true, size: st.size };
  return { path: f, content: fs.readFileSync(f, 'utf8') };
});

// Hermes kanban (kanban.ts): boards, their tasks, and the few actions a person takes on a card.
const kb = async () => backend ?? await getBackend();
const kslug = (s: string) => kanban.slug(s);
route('GET', '/api/kanban/boards', async () => {
  const { boards, current, hermesProjects } = await kanban.listBoards(await kb());
  return { boards, current, matches: kanban.matchBoards(state.projects, boards, hermesProjects, kanban.realpathOr) };
});
route('GET', '/api/kanban/boards/:slug/tasks', async (p, _, u) => kanban.boardTasks(await kb(), kslug(p.slug), u.searchParams.get('archived') === '1'));
route('GET', '/api/kanban/boards/:slug/links', async p => kanban.boardLinks(kslug(p.slug)));
route('GET', '/api/kanban/boards/:slug/tasks/:id', async p => kanban.taskDetail(await kb(), kslug(p.slug), kanban.taskId(p.id)));
route('POST', '/api/kanban/boards/:slug/tasks', async (p, b) => kanban.createTask(await kb(), kslug(p.slug), b));
route('POST', '/api/kanban/boards/:slug/tasks/:id/:verb', async (p, b) => kanban.act(await kb(), kslug(p.slug), kanban.taskId(p.id), p.verb, b));

// Unified diff of two texts (config editor: "review before saving").
route('POST', '/api/diff', async (_, b) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-diff-'));
  try {
    fs.writeFileSync(path.join(dir, 'before'), String(b.a ?? '')); fs.writeFileSync(path.join(dir, 'after'), String(b.b ?? ''));
    // --no-index exits 1 when the files differ, so read stdout from the error too.
    const out = await new Promise<string>(res => execFile('git', ['diff', '--no-index', '--no-color', 'before', 'after'], { cwd: dir }, (_e, stdout) => res(stdout)));
    return { diff: out.replace(/a\/before|b\/after/g, b.name ? String(b.name) : 'config.yaml') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
// Read-only share links: a static HTML snapshot of a thread, served at /s/<id> (unguessable id, no scripts).
const SHARES = path.join(GIBBOUS_HOME, 'shares');
route('POST', '/api/shares', (_, b) => {
  if (typeof b.html !== 'string' || b.html.length > 20 * 1024 * 1024) throw new HttpError(400, 'html required (max 20 MB)');
  fs.mkdirSync(SHARES, { recursive: true, mode: 0o700 });
  const id = randomBytes(18).toString('base64url');
  fs.writeFileSync(path.join(SHARES, `${id}.html`), b.html, { mode: 0o600 });
  fs.writeFileSync(path.join(SHARES, `${id}.json`), JSON.stringify({ title: String(b.title ?? ''), threadId: b.threadId, createdAt: Date.now() }));
  return { id, path: `/s/${id}` };
});
route('GET', '/api/shares', () => (fs.existsSync(SHARES) ? fs.readdirSync(SHARES) : []).filter(f => f.endsWith('.json')).map(f => ({ id: f.slice(0, -5), ...readJson(path.join(SHARES, f), {}) })));
route('DELETE', '/api/shares/:id', p => { for (const ext of ['html', 'json']) fs.rmSync(path.join(SHARES, `${p.id.replace(/[^\w-]/g, '')}.${ext}`), { force: true }); return { ok: true }; });
route('POST', '/api/hosts', (_, b) => {
  const ssh = String(b.ssh ?? '').trim();
  if (!/^[\w.-]+(@[\w.:-]+)?$/.test(ssh)) throw new HttpError(400, 'SSH target looks like user@hostname or a ~/.ssh/config alias');
  const h: Host = { id: newId('host'), name: String(b.name || ssh), ssh, remotePort: Number(b.remotePort) || 9120, createdAt: Date.now() };
  state.hosts.push(h); save(); connectHost(h); broadcast('hosts', hostStatus()); return h;
});
route('POST', '/api/hosts/:id/test', p => testHost(need(state.hosts.find(h => h.id === p.id), 'host')));
route('DELETE', '/api/hosts/:id', p => {
  orch.removeClient(p.id); remote.delete(p.id); closeHost(p.id, true);
  state.hosts = state.hosts.filter(h => h.id !== p.id); save(); broadcast('hosts', hostStatus()); return { ok: true };
});
route('GET', '/api/maintenance', () => orch.maintenance());
route('POST', '/api/maintenance/remove', async (_, b) => { await orch.removeOrphan(String(b.path)); return orch.maintenance(); });

// Read-only transcript of any Hermes session (subagent children, linked sessions).
// ?profile= reads another profile's sessions (kanban workers run under the assignee's profile).
route('GET', '/api/sessions/:sid/transcript', async (p, _, u) => {
  const profile = u.searchParams.get('profile') ?? '';
  if (profile && !/^[\w-]{1,64}$/.test(profile)) throw new HttpError(400, 'invalid profile');
  return restGet(backend ?? await getBackend(), `/api/sessions/${encodeURIComponent(p.sid)}/messages?limit=500&order=latest${profile ? `&profile=${encodeURIComponent(profile)}` : ''}`);
});


route('POST', '/api/requests/:id/answer', (p, b) => { orch.answer(decodeURIComponent(p.id), b.result); return { ok: true }; });

route('PATCH', '/api/settings', (_, b) => {
  const s = state.settings;
  if (typeof b.model === 'string') s.model = b.model;
  if (typeof b.provider === 'string') s.provider = b.provider;
  if (typeof b.profile === 'string') s.profile = b.profile;
  if (Array.isArray(b.syncSources)) s.syncSources = b.syncSources.map(String).filter(Boolean);
  if (b.notify && typeof b.notify === 'object') for (const k of Object.keys(s.notify) as (keyof typeof s.notify)[]) if (typeof b.notify[k] === 'boolean') s.notify[k] = b.notify[k];
  if (Array.isArray(b.snippets)) s.snippets = b.snippets.filter((x: any) => x && typeof x.name === 'string' && typeof x.text === 'string' && x.name.trim())
    .slice(0, 200).map((x: any) => ({ name: x.name.trim().replace(/\s+/g, '-').slice(0, 40), text: x.text.slice(0, 20_000) }));
  if (Number.isFinite(b.autoArchiveDays)) s.autoArchiveDays = Math.max(0, Math.min(365, b.autoArchiveDays | 0));
  if (Number.isFinite(b.monthlyBudgetUsd)) s.monthlyBudgetUsd = Math.max(0, Math.min(100_000, Number(b.monthlyBudgetUsd)));
  save(); orch.changed('settings', s); return s;
});

// Gibbous.app's web view can't save a download by itself (it navigated to the file instead, with no way back), and
// this server runs on the same computer: copy the file into the Downloads folder, never overwriting.
route('POST', '/api/media/save', (_, b) => {
  const src = mediaPath(String(b.path ?? '')), dir = downloadsDir();
  const ext = path.extname(src), stem = path.basename(src, ext);
  let dest = path.join(dir, path.basename(src));
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${stem} ${n}${ext}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  return { saved: dest };
});
// Finder on macOS, Explorer on Windows/WSL, the folder via xdg-open on Linux. No file manager (a server, a container) is a
// clear error, never a crash.
route('POST', '/api/media/reveal', async (_, b) => {
  const c = revealCommand(mediaPath(String(b.path ?? '')));
  try { await launch(c); } catch (e: any) { throw new HttpError(501, e?.code === 'ENOENT' ? `No file manager here (${c.cmd} isn't installed)` : `Couldn't open a file manager: ${e?.message ?? e}`); }
  return { ok: true };
});
route('POST', '/api/push/subscribe', (_, b) => { subscribe(b); return { ok: true }; });
route('POST', '/api/push/test', () => { notify({ kind: 'input', title: 'Gibbous', body: 'Notifications work.', url: '/', test: true }); return { ok: true, apns: apnsStatus() }; });
// iOS shell device tokens (APNs). Sending needs GIBBOUS_HOME/apns.json; registering works without it.
route('GET', '/api/push/apns', () => apnsStatus());
route('POST', '/api/push/apns', (_, b) => {
  const d = parseDevice(b);
  if (!d) throw new HttpError(400, "token must be 64-200 hex chars and env 'sandbox' or 'production'");
  registerApns(d);
  return { ok: true, configured: apnsStatus().configured };
});
route('DELETE', '/api/push/apns', (_, b) => {
  if (!validToken(b?.token)) throw new HttpError(400, 'token must be 64-200 hex chars');
  return { ok: true, removed: unregisterApns(b.token) };
});

route('GET', '/api/fs/ls', (_, __, u) => {
  const dir = path.resolve(u.searchParams.get('path') || sys().home);
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })); // Finder order, not ASCII
  return { path: dir, parent: path.dirname(dir), entries, repo: fs.existsSync(path.join(dir, '.git')) };
});

// New folder from the Add project picker: one plain name inside an existing folder under $HOME.
route('POST', '/api/fs/mkdir', (_, b) => {
  const parent = path.resolve(String(b?.path ?? '')), name = String(b?.name ?? '').trim();
  if (badFolderName(name)) throw new HttpError(400, 'Use a plain folder name');
  if (!isInside(parent, sys().home)) throw new HttpError(400, 'Folders can only be made inside your home folder');
  const dir = path.join(parent, name);
  if (fs.existsSync(dir)) throw new HttpError(409, `${name} already exists`);
  fs.mkdirSync(dir);
  return { path: dir };
});

// Images referenced by conversations (attachments, generated images, screenshots): image files under $HOME only.
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
function serveImage(u: URL, res: http.ServerResponse) {
  const p = path.resolve(u.searchParams.get('path') ?? '');
  const type = IMAGE_MIME[path.extname(p).toLowerCase()];
  if (!type || !isInside(p, sys().home) || !fs.existsSync(p)) throw new HttpError(404, 'image not found');
  // SVG can carry script: serve it sandboxed.
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) });
  fs.createReadStream(p).pipe(res);
}

// Files agents hand you (MEDIA:/path lines) and attachments: anything under your home folder except hidden folders
// (~/.ssh…), ~/.hermes excepted since that's where attachments live. Range requests so Safari can play and seek video.
const MEDIA_MIME: Record<string, string> = { ...IMAGE_MIME, '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.zip': 'application/zip' };
// A file the agent handed over (MEDIA:): inside your home folder, not in a hidden folder other than ~/.hermes.
function mediaPath(raw: string) {
  const p = path.resolve(raw);
  if (!mediaAllowed(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new HttpError(404, 'file not found');
  return p;
}
function serveMedia(u: URL, req: http.IncomingMessage, res: http.ServerResponse) {
  const p = mediaPath(u.searchParams.get('path') ?? '');
  const size = fs.statSync(p).size, type = MEDIA_MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
  const disposition = `${u.searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`;
  // Only media renders inline; anything else (HTML, SVG-as-file…) downloads, so nothing from disk runs in the app's origin.
  const safe = /^(image\/(?!svg)|video\/|audio\/|application\/pdf|text\/plain|text\/csv)/.test(type) ? disposition : disposition.replace(/^inline/, 'attachment');
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const head = { 'Content-Type': type, 'Content-Disposition': safe, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2])), end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(p, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...head, 'Content-Length': size });
    fs.createReadStream(p).pipe(res);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
function serveStatic(u: URL, res: http.ServerResponse) {
  let f = path.join(DIST, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  const missing = !f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory();
  // A missing build file is a 404, never the app shell: HTML served as a script is what breaks stale tabs.
  if (missing && u.pathname.startsWith('/assets/')) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
  if (missing) f = path.join(DIST, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(503).end('web app not built: run `pnpm build`'); return; }
  const ext = path.extname(f);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': u.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(f).pipe(res);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  let u = new URL('http://x/');
  try {
    u = new URL(req.url ?? '/', 'http://x');
    if (!hostOk(req)) throw new HttpError(421, 'host not allowed');
    if (u.pathname === '/mcp') {
      if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request');
      return await handleMcp(req, res, () => readBody(req), agentHumanTask);
    }
    if (u.pathname === '/login') {
      const t = u.searchParams.get('token') ?? '';
      if (!eq(t, secret.accessToken)) throw new HttpError(401, 'bad token');
      setAuthCookie(req, res);
      const next = u.searchParams.get('next') ?? '';
      res.writeHead(302, { Location: /^#\/[\w/?=&%.~-]*$/.test(next) ? `/${next}` : '/' }).end();
      return;
    }
    if (u.pathname === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (!eq(String(b.token ?? ''), secret.accessToken)) throw new HttpError(401, 'bad token');
      setAuthCookie(req, res);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (u.pathname.startsWith('/s/')) {
      const f = path.join(SHARES, `${u.pathname.slice(3).replace(/[^\w-]/g, '')}.html`);
      if (!fs.existsSync(f)) throw new HttpError(404, 'this share link was removed');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:", 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
      fs.createReadStream(f).pipe(res);
      return;
    }
    if (u.pathname === '/api/image') {
      if (!authed(req)) throw new HttpError(401, 'login required');
      return serveImage(u, res);
    }
    if (u.pathname === '/api/media') {
      if (!authed(req)) throw new HttpError(401, 'login required');
      return serveMedia(u, req, res);
    }
    if (u.pathname.startsWith('/api/')) {
      if (!authed(req)) throw new HttpError(401, 'login required');
      // CSRF: exact JSON content type forces a CORS preflight (which we never answer); plus same-origin check.
      if (req.method !== 'GET') {
        const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/json') throw new HttpError(415, 'JSON only');
        if (!sameOrigin(req)) throw new HttpError(403, 'cross-origin request');
      }
      // Hermes' own REST (skills, cron, messaging, config, analytics, updates…) behind Gibbous auth; the token stays here.
      if (u.pathname.startsWith('/api/hermes/')) return await proxyHermes(req, res, u);
      for (const [m, re, keys, h] of routes) {
        if (m !== req.method) continue;
        const match = re.exec(u.pathname);
        if (!match) continue;
        const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
        const out = await h(params, req.method === 'GET' ? {} : await readBody(req), u);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out ?? null));
        return;
      }
      throw new HttpError(404, 'no such route');
    }
    serveStatic(u, res);
  } catch (e: any) {
    const status = e instanceof HttpError || e instanceof kanban.KanbanError || e instanceof HermesMissing ? e.status : 500;
    if (status === 500) console.error('[http]', req.method, u.pathname, e);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message ?? String(e) }));
  }
}
async function proxyHermes(req: http.IncomingMessage, res: http.ServerResponse, u: URL) {
  // ?host=<id> targets a remote Hermes through its SSH tunnel; the parameter itself isn't forwarded.
  const host = u.searchParams.get('host');
  u.searchParams.delete('host');
  const b = host ? remote.get(host)?.backend : backend ?? await getBackend();
  if (!b) throw new HttpError(503, 'that host is not connected');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(await (async () => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return c; })());
  const r = await fetch(`http://127.0.0.1:${b.port}/api/${u.pathname.slice('/api/hermes/'.length)}${u.search}`, {
    method: req.method, body, signal: AbortSignal.timeout(120_000),
    headers: { 'X-Hermes-Session-Token': b.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  // The Update tab's check is the freshest answer there is: let the banner follow it.
  if (r.ok && u.pathname === '/api/hermes/hermes/update/check') { try { setHealth({ updateAvailable: !!JSON.parse(buf.toString()).update_available }); } catch { /* not JSON */ } }
  res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/json' });
  res.end(buf);
}

const sameOrigin = (req: http.IncomingMessage) => {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
};
const server = http.createServer(handle);

// ── websockets ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 384 * 1024 * 1024 });
const clients = new Set<WebSocket>();
const broadcast = (kind: string, data: unknown) => {
  const frame = JSON.stringify({ jsonrpc: '2.0', method: 'gibbous.event', params: { kind, data } });
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(frame);
};
orch.on('change', ({ kind, data }) => broadcast(kind, kind === 'requests' ? [...orch.requests.values()] : data));
setBadgeSource(() => attentionCount(orch.requests.size, state.threads));
orch.on('change', ({ kind }) => { if (['requests', 'thread', 'reload', 'thread-deleted'].includes(kind)) badgeChanged(); });

// Sidebar PR + CI badges: poll gh every minute, push only when something changed.
const pollPrs = () => refreshPrs((b, lists) => { broadcast('prs', b); broadcast('threadPrs', lists); }).catch(e => console.error('[prs]', e));
setTimeout(pollPrs, 3000);
setInterval(pollPrs, 60_000);
setInterval(() => orch.reconcileRunning().catch(e => console.error('[reconcile]', e)), 30_000);
notifications.on('notify', n => broadcast('notify', n));
hc.on('ready', () => { broadcast('hermes', { ready: true }); pollHealth(true); setSetup({ installed: true, error: undefined }); checkModel(); }); // after `hermes update`, serve restarts
hc.on('down', () => broadcast('hermes', { ready: false }));

function upgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
  let u: URL;
  try { u = new URL(req.url ?? '/', 'http://x'); } catch { socket.destroy(); return; }
  if (!hostOk(req) || !sameOrigin(req) || !authed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, client => {
    if (u.pathname === '/pty') {
      const t = orch.thread(u.searchParams.get('thread') ?? '');
      const cwd = t?.cwd ?? sys().home;
      // name: "shell" (default), "shell-2"…, or "script:<name>" which runs the project's named script.
      const name = u.searchParams.get('name') || 'shell';
      const script = name.startsWith('script:') ? orch.project(t?.projectId)?.scripts?.find(s => s.name === name.slice(7)) : undefined;
      if (name.startsWith('script:') && !script) return client.close(4404, 'unknown script');
      return attachTerminal(client, `${t?.id ?? 'home'}:${name}`, cwd, script?.command);
    }
    if (u.pathname === '/ws') return pipe(client, u.searchParams.get('host') || undefined);
    client.close(4404, 'no such socket');
  });
}
server.on('upgrade', upgrade);

// Each browser socket gets its own upstream Hermes socket: frames pass through verbatim, Gibbous events are mixed in.
async function pipe(client: WebSocket, host?: string) {
  clients.add(client);
  const queue: string[] = [];
  let up: WebSocket | undefined;
  client.on('message', raw => {
    const s = raw.toString();
    if (up?.readyState === WebSocket.OPEN) up.send(s); else queue.push(s);
  });
  client.on('close', () => { clients.delete(client); up?.close(); });
  try {
    const r = host ? remote.get(host) : undefined;
    if (host && !r) { client.close(4404, 'unknown host'); return; }
    // No Hermes yet (first run): the socket stays open for Gibbous events (setup log) and connects once Hermes is up.
    const b = r ? r.backend ?? await ensureRemoteBackend(state.hosts.find(h => h.id === host)!) : backend ?? await waitBackend();
    if (client.readyState !== WebSocket.OPEN) return; // browser left while we waited
    up = new WebSocket(upstreamUrl(b), { maxPayload: 384 * 1024 * 1024 });
  } catch { client.close(1011, 'hermes unavailable'); return; }
  up.on('open', () => { for (const s of queue.splice(0)) up!.send(s); });
  up.on('message', raw => { if (client.readyState === WebSocket.OPEN) client.send(raw.toString()); });
  up.on('close', () => client.close(1012, 'hermes restarted'));
  up.on('error', () => client.close(1011, 'hermes unavailable'));
}

for (const sig of exitSignals()) process.on(sig, () => { saveNow(); process.exit(0); });

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORT}/login?token=${secret.accessToken}`;
  fs.writeFileSync(path.join(GIBBOUS_HOME, 'login-url'), link + '\n', { mode: 0o600 });
  console.log(`Gibbous on http://127.0.0.1:${PORT}\n  login: ${link}${ts.host ? `\n  tailnet: https://${ts.host}:${process.env.GIBBOUS_TS_PORT ?? 8444} (run scripts/tailscale.sh once)` : ''}`);
});
