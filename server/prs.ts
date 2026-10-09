// PR + CI status for worktree threads, shown in the sidebar. Polled with gh, one call per repo, pushed on change.
import { state } from './store.ts';
import { prsByBranch, type PrBadge } from './git.ts';

let current: Record<string, PrBadge> = {};
let inflight: Promise<void> | undefined;
export const prBadges = () => current;

// Pure: which repo dir to ask for which threads. Worktree threads of a project share the project checkout.
export function prTargets(threads: typeof state.threads, projects: typeof state.projects) {
  const byDir = new Map<string, { id: string; branch: string }[]>();
  for (const t of threads) {
    if (!t.worktree || t.status === 'archived' || t.host) continue;
    const dir = projects.find(p => p.id === t.projectId)?.path ?? t.cwd;
    byDir.set(dir, [...(byDir.get(dir) ?? []), { id: t.id, branch: t.worktree.branch }]);
  }
  return byDir;
}

export function refreshPrs(onChange: (b: Record<string, PrBadge>) => void) {
  return inflight ??= (async () => {
    const next: Record<string, PrBadge> = {};
    await Promise.all([...prTargets(state.threads, state.projects)].map(async ([dir, ts]) => {
      // gh missing, not signed in, or no GitHub remote: keep whatever we knew for these threads.
      const prs = await prsByBranch(dir).catch(() => null);
      for (const t of ts) { const b = prs ? prs.get(t.branch) : current[t.id]; if (b) next[t.id] = b; }
    }));
    if (JSON.stringify(next) !== JSON.stringify(current)) { current = next; onChange(next); }
  })().finally(() => { inflight = undefined; });
}
