import { GitPullRequest, ChevronDown } from 'lucide-react';
import { useStore, NONE } from './store';
import type { PrBadge } from './api';
import type { CiState } from '../../server/git';
const colors = { pass:'bg-sprout', fail:'bg-oxide', pending:'bg-halo' };
export function CiDot({ci}: {ci:CiState|null}) {
  return <span className={`size-1.5 rounded-full flex-none ${ci ? colors[ci] : 'bg-ash/40'} ${ci === 'pending' ? 'animate-pulse' : ''}`} aria-label={ci ? `CI ${ci}` : 'No active checks'} data-tip={ci ? `CI ${ci}` : 'No active checks'} />;
}
function PrList({prs}:{prs:PrBadge[]}) {
  return <ul aria-label="Pull requests" className="space-y-1 p-2 max-h-72 overflow-y-auto">
    {prs.map(pr => <li key={pr.url}><a href={pr.url} target="_blank" rel="noreferrer" className="press block rounded-lg px-2.5 py-2 hover:bg-ridge min-w-0 select-text">
      <div className="flex items-start gap-2"><CiDot ci={pr.state === 'open' || pr.state === 'draft' ? pr.ci : null}/><span className="text-[13px] text-moon flex-1 min-w-0 break-words">#{pr.number} {pr.title}</span><span className={`rounded-md px-1.5 py-0.5 text-[10px] flex-none ${pr.state === 'open' ? 'text-sprout bg-sprout/10' : pr.state === 'merged' ? 'text-tide bg-tide/10' : 'text-ash bg-ridge'}`}>{pr.state}</span></div>
      <div className="flex gap-2 mt-1 pl-3.5 text-[11px] font-mono text-ash min-w-0"><span className="truncate flex-1" title={pr.headRefName}>{pr.headRefName}</span><span className="text-sprout flex-none">+{pr.additions}</span><span className="text-oxide flex-none">−{pr.deletions}</span></div>
    </a></li>)}
  </ul>;
}
export function PullRequests({threadId,collapsible=false}:{threadId:string;collapsible?:boolean}) {
  const prs = useStore(s => s.threadPrs[threadId] ?? NONE);
  if (!prs.length) return null;
  return collapsible ? <details key={threadId} className="border-b border-line flex-none bg-basalt" data-pr-list>
    <summary className="press flex items-center gap-2 px-4 py-2 text-[12px] text-dust hover:text-moon"><GitPullRequest size={13}/><span>Pull requests</span><span className="text-ash">{prs.length}</span><ChevronDown size={12} className="ml-auto"/></summary><PrList prs={prs}/>
  </details> : <section className="m-2 rounded-xl surface flex-none" data-pr-list><h3 className="px-4 pt-3 text-[12px] text-dust">Pull requests · {prs.length}</h3><PrList prs={prs}/></section>;
}
