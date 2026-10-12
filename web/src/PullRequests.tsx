import { GitPullRequest, ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu, Moon } from './ui';
import { aggregateCi, overviewCollapsed, overviewMode, overviewSummary } from './prOverview';
import { useStore, NONE } from './store';
import type { PrBadge } from './api';
import type { CiState } from '../../server/git';
const colors = { pass:'bg-sprout', fail:'bg-oxide', pending:'bg-halo' };
// CI for a PR: the sidebar's running moon while checks run, red when one fails, green when all pass, a faint ring when none ran.
// Fixed-size box so rows stay aligned whatever the state.
export function CiDot({ci}: {ci:CiState|null}) {
  const tip = ci === 'pending' ? 'CI running' : ci === 'fail' ? 'CI failing' : ci === 'pass' ? 'CI passing' : 'No CI checks';
  return <span className="size-2.5 grid place-items-center flex-none" aria-label={tip} data-tip={tip}>
    {ci === 'pending' ? <Moon thread="running" size={9} />
      : <span className={`size-1.5 rounded-full ${ci ? colors[ci] : 'ring-1 ring-ash/50'}`} />}
  </span>;
}
function PrList({prs,compact=false}:{prs:PrBadge[];compact?:boolean}) {
  return <ul aria-label="Pull requests" onKeyDown={e => {
    if (!['j','k','ArrowDown','ArrowUp','Home','End'].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>('a')];
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? links.length-1 : i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1);
    links[Math.max(0, Math.min(links.length-1, next))]?.focus();
  }} className="space-y-1 p-2 max-h-[56dvh] sm:max-h-[26rem] overflow-y-auto">
    {prs.map(pr => compact ? <li key={pr.url}><a href={pr.url} target="_blank" rel="noreferrer" title={`#${pr.number} ${pr.title} · ${pr.headRefName} · ${pr.state}`}
      className="press flex items-center gap-2 h-7 pointer-coarse:h-10 rounded-md px-2 hover:bg-ridge min-w-0 text-[12.5px]">
      <CiDot ci={pr.state === 'open' || pr.state === 'draft' ? pr.ci : null}/>
      <span className={`font-mono text-[11px] tabular-nums flex-none ${pr.state === 'merged' ? 'text-tide' : pr.state === 'closed' ? 'text-ash line-through' : pr.state === 'draft' ? 'text-ash' : 'text-sprout'}`}>#{pr.number}</span>
      <span className="truncate min-w-0 flex-1 text-moon/90">{pr.title}</span>
      <span className="flex-none w-[5.5ch] text-right font-mono text-[10.5px] tabular-nums text-sprout/80">+{pr.additions}</span>
      <span className="flex-none w-[4.5ch] text-right font-mono text-[10.5px] tabular-nums text-oxide/80">−{pr.deletions}</span>
    </a></li> : <li key={pr.url}><a href={pr.url} target="_blank" rel="noreferrer" title={`${pr.title} · ${pr.headRefName}`} className="press block rounded-lg px-2.5 py-2 hover:bg-ridge min-w-0 select-text">
      <div className="flex items-start gap-2"><CiDot ci={pr.state === 'open' || pr.state === 'draft' ? pr.ci : null}/><span className={`text-[13px] text-moon flex-1 min-w-0 ${compact ? 'truncate' : 'break-words'}`}>#{pr.number} {pr.title}</span><span className={`rounded-md px-1.5 py-0.5 text-[10px] flex-none ${pr.state === 'open' ? 'text-sprout bg-sprout/10' : pr.state === 'merged' ? 'text-tide bg-tide/10' : 'text-ash bg-ridge'}`}>{pr.state}</span></div>
      <div className="flex gap-2 mt-1 pl-3.5 text-[11px] font-mono text-ash min-w-0"><span className="truncate flex-1" title={pr.headRefName}>{compact ? null : pr.headRefName}</span><span className="text-sprout flex-none">+{pr.additions}</span><span className="text-oxide flex-none">−{pr.deletions}</span></div>
    </a></li>)}
  </ul>;
}
const COLLAPSE_KEY = 'gibbous.prOverview.collapsed';
export function PullRequestOverview({threadId,panelOpen}:{threadId:string;panelOpen:boolean}) {
  const prs = useStore(s => s.threadPrs[threadId] ?? NONE);
  const anchor = useRef<HTMLDivElement>(null);
  const [width,setWidth] = useState(0);
  const [collapsed,setCollapsed] = useState(() => overviewCollapsed(localStorage.getItem(COLLAPSE_KEY)));
  const [open,setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [threadId, panelOpen]);
  useLayoutEffect(() => {
    const header = anchor.current?.closest('header');
    if (!header) return;
    const measure = () => setWidth(header.clientWidth);
    measure(); const observer = new ResizeObserver(measure); observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const mode = overviewMode(width,panelOpen);
  const toggleCollapse = () => { const next = !collapsed; localStorage.setItem(COLLAPSE_KEY,next ? '1' : '0'); setCollapsed(next); };
  useEffect(() => {
    const toggle = () => {
      if (!prs.length) return;
      if (mode === 'card') toggleCollapse(); else setOpen(v => !v);
    };
    addEventListener('gibbous:pullRequests',toggle);
    return () => removeEventListener('gibbous:pullRequests',toggle);
  }, [mode, collapsed, prs.length]);
  useEffect(() => { setOpen(false); }, [mode]);
  if (!prs.length) return <div ref={anchor} hidden />;
  const summary = overviewSummary(prs);
  const body = <><PrList prs={prs} compact/><footer className="border-t border-line px-3.5 py-2.5 text-[10px] leading-relaxed text-ash select-text">{summary}</footer></>;
  const heading = <><GitPullRequest size={13}/><span className="flex-1 text-left">Pull requests</span><span className="text-ash tabular-nums">{prs.length}</span><CiDot ci={aggregateCi(prs)}/><ChevronDown size={12} className={collapsed ? '-rotate-90' : ''}/></>;
  return <div ref={anchor} data-pr-overview data-mode={mode} className="flex-none">
    {mode === 'card' ? <section className="absolute right-3 top-[calc(100%+12px)] w-[300px] rounded-xl surface bg-basalt overflow-hidden" aria-label="Pull requests overview">
      <button aria-label={collapsed ? 'Expand pull requests' : 'Collapse pull requests'} aria-expanded={!collapsed} onClick={toggleCollapse} className="press w-full flex items-center gap-2 px-3.5 py-3 text-[12px] text-dust hover:text-moon">{heading}</button>
      {!collapsed && body}
    </section> : <div className="relative">
      <button aria-label="Show pull requests" aria-expanded={open} data-tip="Show this session’s pull requests" data-kbd="gp" onClick={() => setOpen(!open)} className="press flex items-center gap-1.5 h-7 pointer-coarse:h-9 px-2 rounded-full border border-line bg-crater text-[11px] text-dust hover:text-moon whitespace-nowrap">PR ×{prs.length}<CiDot ci={aggregateCi(prs)}/></button>
      <Menu open={open} onClose={() => setOpen(false)} className="w-[340px]">
        <h3 className="flex items-center gap-2 px-3.5 pt-3 pb-1 text-[12px] text-dust">Pull requests<span className="text-ash">{prs.length}</span><CiDot ci={aggregateCi(prs)}/></h3>{body}
      </Menu>
    </div>}
  </div>;
}
export function PullRequests({threadId,collapsible=false}:{threadId:string;collapsible?:boolean}) {
  const prs = useStore(s => s.threadPrs[threadId] ?? NONE);
  if (!prs.length) return null;
  return collapsible ? <details key={threadId} className="border-b border-line flex-none bg-basalt" data-pr-list>
    <summary className="press flex items-center gap-2 px-4 py-2 text-[12px] text-dust hover:text-moon"><GitPullRequest size={13}/><span>Pull requests</span><span className="text-ash">{prs.length}</span><ChevronDown size={12} className="ml-auto"/></summary><PrList prs={prs}/>
  </details> : <section className="m-2 rounded-xl surface flex-none" data-pr-list><h3 className="px-4 pt-3 text-[12px] text-dust">Pull requests · {prs.length}</h3><PrList prs={prs}/></section>;
}
