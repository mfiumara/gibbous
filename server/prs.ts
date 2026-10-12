// Transcript provenance plus current-branch PRs; status is fetched in batches, not per thread.
import { state } from './store.ts';
import { currentBranch, prsByBranch, run, type PrBadge } from './git.ts';
import { PrHistory, ownsPr } from './prHistory.ts';
import { fetchPrs } from './prFetch.ts';
import { openStateDb } from './subagents.ts';
import { homedir } from 'node:os';
const history = new PrHistory();
let lists: Record<string, PrBadge[]> = {};
let current: Record<string, PrBadge> = {};
let inflight: Promise<void> | undefined;
let login: string | undefined, loginAt = 0;
export const prBadges = () => current;
export const threadPrs = () => lists;
export function prTargets(threads: typeof state.threads, projects: typeof state.projects) {
  const byDir = new Map<string, { id: string; branch: string; path: string }[]>();
  for (const t of threads) {
    if (!t.worktree || t.host) continue;
    const dir = projects.find(p => p.id === t.projectId)?.path ?? t.cwd;
    byDir.set(dir, [...(byDir.get(dir) ?? []), { id: t.id, branch: t.worktree.branch, path: t.worktree.path }]);
  }
  return byDir;
}
export async function liveBranch(dir: string, stored: string) {
  const b = await currentBranch(dir).catch(() => '');
  return b && b !== 'HEAD' ? b : stored;
}
export function refreshPrs(onChange: (b: Record<string, PrBadge>, lists: Record<string, PrBadge[]>) => void) {
  return inflight ??= (async () => {
    if (Date.now() - loginAt > 300_000) {
      login = await run('gh', ['api', 'user', '-q', '.login'], homedir()).then(s => s.trim()).catch(() => undefined);
      loginAt = Date.now();
    }
    const local = state.threads.filter(t => !t.host), scans = new Map<string, ReturnType<PrHistory['scan']>>();
    const db = openStateDb();
    if (db) for (const t of local) if (t.sessionId) scans.set(t.id, history.scan(db, t.sessionId));
    const refs = [...new Map([...scans.values()].flatMap(s => s.refs).map(r => [r.url, r])).values()];
    const fetched = await fetchPrs(refs, homedir()).catch(() => null);
    const nextLists: Record<string, PrBadge[]> = {};
    for (const t of local) {
      const found = new Map<string, PrBadge>();
      for (const p of lists[t.id] ?? []) if (!fetched?.has(p.url)) found.set(p.url, p);
      for (const ref of scans.get(t.id)?.refs ?? []) {
        const p = fetched?.get(ref.url);
        if (p && ownsPr(ref, p.author, login)) found.set(p.url, p);
      }
      if (found.size) nextLists[t.id] = [...found.values()];
    }
    await Promise.all([...prTargets(state.threads, state.projects)].map(async ([dir, ts]) => {
      const [prs, branches] = await Promise.all([prsByBranch(dir).catch(() => null), Promise.all(ts.map(t => liveBranch(t.path, t.branch)))]);
      ts.forEach((t, i) => {
        const p = prs ? prs.get(branches[i]) : current[t.id];
        if (p && !(nextLists[t.id] ?? []).some(x => x.url === p.url)) (nextLists[t.id] ??= []).push(p);
      });
    }));
    const next: Record<string, PrBadge> = {};
    for (const [id, ps] of Object.entries(nextLists)) {
      ps.sort((a,b) => Number(!['open','draft'].includes(a.state)) - Number(!['open','draft'].includes(b.state)) || b.number - a.number || a.url.localeCompare(b.url));
      next[id] = ps.find(p => p.state === 'open') ?? ps[0];
    }
    if (JSON.stringify(nextLists) !== JSON.stringify(lists) || JSON.stringify(next) !== JSON.stringify(current)) {
      lists = nextLists; current = next; onChange(next, lists);
    }
  })().finally(() => { inflight = undefined; });
}
