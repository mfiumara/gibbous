// Gibbous's own state: one JSON file, loaded in memory, saved atomically.
// ponytail: whole-file rewrite on every change; move to SQLite if this grows past a few MB.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const GIBBOUS_HOME = process.env.GIBBOUS_HOME ?? `${process.env.HOME}/.gibbous`;
// Migration from the project's working name (~/.phoebe): move the folder, rewrite absolute paths in state.
const LEGACY_HOME = `${process.env.HOME}/.phoebe`;
if (!process.env.GIBBOUS_HOME && fs.existsSync(LEGACY_HOME) && !fs.existsSync(path.join(GIBBOUS_HOME, 'state.json'))) {
  fs.rmSync(GIBBOUS_HOME, { recursive: true, force: true }); // only an empty/fresh folder can be here
  fs.renameSync(LEGACY_HOME, GIBBOUS_HOME);
}
{
  const f = path.join(GIBBOUS_HOME, 'state.json');
  const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (raw.includes(`${LEGACY_HOME}/`)) fs.writeFileSync(f, raw.split(`${LEGACY_HOME}/`).join(`${GIBBOUS_HOME}/`), { mode: 0o600 });
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
  playbookId?: string;          // default playbook for goals in this project
  createdAt: number;
}

export interface Playbook {
  id: string; name: string; description: string; builtin?: boolean;
  plan: boolean;                // run the planner first
  planPrompt?: string;          // extra guidance for the planner
  workerNote?: string;          // appended to every task prompt
  writeTests: boolean;          // workers must add/extend tests
  reviewRounds: number;         // reviewer ↔ author loops; 0 = no review
  reviewer?: { model?: string; provider?: string }; // second-opinion model for reviews
  reviewPasses: ('correctness' | 'security' | 'tests')[];
  testScript?: string;          // project script that must pass after approval
  finish: 'manual' | 'merge' | 'pr'; // what happens once approved (and tested)
  budgetUsd?: number;           // per-task spend cap
}

export interface PlanDraft {
  id: string; projectId: string; goal: string; threadId: string; playbookId?: string;
  status: 'drafting' | 'ready' | 'accepted' | 'discarded';
  summary?: string; error?: string; tasks: { key: string; title: string; prompt: string; deps: string[] }[];
  createdAt: number; updatedAt: number;
}

export interface Schedule {
  id: string; projectId: string; title: string; prompt: string; cron: string;
  playbookId?: string; enabled: boolean; lastRun?: number; createdAt: number;
}

export interface Usage { tokens: number; costUsd: number }

// Another machine running Hermes, reached over SSH (see hosts.ts).
export interface Host { id: string; name: string; ssh: string; remotePort: number; createdAt: number }

export type ThreadStatus = 'idle' | 'running' | 'needs_input' | 'error' | 'archived';
export type ThreadRole = 'chat' | 'worker' | 'reviewer' | 'planner' | 'coordinator';

export interface Thread {
  id: string; projectId?: string; title: string;
  autoTitle?: boolean;          // title is a placeholder from the first message; Hermes' AI title replaces it until renamed
  sessionId: string;            // Hermes durable (stored) session id
  cwd: string;
  worktree?: { path: string; branch: string; base: string };
  role: ThreadRole; taskId?: string; planned?: boolean; planId?: string;
  parentId?: string;            // coordinator that spawned this thread
  profile?: string;             // Hermes profile the session runs under (default profile when unset)
  host?: string;                // Host id when the session lives on another machine (unset = this Mac)
  usage?: Usage;                // latest cumulative session usage
  // Imported from another surface (Discord, Telegram, CLI, Paseo, cron…). Another process owns that
  // session, so Gibbous only reads it; "Continue in Gibbous" copies it into a thread Gibbous owns.
  source?: string; readOnly?: boolean;
  pinned?: boolean;                     // shown at the top of the sidebar
  status: ThreadStatus; lastText?: string; error?: string;
  createdAt: number; updatedAt: number;
}

export type TaskStatus = 'backlog' | 'queued' | 'running' | 'reviewing' | 'testing' | 'review' | 'done' | 'failed';

