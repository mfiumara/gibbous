// Subagents: a count chip in the composer, one quiet line per subagent in the timeline, and a side panel that pages
// through each subagent's own transcript (swipe / two-finger scroll / ← → / the tabs).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, Square, Send, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useRpc } from '../rpc';
import { toastError } from '../store';
import { IconButton, MoonLoader, Skeleton, inputCls, fmtTokens, fmtDuration, sameJson } from '../ui';
import { fromStored, type Item, type StoredRow } from './timeline';
import { AssistantMessage, ToolRow, ReasoningBlock, Markdown } from './Items';
import { mergeAgents, agentCounts, agentName, isLive, type Agent, type AgentState, type StoredSub, type LiveSub } from './agents';

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
const tone: Record<AgentState, string> = { running: 'bg-tide', queued: 'bg-ash', done: 'bg-moon/80', failed: 'bg-oxide', stopped: 'bg-halo', quiet: 'bg-ash/60' };
const label: Record<AgentState, string> = { running: 'working', queued: 'queued', done: 'done', failed: 'failed', stopped: 'stopped', quiet: 'no activity' };

export function AgentDot({ a, size = 8 }: { a: Agent; size?: number }) {
  if (a.state === 'running') return <MoonLoader size={size + 4} label="working" />;
  return <span aria-label={label[a.state]} className={`inline-block flex-none rounded-full ${tone[a.state]}`} style={{ width: size, height: size }} />;
}

function summaryLine(agents: Agent[]) {
  const c = agentCounts(agents);
  return [c.running && `${c.running} working`, c.queued && `${c.queued} queued`, c.done && `${c.done} done`, c.failed && `${c.failed} failed`, c.other && `${c.other} idle`].filter(Boolean).join(' · ');
}

// Composer chip: "◐ 3/7" — how many are working out of all of them; click for the panel.
export function SubagentChip({ agents, onOpen }: { agents: Agent[]; onOpen(): void }) {
  if (!agents.length) return null;
  const c = agentCounts(agents), active = c.running + c.queued;
  return (
    <button onClick={onOpen} aria-label={`${agents.length} subagents: ${summaryLine(agents)}`}
      data-tip={`${agents.length} subagent${agents.length > 1 ? 's' : ''} · ${summaryLine(agents)}\nClick to watch them side by side.`}
      className={`press inline-flex items-center gap-1.5 h-8 px-1.5 sm:px-2 rounded-lg text-[12px] hover:bg-ridge flex-none ${active ? 'text-tide' : 'text-dust hover:text-moon'}`}>
      {active ? <MoonLoader size={13} label="subagents working" /> : <Bot size={14} />}
      <span className="tabular-nums">{active ? `${active}/${agents.length}` : agents.length}</span>
    </button>
  );
}

// Timeline: one line per subagent where the delegation happened, instead of a big card each.
export function SubagentLine({ item, agents, onOpen }: { item: LiveSub; agents: Agent[]; onOpen(key: string): void }) {
  const a = agents.find(x => x.liveId === item.id) ?? mergeAgents([], [item])[0];
  const i = agents.indexOf(a);
  return (
    <button onClick={() => onOpen(a.key)} className="press w-[calc(100%+0.75rem)] -mx-1.5 px-1.5 py-1 flex items-center gap-2 rounded-md text-left text-[13px] text-dust hover:text-moon hover:bg-crater/70">
      <Bot size={14} className="flex-none text-ash" />
      <span className="font-mono text-moon/90 flex-none">{agentName(a, i < 0 ? item.index : i)}</span>
      <span className="truncate min-w-0 text-ash">{a.activity ?? a.goal.replace(/^[^:]{1,24}:\s*/, '')}</span>
      <span className="ml-auto pl-2 flex items-center gap-1.5 flex-none text-[11px] font-mono text-ash"><AgentDot a={a} size={7} />{label[a.state]}</span>
    </button>
  );
}

