import type { Thread } from './store.ts';

export function openHumanTask(t: Pick<Thread, 'humanTask'>): boolean { return !!t.humanTask && t.humanTask.doneAt == null; }
export function attentionCount(requests: number, threads: Pick<Thread, 'humanTask'>[]): number {
  return requests + threads.filter(openHumanTask).length;
}
export function taskText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 1000) throw new Error('Task text must be 1–1000 characters');
  return text.trim();
}
export function setHumanTask(t: Thread, text: unknown, by: 'user' | 'agent', at = Date.now()) {
  t.humanTask = { text: taskText(text), by, at }; t.updatedAt = at; return t;
}
export function completeHumanTask(t: Thread, at = Date.now()) {
  if (t.humanTask && openHumanTask(t)) { t.humanTask.doneAt = at; t.updatedAt = at; } return t;
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
