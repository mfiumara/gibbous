// A coordinator thread's team: the worker threads it spawned through the Gibbous tools, live.
import { useMemo } from 'react';
import { useStore } from '../store';
import { Moon, Button, Empty, go, ago, fmtUsd } from '../ui';
import type { Thread } from '../api';
import { Markdown } from '../thread/Items';

export function TeamPanel({ thread }: { thread: Thread }) {
  const threads = useStore(s => s.threads);
  const team = useMemo(() => threads.filter(t => t.parentId === thread.id).sort((a, b) => a.createdAt - b.createdAt), [threads, thread.id]);
  if (!team.length) return <Empty title="No team yet">Workers this thread starts appear here.</Empty>;
  const cost = team.reduce((n, t) => n + (t.usage?.costUsd ?? 0), 0);
  return (
    <div className="h-full overflow-y-auto p-3 space-y-2.5">
      <p className="label px-1">{team.length} worker{team.length > 1 ? 's' : ''} · {team.filter(t => t.status === 'running').length} running{cost ? ` · ${fmtUsd(cost)}` : ''}</p>
      {team.map((t: Thread) => (
        <article key={t.id} className="rounded-xl surface p-3 space-y-2 animate-rise">
          <div className="flex items-center gap-2">
            <Moon thread={t.status} size={10} />
            <span className="flex-1 min-w-0 font-bold text-sm truncate">{t.title}</span>
            <span className="text-[11px] text-ash">{ago(t.updatedAt)}</span>
          </div>
          {t.worktree && <p className="font-mono text-[11.5px] text-dust truncate">{t.worktree.branch}</p>}
          {t.lastText && <div className="text-[12.5px] text-dust max-h-28 overflow-hidden [mask-image:linear-gradient(black_70%,transparent)]"><Markdown text={t.lastText.slice(-1200)} /></div>}
          {t.error && <p className="text-[12.5px] text-oxide">{t.error}</p>}
          <div className="flex gap-1.5">
            <Button size="sm" onClick={() => go(`/t/${t.id}`)}>Open</Button>
            {t.worktree && <Button size="sm" onClick={() => { localStorage.setItem('gibbous.panel', 'changes'); go(`/t/${t.id}`); }}>Diff</Button>}
          </div>
        </article>
      ))}
    </div>
  );
}
