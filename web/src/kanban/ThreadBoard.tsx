// The thread's project board in the thread's right column (narrow: a strip above the chat), shaped like the subagent
// card: one line while folded, a row per running or blocked task when open. The header folds; a row opens that task on
// the board; "Open board" opens the whole board. Hidden when nothing runs or waits there.
import { useEffect, useState } from 'react';
import { ChevronRight, KanbanSquare, ArrowUpRight } from 'lucide-react';
import { api } from '../api';
import { Elapsed, Moon, go } from '../ui';
import { shortModel } from '../thread/ModelPicker';
import { role } from './Graph';
import { chains, type BoardTask } from './board';

type Board = { slug: string; name: string; tasks: BoardTask[]; now: number } | null;
const FOLD_KEY = 'gibbous.boardCard.open';
const cache = new Map<string, Board>();   // last answer per thread: switching threads shows it at once
// The rail and the inline strip both ask: one request per thread at a time, answers shared.
const inflight = new Map<string, Promise<Board>>();
const fetchBoard = (id: string) => inflight.get(id) ?? (inflight.set(id, api.get<Board>(`/api/threads/${id}/kanban`).finally(() => setTimeout(() => inflight.delete(id), 2000))), inflight.get(id)!);

export function useThreadBoard(threadId: string) {
  const [b, setB] = useState<Board>(() => cache.get(threadId) ?? null);
  useEffect(() => {
    setB(cache.get(threadId) ?? null);
    let dead = false;
    const load = () => { if (document.visibilityState === 'visible') fetchBoard(threadId).then(r => { cache.set(threadId, r); if (!dead) setB(r); }, () => {}); };
    load();
    const h = setInterval(load, 15_000);
    addEventListener('visibilitychange', load);
    return () => { dead = true; clearInterval(h); removeEventListener('visibilitychange', load); };
  }, [threadId]);
  return b?.tasks.length ? b : null;
}

export function ThreadBoardCard({ board, rail = false }: { board: NonNullable<Board>; rail?: boolean }) {
  const [open, setOpen] = useState(() => localStorage.getItem(FOLD_KEY) === '1');
  const toggle = () => { const n = !open; localStorage.setItem(FOLD_KEY, n ? '1' : '0'); setOpen(n); };
  const running = board.tasks.filter(t => t.status === 'running'), blocked = board.tasks.filter(t => t.status === 'blocked');
  const lead = running[0] ?? board.tasks[0];
  const toTask = (id?: string) => go(`/kanban/${board.slug}${id ? `?task=${encodeURIComponent(id)}` : ''}`);
  const summary = [running.length && `${running.length} running`, blocked.length && `${blocked.length} blocked`].filter(Boolean).join(' · ');
  const card = <div className="group/kb rounded-xl surface bg-basalt">
    <div className="flex items-center pr-1.5">
      <button onClick={toggle} aria-expanded={open} aria-label={open ? 'Fold board tasks' : 'Show board tasks'} className="press flex-1 min-w-0 flex items-center px-3 py-2 text-left rounded-xl">
        <span className={`grid place-items-center overflow-hidden flex-none transition-[opacity,scale,width,margin] duration-300 ease-out ${open ? 'w-0 mr-0 opacity-0 scale-50' : 'w-4 mr-2.5'}`}><Moon kanban={running.length ? 'running' : 'blocked'} size={10} /></span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5 text-[12.5px] text-moon"><KanbanSquare size={12} className="text-ash flex-none" /><span className="truncate">{board.name}</span><span className={`flex-none text-[11.5px] text-dust`}>{summary}</span></span>
          <span className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${open ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]'}`}><span className="min-h-0 overflow-hidden"><span className="block truncate text-[11.5px] text-dust">{lead.title}</span></span></span>
        </span>
        <ChevronRight size={14} className={`flex-none ml-2 text-ash transition-[transform,color] duration-300 ease-out group-hover/kb:text-moon ${open ? 'rotate-90' : ''}`} />
      </button>
    </div>
    <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`} inert={!open}>
      <div className={`min-h-0 overflow-hidden transition-[opacity,translate] duration-300 ease-out ${open ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'}`}>
        <ul aria-label="Board tasks" className="px-1.5 max-h-[55dvh] overflow-y-auto">{chains(board.tasks).map(g => (
          <li key={g[0].id} className="py-0.5">{g.map((step, i) => {
            // One straight line through the moons of a chain: from the moon down to the next step's moon.
            const up = i > 0, down = i < g.length - 1;
            const line = <>{up && <span aria-hidden className="absolute left-[13.5px] top-0 h-[15px] w-px bg-line" />}{down && <span aria-hidden className="absolute left-[13.5px] top-[19px] bottom-0 w-px bg-line" />}</>;
            if (step.kind === 'next') return (
              <button key={step.id} onClick={() => toTask(step.id)} data-tip={`Next: ${step.title}`} className="press relative w-full flex items-start gap-2.5 px-1.5 py-1 rounded-lg text-left text-ash transition-colors duration-200 hover:text-moon hover:bg-ridge/60">
                {line}<span className="w-4 h-[18px] grid place-items-center flex-none"><Moon kanban={step.status} size={8} /></span>
                <span className="flex-1 min-w-0 truncate text-[12px]">{step.title}</span>
              </button>);
            const t = step.task;
            return (
            <button key={t.id} onClick={() => toTask(t.id)} data-tip={t.title} className="press relative w-full flex items-start gap-2.5 px-1.5 py-1.5 rounded-lg text-left text-dust transition-colors duration-200 hover:text-moon hover:bg-ridge/60">
              {line}<span className="w-4 h-[18px] grid place-items-center flex-none"><Moon kanban={t.status} size={10} /></span>
              <span className="flex-1 min-w-0">
                <span className="block truncate text-[12.5px] text-moon/90">{t.title}</span>
                <span className="flex items-center gap-1.5 min-w-0 text-[11px] text-ash">
                  {t.assignee && <span className="truncate min-w-0">{role(t.assignee)}</span>}
                  {t.model && <span className="font-mono truncate min-w-0">{shortModel(t.model)}{t.effort ? `·${t.effort.slice(0, 3)}` : ''}</span>}
                  {t.fromChat && <span className="flex-none text-tide" data-tip="Filed from this chat">from this chat</span>}
                  <span className="ml-auto flex-none font-mono">{t.status === 'running' && t.runStartedAt ? <span className="text-tide"><Elapsed since={t.runStartedAt * 1000} /></span> : <span className="text-halo">{t.blockKind ?? 'blocked'}</span>}</span>
                </span>
              </span>
            </button>);
          })}</li>
        ))}</ul>
        <button onClick={() => toTask()} className="press w-full flex items-center gap-1.5 px-3 h-8 border-t border-line/60 text-[11.5px] text-ash hover:text-moon"><span className="flex-1 text-left">Open board</span><ArrowUpRight size={12} /></button>
      </div>
    </div>
  </div>;
  if (rail) return <section aria-label="Kanban board" className="w-full animate-fade">{card}</section>;
  return <section aria-label="Kanban board" data-inline-tasks className="mx-auto w-full max-w-3xl px-4 pt-3 flex-none animate-fade">{card}</section>;
}
