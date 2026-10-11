// Gibbous's own state: one JSON file, loaded in memory, saved atomically.
// ponytail: whole-file rewrite on every change; move to SQLite if this grows past a few MB.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { QueueItem } from './queue.ts';
import { gibbousHome, sys } from './platform.ts';

export const GIBBOUS_HOME = gibbousHome();
// Migration from the project's working name (~/.phoebe): move the folder, rewrite absolute paths in state.
const LEGACY_HOME = path.join(sys().home, '.phoebe');
if (!process.env.GIBBOUS_HOME && fs.existsSync(LEGACY_HOME) && !fs.existsSync(path.join(GIBBOUS_HOME, 'state.json'))) {
  fs.rmSync(GIBBOUS_HOME, { recursive: true, force: true }); // only an empty/fresh folder can be here
  fs.renameSync(LEGACY_HOME, GIBBOUS_HOME);
}
{
  const f = path.join(GIBBOUS_HOME, 'state.json');
  const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const old = JSON.stringify(LEGACY_HOME + path.sep).slice(1, -1), now = JSON.stringify(GIBBOUS_HOME + path.sep).slice(1, -1); // as escaped inside JSON (Windows backslashes)
  if (raw.includes(old)) fs.writeFileSync(f, raw.split(old).join(now), { mode: 0o600 });
}
fs.mkdirSync(GIBBOUS_HOME, { recursive: true, mode: 0o700 });

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;

export interface Project {
  id: string; name: string; path: string;
  baseBranch?: string;          // default: repo's current branch at add time
  setupScript?: string;         // runs in every new worktree
  scripts?: { name: string; command: string }[];
  kanbanBoard?: string;         // Hermes kanban board slug picked by hand; unset = matched by workdir (kanban.ts)
  createdAt: number;
}

export interface Usage { tokens: number; costUsd: number }

// Another machine running Hermes, reached over SSH (see hosts.ts).
export interface Host { id: string; name: string; ssh: string; remotePort: number; createdAt: number }

export type ThreadStatus = 'idle' | 'running' | 'needs_input' | 'error' | 'archived';
// Only chats now: work orchestration lives in Hermes' kanban, not here.
export type ThreadRole = 'chat';

export interface Thread {
  id: string; projectId?: string; title: string;
  autoTitle?: boolean;          // title is a placeholder from the first message; Hermes' AI title replaces it until renamed
  sessionId: string;            // Hermes durable (stored) session id
  cwd: string;
  worktree?: { path: string; branch: string; base: string };
  role: ThreadRole;
  profile?: string;             // Hermes profile the session runs under (default profile when unset)
  host?: string;                // Host id when the session lives on another machine (unset = this Mac)
  usage?: Usage;                // latest cumulative session usage
  // Imported from another surface (Discord, Telegram, CLI, Paseo, cron…). Another process owns that
  // session, so Gibbous only reads it; "Continue in Gibbous" copies it into a thread Gibbous owns.
  source?: string; readOnly?: boolean;
  pinned?: boolean;                     // shown at the top of the sidebar
  // Prompts typed while a turn runs (queue.ts): the server sends the head when a turn ends. A Stop pauses the line.
  queue?: QueueItem[]; queuePaused?: boolean;
  status: ThreadStatus; lastText?: string; error?: string;
  createdAt: number; updatedAt: number;
}

export type NotifyKind = 'input' | 'done' | 'failure';

export interface Settings {
  model: string;                // '' = Hermes default
  provider: string;
  profile: string;              // '' = default Hermes profile for new threads
  worktreeRoot: string;
  syncSources: string[];        // Hermes session sources mirrored into the sidebar automatically (e.g. discord)
  notify: Record<NotifyKind, boolean>; // which events push to devices
  snippets: { name: string; text: string }[];   // saved prompts, inserted with ;name in any composer
  autoArchiveDays: number;      // 0 = never; idle chat threads older than this archive themselves
  monthlyBudgetUsd: number;     // 0 = no alert; notify once a month when Hermes spend crosses it
}

