// PR + CI status for worktree threads, shown in the sidebar. Polled with gh, one call per repo, pushed on change.
import { state } from './store.ts';
import { currentBranch, prsByBranch, type PrBadge } from './git.ts';

let current: Record<string, PrBadge> = {};
let inflight: Promise<void> | undefined;
export const prBadges = () => current;

// Pure: which repo dir to ask for which threads. Worktree threads of a project share the project checkout.
// Archived threads count too: their PRs usually outlive the conversation.
export function prTargets(threads: typeof state.threads, projects: typeof state.projects) {
  const byDir = new Map<string, { id: string; branch: string; path: string }[]>();
  for (const t of threads) {
    if (!t.worktree || t.host) continue;
    const dir = projects.find(p => p.id === t.projectId)?.path ?? t.cwd;
    byDir.set(dir, [...(byDir.get(dir) ?? []), { id: t.id, branch: t.worktree.branch, path: t.worktree.path }]);
  }
  return byDir;
}

// Agents often rename or switch the worktree's branch before opening the PR, so ask git, not the stored name.
// Detached HEAD or a removed worktree falls back to the branch Gibbous created.
export async function liveBranch(dir: string, stored: string) {
  const b = await currentBranch(dir).catch(() => '');
  return b && b !== 'HEAD' ? b : stored;
}

export function refreshPrs(onChange: (b: Record<string, PrBadge>) => void) {
  return inflight ??= (async () => {
    const next: Record<string, PrBadge> = {};
    await Promise.all([...prTargets(state.threads, state.projects)].map(async ([dir, ts]) => {
      // gh missing, not signed in, or no GitHub remote: keep whatever we knew for these threads.
      const [prs, branches] = await Promise.all([prsByBranch(dir).catch(() => null), Promise.all(ts.map(t => liveBranch(t.path, t.branch)))]);
      ts.forEach((t, i) => { const b = prs ? prs.get(branches[i]) : current[t.id]; if (b) next[t.id] = b; });
    }));
    if (JSON.stringify(next) !== JSON.stringify(current)) { current = next; onChange(next); }
  })().finally(() => { inflight = undefined; });
}
