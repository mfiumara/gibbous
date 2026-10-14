// The thread's project board in the thread's right column (narrow: a strip above the chat), shaped like the subagent
// card: one line while folded, a row per running or blocked task when open. The header folds; a row opens that task on
// the board; "Open board" opens the whole board. Hidden when nothing runs or waits there.
import { useEffect, useState } from 'react';
import { ChevronRight, KanbanSquare, ArrowUpRight } from 'lucide-react';
import { api, type KanbanCard } from '../api';
import { Elapsed, Moon, MoonLoader, go } from '../ui';
import { shortModel } from '../thread/ModelPicker';
import { role } from './Graph';

type Board = { slug: string; name: string; tasks: (KanbanCard & { fromChat: boolean })[]; now: number } | null;
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
  const card = <div className={`group/kb rounded-xl border transition-[background-color,border-color] duration-300 ease-out ${blocked.length ? 'border-halo/30 bg-halo/[.05] hover:border-halo/50' : 'border-tide/25 bg-tide/[.05] hover:border-tide/45'}`}>
    <div className="flex items-center pr-1.5">
      <button onClick={toggle} aria-expanded={open} aria-label={open ? 'Fold board tasks' : 'Show board tasks'} className="press flex-1 min-w-0 flex items-center px-3 py-2 text-left rounded-xl">
        <span className={`grid place-items-center overflow-hidden flex-none transition-[opacity,scale,width,margin] duration-300 ease-out ${open ? 'w-0 mr-0 opacity-0 scale-50' : 'w-4 mr-2.5'}`}>{running.length ? <MoonLoader size={16} label="kanban tasks running" /> : <Moon kanban="blocked" size={12} />}</span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5 text-[12.5px] text-moon"><KanbanSquare size={12} className="text-ash flex-none" /><span className="truncate">{board.name}</span><span className={`flex-none text-[11.5px] ${blocked.length ? 'text-halo' : 'text-tide'}`}>{summary}</span></span>
          <span className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${open ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]'}`}><span className="min-h-0 overflow-hidden"><span className="block truncate text-[11.5px] text-dust">{lead.title}</span></span></span>
        </span>
        <ChevronRight size={14} className={`flex-none ml-2 text-ash transition-[transform,color] duration-300 ease-out group-hover/kb:text-moon ${open ? 'rotate-90' : ''}`} />
      </button>
    </div>
    <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`} inert={!open}>
      <div className={`min-h-0 overflow-hidden transition-[opacity,translate] duration-300 ease-out ${open ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'}`}>
        <ul aria-label="Board tasks" className="px-1.5 max-h-[45dvh] overflow-y-auto">{board.tasks.map(t => (
          <li key={t.id}>
            <button onClick={() => toTask(t.id)} data-tip={t.title} className="press w-full flex items-start gap-2.5 px-1.5 py-1.5 rounded-lg text-left text-dust transition-colors duration-200 hover:text-moon hover:bg-ridge/60">
              <span className="w-4 h-[18px] grid place-items-center flex-none"><Moon kanban={t.status} size={10} /></span>
              <span className="flex-1 min-w-0">
                <span className="block truncate text-[12.5px] text-moon/90">{t.title}</span>
                <span className="flex items-center gap-1.5 min-w-0 text-[11px] text-ash">
                  {t.assignee && <span className="truncate min-w-0">{role(t.assignee)}</span>}
                  {t.model && <span className="font-mono truncate min-w-0">{shortModel(t.model)}{t.effort ? `·${t.effort.slice(0, 3)}` : ''}</span>}
                  {t.fromChat && <span className="flex-none text-tide" data-tip="Filed from this chat">from this chat</span>}
                  <span className="ml-auto flex-none font-mono">{t.status === 'running' && t.runStartedAt ? <span className="text-tide"><Elapsed since={t.runStartedAt * 1000} /></span> : <span className="text-halo">{t.blockKind ?? 'blocked'}</span>}</span>
                </span>
              </span>
            </button>
          </li>
        ))}</ul>
        <button onClick={() => toTask()} className="press w-full flex items-center gap-1.5 px-3 h-8 border-t border-line/60 text-[11.5px] text-ash hover:text-moon"><span className="flex-1 text-left">Open board</span><ArrowUpRight size={12} /></button>
      </div>
    </div>
  </div>;
  if (rail) return <section aria-label="Kanban board" className="w-full animate-fade">{card}</section>;
  return <section aria-label="Kanban board" data-inline-tasks className="mx-auto w-full max-w-3xl px-4 pt-3 flex-none animate-fade">{card}</section>;
}
