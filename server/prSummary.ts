import type { CiState, PrBadge } from './git.ts';
export function aggregateCi(prs: PrBadge[]): CiState | null {
  const states = prs.filter(p => p.state === 'open' || p.state === 'draft').map(p => p.ci);
  return states.includes('fail') ? 'fail' : states.includes('pending') ? 'pending' : states.includes('pass') ? 'pass' : null;
}
