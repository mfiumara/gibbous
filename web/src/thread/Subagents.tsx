// Subagents: a count chip on the thread's status line, one quiet line per subagent in the timeline, and a side panel:
// an overview of all of them (what each is doing or found), then one subagent's own transcript (← → between them).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Square, Send, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useRpc } from '../rpc';
import { toastError } from '../store';
import { IconButton, MoonLoader, Skeleton, inputCls, fmtTokens, fmtDuration, sameJson } from '../ui';
import { fromStored, type Item, type StoredRow } from './timeline';
import { AssistantMessage, ToolRow, ReasoningBlock, Markdown } from './Items';
import { mergeAgents, agentCounts, agentName, firstLine, isLive, type Agent, type AgentState, type StoredSub, type LiveSub } from './agents';

// ── data ──────────────────────────────────────────────────────────────
export function useSubagents(threadId: string, items: Item[], running: boolean): Agent[] {
  const [stored, setStored] = useState<StoredSub[]>([]);
  const live = useMemo(() => items.filter((i): i is LiveSub => i.kind === 'subagent'), [items]);
  const load = useCallback(() => api.get<{ subagents: StoredSub[] }>(`/api/threads/${threadId}/subagents`).then(r => setStored(s => sameJson(s, r.subagents) ? s : r.subagents), () => {}), [threadId]);
  useEffect(() => { setStored([]); load(); }, [load]);
  // New subagents appear as the parent delegates: refresh when live events arrive, and poll while any is working.
  useEffect(() => { if (live.length) load(); }, [live.length, load]);
  const agents = useMemo(() => mergeAgents(stored, live), [stored, live]);
  const busy = running || agents.some(isLive);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 4000);
    return () => clearInterval(t);
  }, [busy, load]);
  return agents;
}

// ── small pieces ──────────────────────────────────────────────────────
const label: Record<AgentState, string> = { running: 'working', queued: 'queued', done: 'done', failed: 'failed', stopped: 'stopped', quiet: 'no activity' };

// Every subagent is a moon of the same size: waxing (animated) while it works, full when done, a dim new moon while
// queued or quiet, and a reddened full moon when it failed or was stopped.
export function AgentDot({ a, size = 10 }: { a: Agent; size?: number }) {
  if (a.state === 'running') return <MoonLoader size={size} label="working" />;
  const frame = a.state === 'queued' || a.state === 'quiet' ? 0 : 18;
  const tint = a.state === 'failed' ? 'sepia(1) saturate(4) hue-rotate(-30deg) brightness(.85)' : a.state === 'stopped' ? 'sepia(.8) saturate(2) brightness(.9)' : a.state === 'queued' || a.state === 'quiet' ? 'brightness(.7)' : undefined;
  return <span role="img" aria-label={label[a.state]} className="moon-loader moon-still" style={{ '--s': `${size}px`, '--tonight': frame, filter: tint } as React.CSSProperties} />;
}

function summaryLine(agents: Agent[]) {
  const c = agentCounts(agents);
  return [c.running && `${c.running} working`, c.queued && `${c.queued} queued`, c.done && `${c.done} done`, c.failed && `${c.failed} failed`, c.other && `${c.other} idle`].filter(Boolean).join(' · ');
}