export interface Task {
  id: string; projectId: string; title: string; prompt: string;
  status: TaskStatus; deps: string[];
  worktree: boolean; threadId?: string; reviewThreadId?: string;
  reviewRounds: number; verdict?: 'approve' | 'changes'; reviewNotes?: string;
  mergedAs?: string; createdAt: number; updatedAt: number;
  playbookId?: string; startedAt?: number; finishedAt?: number; testRuns?: number; scheduleId?: string;
}

export interface Settings {
  model: string;                // '' = Hermes default
  provider: string;
  profile: string;              // '' = default Hermes profile for new threads
  maxConcurrent: number;
  autoReview: boolean;
  maxReviewRounds: number;
  worktreeRoot: string;
  syncSources: string[];        // Hermes session sources mirrored into the sidebar automatically (e.g. discord)
  notify: Record<'input' | 'done' | 'task' | 'failure' | 'plan', boolean>; // which events push to devices
  snippets: { name: string; text: string }[];   // saved prompts, inserted with ;name in any composer
  autoArchiveDays: number;      // 0 = never; idle chat threads older than this archive themselves
  monthlyBudgetUsd: number;     // 0 = no alert; notify once a month when Hermes spend crosses it
}

export interface State {
  projects: Project[]; threads: Thread[]; tasks: Task[];
  playbooks: Playbook[]; plans: PlanDraft[]; schedules: Schedule[]; hosts: Host[];
  settings: Settings;
  push: { vapid?: { publicKey: string; privateKey: string }; subs: any[] };
  budgetAlerted?: string;   // 'YYYY-MM' the monthly budget alert last fired for
}

const FILE = path.join(GIBBOUS_HOME, 'state.json');
const defaults: State = {
  projects: [], threads: [], tasks: [], playbooks: [], plans: [], schedules: [], hosts: [],
  settings: { model: '', provider: '', profile: '', maxConcurrent: 3, autoReview: true, maxReviewRounds: 2, worktreeRoot: path.join(GIBBOUS_HOME, 'worktrees'), syncSources: [], notify: { input: true, done: true, task: true, failure: true, plan: true }, snippets: [], autoArchiveDays: 0, monthlyBudgetUsd: 0 },
  push: { subs: [] },
};

const loaded = readJson<Partial<State>>(FILE, {});
export const state: State = { ...defaults, ...loaded, settings: { ...defaults.settings, ...loaded.settings }, push: { ...defaults.push, ...loaded.push } };

let timer: NodeJS.Timeout | undefined;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => { try { writeJsonAtomic(FILE, state); } catch (e) { console.error('[store] save failed', e); } }, 100);
}
export function saveNow() { clearTimeout(timer); writeJsonAtomic(FILE, state); }

// Backup/restore of everything except push keys and subscriptions (the VAPID private key stays on this machine).
export const backup = () => { const { push: _, ...rest } = state; return { gibbousBackup: 1, at: Date.now(), ...rest }; };
export function restore(b: any) {
  const lists = ['projects', 'threads', 'tasks', 'playbooks', 'plans', 'schedules', 'hosts'] as const;
  if (b?.gibbousBackup !== 1 || lists.some(k => !Array.isArray(b[k])) || typeof b.settings !== 'object') throw new Error('not a Gibbous backup file');
  saveNow();
  fs.copyFileSync(FILE, `${FILE}.before-restore-${Date.now()}`); // the state being replaced is never lost
  for (const k of lists) state[k] = b[k];
  state.settings = { ...defaults.settings, ...b.settings };
  saveNow();
}

// Secrets live apart from state so state.json can be inspected/shared safely.
const SECRET_FILE = path.join(GIBBOUS_HOME, 'secret.json');
export const secret: { accessToken: string; mcpToken: string } = readJson(SECRET_FILE, null as any) ?? (() => {
  const s = { accessToken: randomBytes(24).toString('base64url'), mcpToken: randomBytes(24).toString('base64url') };
  writeJsonAtomic(SECRET_FILE, s);
  return s;
})();
