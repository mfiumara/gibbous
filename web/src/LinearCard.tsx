// Linear tickets this thread works on (server/linear.ts finds them): a rail card under the PR card, and the state
// icon + identifier on the thread's sidebar row. Each row opens the ticket in Linear.
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Fold } from './ui';
import { useStore, NONE } from './store';
import type { LinearIssue } from '../../server/linear';

// Linear's own status glyphs, in the team's status colour: dashed ring (backlog/triage), ring (todo), ring with a
// filled share (in progress), filled with a check (done), filled with a cross (cancelled).
export function LinearState({ state, size = 12 }: { state: LinearIssue['state']; size?: number }) {
  const c = state.color || '#95a2b3', r = 5.25;
  const t = state.type;
  return <svg width={size} height={size} viewBox="0 0 14 14" className="flex-none" aria-label={state.name} role="img" data-tip={state.name}>
    {t === 'completed' || t === 'canceled' ? <>
      <circle cx="7" cy="7" r="6" fill={c} />
      {t === 'completed' ? <path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="#16171c" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M5 5l4 4M9 5l-4 4" stroke="#16171c" strokeWidth="1.5" strokeLinecap="round" />}
    </> : <>
      <circle cx="7" cy="7" r={r} fill="none" stroke={c} strokeWidth="1.5" strokeDasharray={t === 'backlog' || t === 'triage' ? '1.4 1.6' : undefined} />
      {t === 'started' && <path d={`M7 7V3.5A3.5 3.5 0 0 1 7 10.5Z`} fill={c} />}
    </>}
  </svg>;
}

const PRIO = ['', 'Urgent', 'High', 'Medium', 'Low'];
const KEY = 'gibbous.linearCard.open';
const done = (i: LinearIssue) => i.state.type === 'completed' || i.state.type === 'canceled';

export function LinearCard({ issues, rail = false }: { issues: LinearIssue[]; rail?: boolean }) {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) !== '0');
  const toggle = () => { localStorage.setItem(KEY, open ? '0' : '1'); setOpen(!open); };
  const live = issues.filter(i => !done(i)).length;
  const card = <div className="rounded-xl surface bg-basalt overflow-hidden">
    <button onClick={toggle} aria-expanded={open} className="press w-full flex items-center gap-2 px-3.5 py-3 text-[12px] text-dust hover:text-moon">
      <svg width="13" height="13" viewBox="0 0 100 100" aria-hidden className="flex-none"><path fill="currentColor" d="M1.2 61.5c-.2-.9.9-1.5 1.6-.8l36.5 36.5c.7.7.1 1.8-.8 1.6C19.9 94.9 5.1 80.1 1.2 61.5zM0 46.9c0 .3.1.6.3.8l52 52c.2.2.5.3.8.3 2.4-.1 4.7-.4 7-.9.8-.2 1-1.1.5-1.7L2.6 39.4c-.6-.6-1.5-.3-1.7.5-.5 2.3-.8 4.6-.9 7zm4.2-17.2c-.2.4-.1.8.2 1.1l64.8 64.8c.3.3.7.4 1.1.2 1.8-.8 3.5-1.7 5.2-2.7.6-.3.6-1.1.2-1.6L8.5 24.3c-.5-.5-1.3-.4-1.6.2-1 1.7-1.9 3.4-2.7 5.2zm8.5-11.6c-.4-.4-.4-1 0-1.4C21.8 6.5 35.2 0 50 0c27.6 0 50 22.4 50 50 0 14.8-6.5 28.2-16.7 37.3-.4.4-1 .4-1.4 0L12.7 18.1z"/></svg>
      <span className="flex-1 text-left">Linear</span>
      <span className="text-ash tabular-nums">{live || issues.length}</span>
      <ChevronDown size={12} className={`transition-transform duration-300 ease-out ${open ? '' : '-rotate-90'}`} />
    </button>
    <Fold open={open}>
      <ul className="space-y-0.5 px-2 pb-2 max-h-[22rem] overflow-y-auto">
        {issues.map(i => <li key={i.identifier}>
          <a href={i.url} target="_blank" rel="noreferrer" title={`${i.identifier} ${i.title}`} className={`press block rounded-lg px-2 py-1.5 hover:bg-ridge min-w-0 ${done(i) ? 'opacity-60' : ''}`}>
            <div className="flex items-center gap-2 min-w-0 text-[12.5px]">
              <LinearState state={i.state} />
              <span className="font-mono text-[11px] text-ash flex-none">{i.identifier}</span>
              <span className={`truncate min-w-0 flex-1 ${done(i) ? 'text-dust' : 'text-moon/90'}`}>{i.title}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 pl-5 text-[11px] text-ash min-w-0">
              <span className="flex-none">{i.state.name}</span>
              {i.priority > 0 && <><span aria-hidden>·</span><span className={`flex-none ${i.priority === 1 ? 'text-oxide' : ''}`}>{PRIO[i.priority] ?? i.priorityLabel}</span></>}
              {i.assignee && <><span aria-hidden>·</span><span className="truncate">{i.assignee}</span></>}
              {i.labels.slice(0, 3).map(l => <span key={l.name} className="size-1.5 rounded-full flex-none" style={{ background: l.color }} data-tip={l.name} aria-label={l.name} />)}
            </div>
          </a>
        </li>)}
      </ul>
    </Fold>
  </div>;
  // Narrow screens: a strip above the chat, like the board and "For me" cards (hidden while the right column shows).
  if (rail) return <section aria-label="Linear tickets" className="w-full animate-fade">{card}</section>;
  return <section aria-label="Linear tickets" data-inline-tasks className="mx-auto w-full max-w-3xl px-4 pt-3 flex-none animate-fade">{card}</section>;
}

export function InlineLinear({ threadId }: { threadId: string }) {
  const issues = useStore(s => s.threadLinear[threadId] ?? NONE);
  return issues.length ? <LinearCard issues={issues} /> : null;
}

/** The ticket a sidebar row shows: the latest one still open, else the latest. */
export const primaryIssue = (issues: LinearIssue[]) => issues.find(i => !done(i)) ?? issues[0];
