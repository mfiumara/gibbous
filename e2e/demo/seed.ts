// Seed the demo Gibbous through its real API: two projects, finished threads, one running, one waiting for approval,
// and Discord chats mirrored into the sidebar. The kanban board is Hermes' own, served by the fake (demo-data.ts).
import type { Env } from './lib.ts';
import { sleep } from './lib.ts';

export interface Seeded {
  tide: any; docs: any;
  threads: Record<'bench' | 'cli' | 'docsDark' | 'readme' | 'flaky' | 'ts', string>;
}

export async function waitFor<T>(env: Env, what: string, f: (s: any) => T | undefined | false, ms = 120000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = f(await env.api('GET', '/api/state'));
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}
export const threadStatus = (env: Env, id: string, status: string) => waitFor(env, `thread ${id} ${status}`, s => s.threads.find((t: any) => t.id === id)?.status === status);

export async function seed(env: Env): Promise<Seeded> {
  const { api, fake } = env;
  fake.speed.factor = 0;
  const tide = await api('POST', '/api/projects', { path: env.repos.tide, name: 'tidepool' });
  const docs = await api('POST', '/api/projects', { path: env.repos.docs, name: 'tidepool-docs' });
  await api('PATCH', '/api/settings', { monthlyBudgetUsd: 60, syncSources: ['discord'], snippets: [
    { name: 'review', text: 'Review the diff against main for correctness and missing tests. List concrete fixes.' },
    { name: 'bench', text: 'Run pnpm bench before and after your change and report the difference.' },
    { name: 'changelog', text: 'Add a CHANGELOG entry for this change under Unreleased.' },
  ] });

  const chat = async (projectId: string, title: string, prompt: string, worktree = false, until = 'idle') => {
    const t = await api('POST', '/api/threads', { projectId, title, prompt, worktree });
    await threadStatus(env, t.id, until);
    return t.id as string;
  };
  const threads = {} as Seeded['threads'];
  threads.bench = await chat(tide.id, 'Benchmark token bucket', 'Benchmark the in-memory token bucket and tell me where the time goes.');
  threads.cli = await chat(tide.id, 'CLI --json output', 'Add a --json flag to `tidepool simulate` so CI can parse the result.', true);
  threads.docsDark = await chat(docs.id, 'Theme-aware code blocks', 'Code blocks look wrong in light mode. Make them follow the system theme.');
  threads.readme = await chat(tide.id, 'README quick start', 'Write a README quick start: Express middleware and sharing limits through Redis.', true);

  // A thread at work and one waiting for you.
  fake.speed.factor = 0.02;
  threads.flaky = await chat(tide.id, 'Fix flaky Redis test', 'The RedisStore expiry test is flaky in CI (about 1 in 20 runs). Find out why and fix it.', true, 'running');
  await fake.waitHold('flaky-forever');
  threads.ts = await chat(tide.id, 'TypeScript 5.9 upgrade', 'Upgrade to TypeScript 5.9 and the latest @types/node 20, and fix anything that breaks.', true, 'needs_input');

  // Spread timestamps so the sidebar and board read like a real week.
  const b = await api<any>('GET', '/api/backup');
  const ago = (min: number) => Date.now() - min * 60_000;
  const when: Record<string, number> = { [threads.bench]: 2 * 1440 + 200, [threads.cli]: 1440 + 95, [threads.docsDark]: 300, [threads.readme]: 38 };
  for (const t of b.threads) if (when[t.id] != null) { t.updatedAt = ago(when[t.id]); t.createdAt = ago(when[t.id] + 25); }
  await api('POST', '/api/restore', b);
  // Discord chats mirrored into the sidebar (Keep in sidebar), read-only like the real thing.
  await api('POST', '/api/sync');
  fake.speed.factor = 1;
  return { tide, docs, threads };
}
