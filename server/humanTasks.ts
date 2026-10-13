import type { Thread } from './store.ts';
export type HumanTask = { id: string; text: string; at: number; by: 'user' | 'agent'; doneAt?: number };
type Tasks = Pick<Thread, 'humanTask' | 'humanTasks'>;
// Deterministic legacy ids survive reads, reloads and backup migrations.
export function humanTasks(t: Tasks): HumanTask[] {
  return t.humanTasks ?? (t.humanTask ? [{ ...t.humanTask, id: `legacy-${t.humanTask.at}` }] : []);
}
export function openHumanTask(t: Tasks): boolean { return humanTasks(t).some(t => t.doneAt == null); }
// The app badge: threads with activity you haven't looked at yet, on any device (archived and still-running ones don't count).
export function unreadCount(threads: { status: string; updatedAt: number; createdAt: number; seenAt?: number; readOnly?: boolean }[]): number {
  return threads.filter(t => t.status !== 'archived' && t.status !== 'running' && t.updatedAt > (t.seenAt ?? t.createdAt)).length;
}
export function taskText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 1000) throw new Error('Task text must be 1–1000 characters');
  return text.trim();
}
function writable(t: Thread) { const tasks = humanTasks(t); t.humanTasks = tasks; delete t.humanTask; return tasks; }
export function addHumanTasks(t: Thread, texts: unknown, by: 'user' | 'agent', at = Date.now()): HumanTask[] {
  if (!Array.isArray(texts) || !texts.length || texts.length > 10) throw new Error('tasks must contain 1–10 items');
  const valid = texts.map(taskText); // Validate the entire batch before mutating.
  const created = valid.map(text => ({ id: crypto.randomUUID(), text, by, at }));
  writable(t).push(...created); t.updatedAt = at; return created;
}
export function patchHumanTask(t: Thread, id: string, patch: { text?: unknown; done?: unknown }, at = Date.now()) {
  if (!humanTasks(t).some(task => task.id === id)) throw new Error('Task not found');
  const text = patch.text === undefined ? undefined : taskText(patch.text);
  if (patch.done !== undefined && typeof patch.done !== 'boolean') throw new Error('done must be boolean');
  const task = writable(t).find(task => task.id === id)!;
  if (text !== undefined) task.text = text;
  if (patch.done === true) task.doneAt ??= at;
  if (patch.done === false) delete task.doneAt;
  t.updatedAt = at; return task;
}
export function removeHumanTask(t: Thread, id: string) {
  if (!humanTasks(t).some(task => task.id === id)) throw new Error('Task not found');
  t.humanTasks = writable(t).filter(task => task.id !== id); t.updatedAt = Date.now(); return t;
}
export function completeHumanTask(t: Thread, selector?: { task_id?: unknown; text?: unknown }) {
  const tasks = humanTasks(t).filter(task => task.doneAt == null);
  let matches = selector?.task_id !== undefined ? tasks.filter(task => task.id === selector.task_id)
    : selector?.text !== undefined ? tasks.filter(task => task.text === selector.text) : tasks;
  if (matches.length !== 1) throw new Error('Identify exactly one open task with task_id or exact text; use gibbous_list_human_tasks first');
  return patchHumanTask(t, matches[0].id, { done: true });
}
// Per-thread trailing debounce combines consecutive tool calls. Completed/removed tasks never notify.
export function taskNotifier(send: (t: Thread, tasks: HumanTask[]) => void, delay = 3000) {
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; ids: Set<string> }>();
  return (t: Thread, created: HumanTask[]) => {
    const old = pending.get(t.id); if (old) clearTimeout(old.timer);
    const ids = old?.ids ?? new Set<string>(); created.forEach(task => ids.add(task.id));
    const timer = setTimeout(() => { pending.delete(t.id); const tasks = humanTasks(t).filter(task => ids.has(task.id) && task.doneAt == null); if (tasks.length) send(t, tasks); }, delay);
    timer.unref?.(); pending.set(t.id, { timer, ids });
  };
}
// Follow only recorded ancestry, never guess from cwd/activity (parallel agents share both).
export function threadForSession(threads: Thread[], session: string, parent: (id: string) => string | undefined): Thread | undefined {
  const seen = new Set<string>();
  while (session && !seen.has(session)) {
    seen.add(session);
    const t = threads.find(t => !t.host && t.sessionId === session);
    if (t) return t;
    session = parent(session) ?? '';
  }
}
