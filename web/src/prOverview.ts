import type { PrBadge } from './api';
import { aggregateCi } from '../../server/prSummary.ts';
export { aggregateCi };
export function overviewSummary(prs: PrBadge[]): string {
  const states = (['draft', 'open', 'merged', 'closed'] as const).map(state => {
    const n = prs.filter(p => p.state === state).length;
    return n ? `${n} ${state}` : '';
  }).filter(Boolean);
  const ci = (['pass', 'pending', 'fail'] as const).map(state => {
    const n = prs.filter(p => (p.state === 'open' || p.state === 'draft') && p.ci === state).length;
    return n ? `${n} ${state === 'pass' ? 'passing' : state === 'fail' ? 'failing' : state}` : '';
  }).filter(Boolean);
  return [...states, ...(ci.length ? [`CI ${ci.join(', ')}`] : [])].join(' · ');
}
// Transcript is centred at max-w-3xl (768px). Keep 12px at the outer edge
// and a full 12px gap between the 300px card and the transcript box.
export function overviewMode(width: number, panelOpen: boolean): 'card' | 'pill' {
  return !panelOpen && (width - 768) / 2 >= 324 ? 'card' : 'pill';
}
export const overviewCollapsed = (stored: string | null) => stored === '1';

// Stacked PRs (a PR whose base is another PR's branch in the same repo) nest under their parent, GitHub-stack style.
// Order: each root keeps its place; children follow their parent.
export interface StackRow { pr: PrBadge; depth: number; last: boolean }
const repoOf = (url: string) => url.replace(/\/pull\/\d+.*$/, '');
export function stackRows(prs: PrBadge[]): StackRow[] {
  const parentOf = new Map<PrBadge, PrBadge>();
  for (const pr of prs) {
    const parent = pr.baseRefName ? prs.find(x => x !== pr && x.headRefName === pr.baseRefName && repoOf(x.url) === repoOf(pr.url)) : undefined;
    if (parent) parentOf.set(pr, parent);
  }
  // A cycle (A on B on A) can't nest: its members stay roots.
  const inCycle = (pr: PrBadge) => { const seen = new Set<PrBadge>(); for (let x: PrBadge | undefined = pr; x; x = parentOf.get(x)) { if (seen.has(x)) return true; seen.add(x); } return false; };
  for (const pr of [...parentOf.keys()].filter(inCycle)) parentOf.delete(pr);
  const children = (p: PrBadge) => prs.filter(x => parentOf.get(x) === p);
  const out: StackRow[] = [];
  const walk = (pr: PrBadge, depth: number, last: boolean) => { out.push({ pr, depth, last }); const cs = children(pr); cs.forEach((c, i) => walk(c, depth + 1, i === cs.length - 1)); };
  prs.filter(pr => !parentOf.has(pr)).forEach(r => walk(r, 0, true));
  return out;
}