// ── the panel ─────────────────────────────────────────────────────────
export function SubagentsPanel({ agents, sid, focus, onFocus }: { agents: Agent[]; sid?: string; focus?: string; onFocus(key: string): void }) {
  const pager = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, agents.findIndex(a => a.key === focus));
  const scrolling = useRef(false);

  // Focus from outside (chip, timeline line, tab) → scroll that page into view.
  useEffect(() => {
    const el = pager.current; if (!el || !agents.length) return;
    const target = idx * el.clientWidth;
    // Jump, don't animate: a smooth scroll fires scroll events mid-way that would re-focus the pages it passes.
    if (Math.abs(el.scrollLeft - target) > 4) { scrolling.current = true; el.scrollLeft = target; setTimeout(() => { scrolling.current = false; }, 60); }
    tabs.current?.children[idx]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [idx, agents.length, focus]);
  useEffect(() => { if (!focus && agents.length) onFocus((agents.find(isLive) ?? agents[0]).key); }, [focus, agents.length]);

  useEffect(() => {
    const el = pager.current; if (!el) return;
    const ro = new ResizeObserver(() => { el.scrollLeft = idx * el.clientWidth; });
    ro.observe(el);
    return () => ro.disconnect();
  }, [idx]);

  // Swiping (touch or trackpad) moves the focus to whichever page snapped in.
  const onScroll = () => {
    const el = pager.current; if (!el || scrolling.current) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (agents[i] && agents[i].key !== focus) onFocus(agents[i].key);
  };
  const step = (d: number) => { const a = agents[Math.min(agents.length - 1, Math.max(0, idx + d))]; if (a) onFocus(a.key); };

  if (!agents.length) return <p className="p-4 text-sm text-dust">No subagents in this thread yet. They show up here as soon as Hermes delegates work.</p>;
  return (
    <div className="h-full flex flex-col" tabIndex={-1}
      onKeyDown={e => { if ((e.target as HTMLElement).closest('input, textarea')) return; if (e.key === 'ArrowLeft' || e.key === 'h') { e.preventDefault(); step(-1); } if (e.key === 'ArrowRight' || e.key === 'l') { e.preventDefault(); step(1); } }}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line flex-none">
        <IconButton label="Previous subagent" kbd="←" onClick={() => step(-1)} disabled={idx === 0}><ChevronLeft size={15} /></IconButton>
        <div ref={tabs} className="flex-1 min-w-0 flex gap-1 overflow-x-auto [scrollbar-width:none]">
          {agents.map((a, i) => (
            <button key={a.key} onClick={() => onFocus(a.key)} aria-pressed={i === idx} data-tip={a.goal.slice(0, 200)}
              className={`press h-7 px-2 rounded-md inline-flex items-center gap-1.5 whitespace-nowrap flex-none text-[12px] ${i === idx ? 'bg-ridge text-moon' : 'text-dust hover:text-moon'}`}
              style={a.depth ? { marginLeft: 6 } : undefined}>
              <AgentDot a={a} size={7} />{agentName(a, i)}
            </button>
          ))}
        </div>
        <IconButton label="Next subagent" kbd="→" onClick={() => step(1)} disabled={idx === agents.length - 1}><ChevronRight size={15} /></IconButton>
      </div>
      <p className="px-3 py-1 text-[11.5px] text-ash border-b border-line flex-none">{agents.length} subagents · {summaryLine(agents)}</p>
      <div ref={pager} onScroll={onScroll} className="flex-1 min-h-0 flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory [scrollbar-width:none] overscroll-x-contain">
        {agents.map((a, i) => (
          <section key={a.key} aria-label={agentName(a, i)} className="snap-start snap-always flex-none w-full h-full min-w-0">
            {Math.abs(i - idx) <= 1 ? <AgentPage a={a} name={agentName(a, i)} sid={sid} active={i === idx} /> : null}
          </section>
        ))}
      </div>
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
        <details className="text-[13px] text-dust"><summary className="cursor-pointer text-ash hover:text-dust select-none">Task</summary><div className="mt-1 whitespace-pre-wrap">{a.goal}</div></details>
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
