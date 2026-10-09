// Full-text search across every Hermes conversation (Gibbous threads, Discord, CLI, cron…).
import { useEffect, useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { api, type Thread } from './api';
import { useStore, toastError } from './store';
import { Skeleton, Empty, inputCls, go, ago, sourceLabel } from './ui';
import { PageHeader } from './Inbox';

interface Hit { session_id: string; snippet: string; role: string; source?: string; session_started?: number; last_active?: number; title?: string; lineage_root?: string }

// Hermes marks matches with >>> <<<; render them as <mark> without trusting the text as HTML.
function Snippet({ text }: { text: string }) {
  const parts = text.replace(/\\n|\n/g, ' ').split(/(>>>.*?<<<)/g);
  return <>{parts.map((p, i) => p.startsWith('>>>') ? <mark key={i} className="bg-halo/25 text-moon rounded px-0.5">{p.slice(3, -3)}</mark> : <span key={i}>{p}</span>)}</>;
}

export function SearchView({ q }: { q: string }) {
  const [input, setInput] = useState(q);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const threads = useStore(s => s.threads);
  useEffect(() => { setInput(q); }, [q]);
  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    setHits(null);
    api.get<{ results: Hit[] }>(`/api/search?q=${encodeURIComponent(q)}`).then(r => setHits(r.results), e => { toastError(e); setHits([]); });
  }, [q]);

  // One row per conversation, best match first.
  const grouped = new Map<string, Hit[]>();
  for (const h of hits ?? []) grouped.set(h.session_id, [...(grouped.get(h.session_id) ?? []), h]);

  const open = async (h: Hit) => {
    const known = threads.find(t => t.sessionId === h.session_id || t.sessionId === h.lineage_root);
    if (known) return go(`/t/${known.id}`);
    try {
      const t = await api.post<Thread>('/api/import', { sessionId: h.session_id, title: h.title || h.snippet.replace(/>>>|<<</g, '').slice(0, 60), source: h.source, startedAt: h.session_started ? h.session_started * 1000 : undefined });
      go(`/t/${t.id}`);
    } catch (e) { toastError(e); }
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Search" />
      <div className="flex-1 overflow-y-auto"><div className="mx-auto max-w-3xl p-4 space-y-4">
        <form onSubmit={e => { e.preventDefault(); go(`/search?q=${encodeURIComponent(input.trim())}`); }} className="relative">
          <SearchIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" />
          <input autoFocus className={inputCls + ' pl-9 h-10 text-[15px]'} placeholder="Search every conversation" value={input} onChange={e => setInput(e.target.value)} />
        </form>
        {hits === null && <div className="space-y-3">{[0, 1, 2, 3].map(i => <div key={i} className="space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-5/6" /></div>)}</div>}
        {hits && q && !grouped.size && <Empty title={`Nothing matches “${q}”`}>Try fewer words.</Empty>}
        <ul className="space-y-1">
          {[...grouped.entries()].map(([sid, list]) => {
            const h = list[0];
            const known = threads.find(t => t.sessionId === sid);
            return (
              <li key={sid} className="animate-rise">
                <button onClick={() => open(h)} className="press w-full text-left rounded-xl px-3 py-3 hover:bg-crater border border-transparent hover:border-line">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="label">{sourceLabel(h.source)}</span>
                    <span className="font-bold text-sm truncate flex-1">{known?.title ?? h.title ?? 'Conversation'}</span>
                    <span className="text-xs text-ash">{list.length > 1 ? `${list.length} matches · ` : ''}{h.last_active ? ago(h.last_active * 1000) : ''}</span>
                  </div>
                  <p className="text-[13px] text-dust line-clamp-2 font-mono"><Snippet text={h.snippet} /></p>
                </button>
              </li>
            );
          })}
        </ul>
      </div></div>
    </div>
  );
}