// One card for a group of subagents: collapsed, the moon + "2/9 subagents working" + what one of them is doing;
// click to unfold it in place with each subagent on its own line (click a line for its transcript), click the
// header to fold it back. Used in the timeline where Hermes delegated, and under the status line otherwise.
export function SubagentGroup({ agents, all, onOpen }: { agents: Agent[]; all: Agent[]; onOpen(key?: string): void }) {
  const [open, setOpen] = useState(false);
  if (!agents.length) return null;
  const working = agents.filter(isLive), done = !working.length;
  const now = working.find(a => a.activity) ?? working[0];
  const lead = <>{done ? <AgentDot a={agents.find(a => a.state === 'failed') ?? agents[0]} size={16} /> : <MoonLoader size={16} label="subagents working" />}</>;
  const title = done ? `${agents.length} subagent${agents.length > 1 ? 's' : ''} finished` : <><span className="font-mono tabular-nums text-tide">{working.length}/{agents.length}</span> subagent{agents.length > 1 ? 's' : ''} working</>;
  return (
    <div className={`w-full rounded-xl border transition-colors ${done ? 'border-line/70 bg-crater/40' : 'border-tide/25 bg-tide/[.05]'}`}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} data-tip={open ? 'Fold' : 'Show each subagent'}
        className="press w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-xl">
        {lead}
        <span className="flex-1 min-w-0">
          <span className="block text-[12.5px] text-moon">{title}</span>
          {!open && <span className="block truncate text-[11.5px] text-dust">{now ? <>{agentName(now, all.indexOf(now))}{now.activity && <span className="font-mono text-ash"> · {now.activity}</span>}</> : agents.map((a) => agentName(a, all.indexOf(a))).join(' · ')}</span>}
        </span>
        <ChevronRight size={14} className={`flex-none text-ash transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <ul className="px-1.5 pb-1.5 animate-fade">{[...working, ...agents.filter(a => !isLive(a))].map(a => (
        <li key={a.key}>
          <button onClick={() => onOpen(a.key)} className="press w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-lg text-left text-[13px] text-dust hover:text-moon hover:bg-ridge/60">
            <span className="w-4 grid place-items-center flex-none"><AgentDot a={a} size={11} /></span>
            <span className="text-moon/90 truncate min-w-0 flex-none max-w-[55%]">{agentName(a, all.indexOf(a))}</span>
            <span className="truncate min-w-0 font-mono text-[11.5px] text-ash">{isLive(a) ? a.activity : firstLine(a.summary ?? a.lastText)}</span>
            <span className="ml-auto pl-2 flex-none text-[11px] font-mono text-ash">{label[a.state]}</span>
          </button>
        </li>
      ))}</ul>}
    </div>
  );
}

// Timeline: one line per subagent where the delegation happened, instead of a big card each.
export function SubagentLine({ item, agents, onOpen }: { item: LiveSub; agents: Agent[]; onOpen(key: string): void }) {
  const a = agents.find(x => x.liveId === item.id) ?? mergeAgents([], [item])[0];
  const i = agents.indexOf(a);
  return (
    <button onClick={() => onOpen(a.key)} className="press w-[calc(100%+0.75rem)] -mx-1.5 px-1.5 py-1 flex items-center gap-2 rounded-md text-left text-[13px] text-dust hover:text-moon hover:bg-crater/70">
      <AgentDot a={a} size={7} />
      <span className="text-moon/90 truncate min-w-0">{agentName(a, i < 0 ? item.index : i)}</span>
      {a.activity && <span className="truncate min-w-0 font-mono text-[11.5px] text-ash">{a.activity}</span>}
      <span className="ml-auto pl-2 flex-none text-[11px] font-mono text-ash">{label[a.state]}</span>
    </button>
  );
}

// ── the panel: an overview of every subagent; pick one for its transcript ─────────────────────────────────────────
const elapsedOf = (a: Agent) => a.startedAt ? (a.endedAt ?? Date.now()) - a.startedAt : undefined;

export function SubagentsPanel({ agents, sid, focus, onFocus }: { agents: Agent[]; sid?: string; focus?: string; onFocus(key?: string): void }) {
  const [, tick] = useState(0);
  // Running timers on the cards.
  useEffect(() => { if (!agents.some(isLive)) return; const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, [agents]);
  if (!agents.length) return <p className="p-4 text-sm text-dust">No subagents in this thread yet. They show up here as soon as Hermes delegates work.</p>;
  // Working ones first, then queued, failed, then the rest in their usual order; ← → in the detail follows this too.
  const rank = (a: Agent) => a.state === 'running' ? 0 : a.state === 'queued' ? 1 : a.state === 'failed' ? 2 : 3;
  const order = agents.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i);
  const at = order.findIndex(o => o.a.key === focus);
  if (at >= 0) return <AgentDetail order={order} at={at} sid={sid} onFocus={onFocus} />;
  const c = agentCounts(agents);
  return (
    <div className="h-full overflow-y-auto" data-vim-list>
      <div className="px-4 pt-4 pb-3">
        {/* One moon per subagent: waxing while it works, full when done, red when it failed. */}
        <div className="flex flex-wrap gap-1.5 mb-3">{agents.map((a, i) => <button key={a.key} onClick={() => onFocus(a.key)} data-tip={`${agentName(a, i)} · ${label[a.state]}`} className="press rounded-full"><AgentDot a={a} size={12} /></button>)}</div>
        <p className="text-[15px] font-medium text-moon">{c.running + c.queued ? `${c.running + c.queued} of ${agents.length} working` : `All ${agents.length} finished`}</p>
        <p className="mt-0.5 text-[12px] text-ash">{summaryLine(agents)}</p>
      </div>
      <ul className="px-2 pb-3 space-y-1.5">
        {order.map(({ a, i }) => {
          const ms = elapsedOf(a), live = isLive(a);
          const line = live ? a.activity : a.state === 'failed' ? a.status : firstLine(a.summary ?? a.lastText);
          return (
            <li key={a.key}>
              <button data-vim-item onClick={() => onFocus(a.key)}
                className={`press w-full text-left rounded-xl px-3 py-2.5 border transition-colors ${live ? 'border-tide/25 bg-tide/[.04] hover:bg-tide/[.08]' : 'border-line/70 hover:bg-ridge/60'} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-tide/60`}>
                <span className="flex items-center gap-2">
                  <AgentDot a={a} size={8} />
                  <span className="flex-1 min-w-0 truncate text-[13.5px] text-moon">{agentName(a, i)}</span>
                  {ms != null && <span className="flex-none font-mono text-[11.5px] tabular-nums text-ash">{fmtDuration(ms)}</span>}
                </span>
                {line && <span className={`mt-1 pl-[18px] text-[12.5px] line-clamp-2 ${live ? 'font-mono text-[11.5px] text-tide/90' : a.state === 'failed' ? 'text-oxide' : 'text-dust'}`}>{line}</span>}
                <span className="mt-1 block pl-[18px] font-mono text-[11px] text-ash">{[label[a.state], a.toolCalls ? `${a.toolCalls} tools` : '', a.tokens ? `${fmtTokens(a.tokens)} tok` : '', a.model].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// One subagent full-height: back to the overview, ← → between siblings, its transcript below.
function AgentDetail({ order, at, sid, onFocus }: { order: { a: Agent; i: number }[]; at: number; sid?: string; onFocus(key?: string): void }) {
  const { a, i } = order[at], idx = at, agents = order;
  const step = (d: number) => { const n = order[at + d]; if (n) onFocus(n.a.key); };
  return (
    <div className="h-full flex flex-col" tabIndex={-1}
      onKeyDown={e => { if ((e.target as HTMLElement).closest('input, textarea')) return;
        if (e.key === 'ArrowLeft' || e.key === 'h') { e.preventDefault(); step(-1); } if (e.key === 'ArrowRight' || e.key === 'l') { e.preventDefault(); step(1); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onFocus(undefined); } }}>
      <div className="flex items-center gap-1 h-11 px-2 flex-none border-b border-line/70">
        <button onClick={() => onFocus(undefined)} className="press inline-flex items-center gap-1 h-7 pl-1 pr-2 rounded-lg text-[12.5px] text-dust hover:text-moon hover:bg-ridge"><ChevronLeft size={15} />All subagents</button>
        <span className="flex-1" />
        <span className="font-mono text-[11.5px] text-ash tabular-nums mr-1">{idx + 1} / {agents.length}</span>
        <IconButton label="Previous subagent" kbd="←" onClick={() => step(-1)} disabled={idx === 0}><ChevronLeft size={15} /></IconButton>
        <IconButton label="Next subagent" kbd="→" onClick={() => step(1)} disabled={idx === agents.length - 1}><ChevronRight size={15} /></IconButton>
      </div>
      <div className="flex-1 min-h-0"><AgentPage key={a.key} a={a} name={agentName(a, i)} sid={sid} active /></div>
    </div>
  );
}

function AgentPage({ a, name, sid, active }: { a: Agent; name: string; sid?: string; active: boolean }) {
  const rpc = useRpc();
  const [items, setItems] = useState<Item[]>();
  const [steer, setSteer] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const live = isLive(a);
  const load = useCallback(() => {
    if (!a.sessionId) { setItems([]); return; }
    api.get<{ messages: StoredRow[] }>(`/api/sessions/${encodeURIComponent(a.sessionId)}/transcript`)
      .then(r => { const next = fromStored(r.messages).filter(it => it.kind !== 'user' || it.text.trim() !== a.goal.trim()); setItems(x => x && sameJson(x, next) ? x : next); }, () => setItems(x => x ?? []));
  }, [a.sessionId, a.goal]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active || !live) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 3000);
    return () => clearInterval(t);
  }, [active, live, load]);
  // Before paint: pinning in an effect showed each new batch unscrolled for a frame, then jumped.
  useLayoutEffect(() => { const el = scroller.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [items]);

  const elapsed = a.startedAt ? (a.endedAt ?? Date.now()) - a.startedAt : undefined;
  return (
    <div ref={scroller} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}
      className="h-full overflow-y-auto px-3 py-3 space-y-3 text-[13.5px]">
      <header className="space-y-1.5">
        <div className="flex items-center gap-2">
          <AgentDot a={a} size={9} />
          <h3 className="font-bold text-moon flex-1 min-w-0 truncate">{name}</h3>
          {live && sid && a.liveId && <IconButton label="Stop this subagent" onClick={() => rpc.call('subagent.interrupt', { session_id: sid, subagent_id: a.liveId! }).catch(toastError)}><Square size={12} /></IconButton>}
        </div>
        <p className="font-mono text-[11px] text-ash">{[label[a.state], a.model, elapsed != null && fmtDuration(elapsed), a.toolCalls ? `${a.toolCalls} tools` : '', a.tokens ? `${fmtTokens(a.tokens)} tok` : ''].filter(Boolean).join(' · ')}</p>
        <details className="text-[13px] text-dust"><summary className="text-ash hover:text-dust select-none">Task</summary><div className="mt-1 whitespace-pre-wrap">{a.goal}</div></details>
        {live && a.activity && <p className="flex items-center gap-2 text-[12.5px] text-tide"><MoonLoader size={12} label="working" /><span className="truncate">{a.activity}</span></p>}
      </header>
      <div className="space-y-2.5 border-t border-line pt-3">
        {!items ? <div className="space-y-2"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3.5 w-1/2" /></div>
          : !items.length ? <p className="text-dust">{a.sessionId ? 'Nothing recorded yet.' : 'Waiting to start…'}</p>
          : items.map(it => it.kind === 'assistant' ? <AssistantMessage key={it.id} item={it} /> : it.kind === 'reasoning' ? <ReasoningBlock key={it.id} item={it} />
            : it.kind === 'tool' ? <ToolRow key={it.id} item={it} /> : it.kind === 'user' ? <p key={it.id} className="text-[12.5px] text-dust border-l-2 border-tide/40 pl-2 whitespace-pre-wrap">{it.text}</p> : null)}
        {a.summary && <div className="rounded-lg border border-line p-2.5"><p className="label mb-1">Result</p><Markdown text={a.summary} /></div>}
      </div>
      {live && sid && a.liveId && <form className="sticky bottom-0 flex gap-1.5 pt-2 bg-basalt" onSubmit={e => { e.preventDefault(); if (steer.trim()) rpc.call('subagent.steer', { session_id: sid, subagent_id: a.liveId!, text: steer }).then(() => setSteer(''), toastError); }}>
        <input className={inputCls + ' py-1.5 text-[13px]'} placeholder={`Steer ${name}…`} value={steer} onChange={e => setSteer(e.target.value)} />
        <IconButton label="Send to this subagent" type="submit"><Send size={13} /></IconButton>
      </form>}
    </div>
  );
}
