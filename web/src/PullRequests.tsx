import { GitPullRequest, GitMerge, GitPullRequestClosed, ChevronDown, Check, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu, Moon } from './ui';
import { aggregateCi, overviewCollapsed, overviewMode, stackRows } from './prOverview';
import { useStore, NONE } from './store';
import { HumanTaskCard } from './HumanTask';
import { humanTasks } from '../../server/humanTasks';
import type { PrBadge } from './api';
import type { CiState } from '../../server/git';
// CI for a PR, drawn like GitHub's: ✓ green when every check passes, ✗ red when one fails, and while checks run the
// sidebar's running moon in GitHub's amber. Fixed-size box so rows stay aligned; a faint ring when no CI ran.
export function CiDot({ci, checks}: {ci:CiState|null; checks?: { passed: number; total: number }}) {
  const count = checks ? ` · ${checks.passed}/${checks.total} checks passed` : '';
  const tip = (ci === 'pending' ? 'CI running' : ci === 'fail' ? 'CI failing' : ci === 'pass' ? 'CI passing' : 'No CI checks') + (ci ? count : '');
  return <span className="size-3 grid place-items-center flex-none" aria-label={tip} data-tip={tip}>
    {ci === 'pending' ? <span className="grid place-items-center [--color-tide:#d29922]"><Moon thread="running" size={8} /></span>
      : ci === 'pass' ? <Check size={12} strokeWidth={2.6} className="text-sprout" />
      : ci === 'fail' ? <X size={12} strokeWidth={2.6} className="text-oxide" />
      : <span className="size-1.5 rounded-full ring-1 ring-ash/50" />}
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
    {(compact ? stackRows(prs) : prs.map(pr => ({ pr, depth: 0, last: true }))).map(({ pr, depth }, i, rows) => compact ? <li key={pr.url}><a href={pr.url} target="_blank" rel="noreferrer" title={`#${pr.number} ${pr.title} · ${pr.headRefName}${depth ? ` · stacked on ${pr.baseRefName}` : ''} · ${pr.state}`}
      className="press relative flex items-center gap-2 h-7 pointer-coarse:h-10 rounded-md px-2 hover:bg-ridge min-w-0 text-[12.5px]">
      {/* Stacked on the PR right above: a short line joining the two CI icons. */}
      {depth > 0 && rows[i - 1]?.pr.headRefName === pr.baseRefName && <span aria-hidden className="absolute left-[13.5px] -top-2.5 h-4 w-px bg-ash/50" />}
      {/* Merged / closed PRs show GitHub's icon instead of CI, which no longer matters for them. */}
      {pr.state === 'merged' ? <span className="size-3 grid place-items-center flex-none" data-tip="Merged" aria-label="Merged"><GitMerge size={12} strokeWidth={2.2} className="text-[#b8a6e0]" /></span>
        : pr.state === 'closed' ? <span className="size-3 grid place-items-center flex-none" data-tip="Closed without merging" aria-label="Closed"><GitPullRequestClosed size={12} strokeWidth={2.2} className="text-ash" /></span>
        : <CiDot ci={pr.ci} checks={pr.checks}/>}
      <span className={`font-mono text-[11px] tabular-nums flex-none ${pr.state === 'merged' ? 'text-[#b8a6e0]' : pr.state === 'closed' ? 'text-ash line-through' : pr.state === 'draft' ? 'text-ash' : 'text-sprout'}`}>#{pr.number}</span>
      <span className={`truncate min-w-0 flex-1 ${pr.state === 'merged' || pr.state === 'closed' ? 'text-dust' : 'text-moon/90'}`}>{pr.title}</span>
      <span className="flex-none w-[5.5ch] text-right font-mono text-[10.5px] tabular-nums text-sprout/80">+{pr.additions}</span>
      <span className="flex-none w-[4.5ch] text-right font-mono text-[10.5px] tabular-nums text-oxide/80">−{pr.deletions}</span>
    </a></li> : <li key={pr.url}><a href={pr.url} target="_blank" rel="noreferrer" title={`${pr.title} · ${pr.headRefName}`} className="press block rounded-lg px-2.5 py-2 hover:bg-ridge min-w-0 select-text">
      <div className="flex items-start gap-2"><CiDot ci={pr.state === 'open' || pr.state === 'draft' ? pr.ci : null} checks={pr.checks}/><span className={`text-[13px] text-moon flex-1 min-w-0 ${compact ? 'truncate' : 'break-words'}`}>#{pr.number} {pr.title}</span><span className={`rounded-md px-1.5 py-0.5 text-[10px] flex-none ${pr.state === 'open' ? 'text-sprout bg-sprout/10' : pr.state === 'merged' ? 'text-tide bg-tide/10' : 'text-ash bg-ridge'}`}>{pr.state}</span></div>
      <div className="flex gap-2 mt-1 pl-3.5 text-[11px] font-mono text-ash min-w-0"><span className="truncate flex-1" title={pr.headRefName}>{compact ? null : pr.headRefName}</span><span className="text-sprout flex-none">+{pr.additions}</span><span className="text-oxide flex-none">−{pr.deletions}</span></div>
    </a></li>)}
  </ul>;
}
const COLLAPSE_KEY = 'gibbous.prOverview.collapsed';
export function PullRequestOverview({threadId,panelOpen}:{threadId:string;panelOpen:boolean}) {
  const prs = useStore(s => s.threadPrs[threadId] ?? NONE);
  const thread = useStore(s => s.threads.find(t => t.id === threadId));
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
  const hasTasks = !!thread && humanTasks(thread).some(t => t.doneAt == null);
  // Wide screens: the right gutter holds the PR card and, under it, the thread's "For me" tasks.
  if (!prs.length) return <div ref={anchor} data-pr-overview data-mode={mode} className="flex-none">
    {mode === 'card' && hasTasks && <div data-rail className="absolute right-3 top-[calc(100%+12px)] w-[300px]"><HumanTaskCard thread={thread!} rail /></div>}
  </div>;
  const body = <PrList prs={prs} compact/>;
  const heading = <><GitPullRequest size={13}/><span className="flex-1 text-left">Pull requests</span><span className="text-ash tabular-nums">{prs.length}</span><CiDot ci={aggregateCi(prs)}/><ChevronDown size={12} className={collapsed ? '-rotate-90' : ''}/></>;
  return <div ref={anchor} data-pr-overview data-mode={mode} className="flex-none">
    {mode === 'card' ? <div data-rail className="absolute right-3 top-[calc(100%+12px)] w-[300px] flex flex-col gap-3">
      <section className="rounded-xl surface bg-basalt overflow-hidden" aria-label="Pull requests overview">
        <button aria-label={collapsed ? 'Expand pull requests' : 'Collapse pull requests'} aria-expanded={!collapsed} onClick={toggleCollapse} className="press w-full flex items-center gap-2 px-3.5 py-3 text-[12px] text-dust hover:text-moon">{heading}</button>
        {!collapsed && body}
      </section>
      {hasTasks && <HumanTaskCard thread={thread!} rail />}
    </div> : <div className="relative">
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
