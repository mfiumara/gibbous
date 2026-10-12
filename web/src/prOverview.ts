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