export interface State {
  projects: Project[]; threads: Thread[]; hosts: Host[];
  settings: Settings;
  // subs: Web Push (PWA/browsers); apns: iOS shell device tokens (apns.ts).
  push: { vapid?: { publicKey: string; privateKey: string }; subs: any[]; apns: { token: string; env: 'sandbox' | 'production'; at: number }[] };
  budgetAlerted?: string;   // 'YYYY-MM' the monthly budget alert last fired for
}

const FILE = path.join(GIBBOUS_HOME, 'state.json');
const defaultSettings = (): Settings => ({ model: '', provider: '', profile: '', worktreeRoot: path.join(GIBBOUS_HOME, 'worktrees'), syncSources: [], notify: { input: true, done: true, failure: true }, snippets: [], autoArchiveDays: 0, monthlyBudgetUsd: 0 });

// Gibbous used to run its own task board (tasks, plans, playbooks, board schedules, coordinator/worker threads).
// That moved to Hermes' kanban: drop those keys and turn every leftover agent thread into a plain chat, keeping
// everything else (projects, threads, hosts, push keys, unknown future keys) untouched.
export function migrate(raw: any): State {
  const { tasks: _t, plans: _p, playbooks: _pb, schedules: _s, ...rest } = raw ?? {};
  const { maxConcurrent: _m, autoReview: _a, maxReviewRounds: _r, notify, ...settings } = rest.settings ?? {};
  const keep = <K extends string>(o: any, keys: readonly K[]) => Object.fromEntries(keys.filter(k => typeof o?.[k] === 'boolean').map(k => [k, o[k]]));
  return {
    ...rest,
    projects: (rest.projects ?? []).map(({ playbookId: _, ...p }: any) => p),
    threads: (rest.threads ?? []).map(({ taskId: _a, planId: _b, planned: _c, parentId: _d, queue, ...t }: any) => ({
      ...t, role: 'chat',
      ...(Array.isArray(queue) && queue.length ? { queue: queue.filter((m: any) => typeof m?.id === 'string' && typeof m?.text === 'string').map((m: any) => ({ id: m.id, text: m.text, shown: typeof m.shown === 'string' ? m.shown : m.text, at: Number(m.at) || 0 })) } : {}),
    })),
    hosts: rest.hosts ?? [],
    settings: { ...defaultSettings(), ...settings, notify: { ...defaultSettings().notify, ...keep(notify, ['input', 'done', 'failure'] as const) } },
    push: { subs: [], ...rest.push, apns: (Array.isArray(rest.push?.apns) ? rest.push.apns : []).filter((d: any) => typeof d?.token === 'string' && (d.env === 'sandbox' || d.env === 'production')) },
  };
}

const loaded = readJson<any>(FILE, {});
export const state: State = migrate(loaded);

let timer: NodeJS.Timeout | undefined;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => { try { writeJsonAtomic(FILE, state); } catch (e) { console.error('[store] save failed', e); } }, 100);
}
export function saveNow() { clearTimeout(timer); writeJsonAtomic(FILE, state); }
// Rewrite the file once when it still holds the old task board, so the dropped keys don't linger on disk.
if (['tasks', 'plans', 'playbooks', 'schedules'].some(k => k in loaded)) save();

// Backup/restore of everything except push keys and subscriptions (the VAPID private key stays on this machine).
export const backup = () => { const { push: _, ...rest } = state; return { gibbousBackup: 1, at: Date.now(), ...rest }; };
export function restore(b: any) {
  const lists = ['projects', 'threads', 'hosts'] as const;
  if (b?.gibbousBackup !== 1 || lists.some(k => !Array.isArray(b[k])) || typeof b.settings !== 'object') throw new Error('not a Gibbous backup file');
  saveNow();
  fs.copyFileSync(FILE, `${FILE}.before-restore-${Date.now()}`); // the state being replaced is never lost
  const m = migrate({ ...b, push: state.push }); // older backups still carry the task board
  for (const k of lists) (state as any)[k] = m[k];
  state.settings = m.settings;
  saveNow();
}

// Secrets live apart from state so state.json can be inspected/shared safely.
const SECRET_FILE = path.join(GIBBOUS_HOME, 'secret.json');
export const secret: { accessToken: string } = readJson(SECRET_FILE, null as any) ?? (() => {
  const s = { accessToken: randomBytes(24).toString('base64url') };
  writeJsonAtomic(SECRET_FILE, s);
  return s;
})();
