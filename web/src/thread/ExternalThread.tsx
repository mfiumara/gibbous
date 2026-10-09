// A conversation owned by another Hermes surface (Discord, Telegram, CLI, Paseo, cron…), shown read-only.
// Gibbous never resumes these sessions; it reads the stored transcript and polls for new messages.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu, MessageSquareShare, Trash2, RefreshCw, ArrowUp } from 'lucide-react';
import { api, type Thread } from '../api';
import { useStore, toastError } from '../store';
import { Button, IconButton, Moon, go, sourceLabel, useDraft, sameJson, NO_PREDICT } from '../ui';
import { fromStored, type StoredRow, type Item } from './timeline';
import { Markdown, ToolRow, ReasoningBlock, UserMessage } from './Items';

import { HostChip } from './ThreadHeader';
import { MESSAGING_SOURCES } from '../../../server/sources.ts';

type Page = { messages: StoredRow[]; pagination: { returned: number } };

export function ExternalThread({ thread }: { thread: Thread }) {
  useEffect(() => { useStore.getState().markSeen(thread.id); }, [thread.id, thread.updatedAt]);
  const [rows, setRows] = useState<StoredRow[]>([]);
  const [older, setOlder] = useState<StoredRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const keepFromBottom = useRef<number | null>(null); // older pages land above: hold the reading position
  const label = sourceLabel(thread.source);
  const canReply = useStore(s => !!s.gatewayReplies) && !thread.host && MESSAGING_SOURCES.has(thread.source ?? ''); // the gateway key is this Mac's
  const [reply, setReply] = useDraft(`x:${thread.id}`);
  const [pending, setPending] = useState<string | null>(null);

  const refresh = useCallback(() => api.get<Page>(`/api/threads/${thread.id}/transcript`).then(p => {
    setRows(r => sameJson(r, p.messages) ? r : p.messages); setHasMore(p.pagination.returned >= 500); setLoading(false);
  }).catch(e => { setLoading(false); toastError(e); }), [thread.id]);

  // New messages land in Hermes' store as the Discord conversation goes on: poll while visible.
  useEffect(() => {
    setRows([]); setOlder([]); setLoading(true); stick.current = true;
    refresh();
    const h = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 6000);
    return () => clearInterval(h);
  }, [refresh]);

  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    if (keepFromBottom.current != null) { el.scrollTop = el.scrollHeight - keepFromBottom.current; keepFromBottom.current = null; }
    else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, older, loading]);

  const loadOlder = async () => {
    stick.current = false;
    const p = await api.get<Page>(`/api/threads/${thread.id}/transcript?offset=${rows.length + older.length}`).catch(toastError);
    if (p) { const el = scroller.current; if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop; setOlder(o => [...p.messages, ...o]); setHasMore(p.pagination.returned >= 500); }
  };
  const cont = async () => {
    setBusy(true);
    try { const t = await api.post<Thread>(`/api/threads/${thread.id}/continue`); go(`/t/${t.id}`); }
    catch (e) { toastError(e); setBusy(false); }
  };
  const remove = async () => {
    if (!confirm(`Remove this conversation from Gibbous's sidebar? It stays in ${label} and in Hermes.`)) return;
    await api.del(`/api/threads/${thread.id}`).catch(toastError);
    go('/');
  };

  const send = async () => {
    const text = reply.trim();
    if (!text || pending) return;
    setPending(text); setReply(''); stick.current = true;
    try { await api.post(`/api/threads/${thread.id}/reply`, { text }); await refresh(); }
    catch (e) { toastError(e); setReply(text); }
    finally { setPending(null); }
  };
  const items: Item[] = fromStored([...older, ...rows]);

  return (
    <div className="flex flex-col h-full min-w-0">
      <header className="flex items-center gap-2 px-3 h-12 border-b border-line flex-none">
        <IconButton label="Open sidebar" className="lg:hidden" onClick={() => useStore.setState({ sidebar: true })}><Menu size={17} /></IconButton>
        <span className="label rounded bg-ridge px-1.5 py-0.5 text-moon/80">{label}</span>
        <h1 className="font-bold truncate min-w-0">{thread.title}</h1>
        {thread.host && <HostChip id={thread.host} />}
        <div className="ml-auto flex items-center gap-1 flex-none">
          <IconButton label="Refresh" onClick={refresh}><RefreshCw size={15} /></IconButton>
          <IconButton label="Remove from sidebar" onClick={remove}><Trash2 size={15} /></IconButton>
        </div>
      </header>

      <div ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-5 space-y-3">
          {hasMore && <button onClick={loadOlder} className="mx-auto block label hover:text-moon">Show earlier messages</button>}
          {loading && <p className="text-dust text-sm">Loading conversation…</p>}
          {!loading && !items.length && <p className="text-dust text-sm">No messages yet.</p>}
          {[...items, ...(pending ? [{ kind: 'user' as const, id: 'pending', text: pending }] : [])].map(it => {
            switch (it.kind) {
              case 'user': return <UserMessage key={it.id} item={it} />;
              case 'assistant': return <Markdown key={it.id} text={it.text} />;
              case 'reasoning': return <ReasoningBlock key={it.id} item={it} />;
              case 'tool': return <ToolRow key={it.id} item={it} />;
              case 'notice': return <p key={it.id} className="text-[12.5px] text-ash border-l border-line pl-3 truncate select-text">{it.text}</p>;
              default: return null;
            }
          })}
        </div>
      </div>

      {pending && <p className="mx-auto max-w-3xl w-full px-4 pb-2 flex items-center gap-2 text-[13px] text-tide animate-fade"><Moon thread="running" size={9} />Hermes is answering through the {label} gateway…</p>}
      <div className="flex-none px-3 pb-3 pt-1">
        {canReply ? (
          <div className="mx-auto max-w-3xl surface rounded-2xl">
            <textarea value={reply} onChange={e => setReply(e.target.value)} rows={1} {...NO_PREDICT} aria-label={`Reply in this ${label} conversation`}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); send(); } }}
              placeholder={`Message Hermes in this ${label} conversation`} className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] placeholder:text-ash focus:outline-none" />
            <div className="flex items-center gap-2 px-3 pb-2.5">
              <span className="flex-1 sm:hidden" />
              <p className="hidden sm:block text-[11.5px] text-ash flex-1">Runs in the {label} gateway, so it's the same conversation; the reply is added here, not posted as a {label} message.</p>
              <Button size="sm" onClick={cont} disabled={busy} data-tip="Copy this conversation into a new Gibbous thread"><MessageSquareShare size={13} />Continue in Gibbous</Button>
              <button onClick={send} disabled={!reply.trim() || !!pending} aria-label="Send" className="press size-8 grid place-items-center rounded-full bg-moon text-basalt disabled:opacity-25"><ArrowUp size={17} strokeWidth={2.5} /></button>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl flex flex-wrap items-center gap-3 rounded-xl border border-line bg-crater px-4 py-3">
            <p className="text-[13px] text-dust flex-1 min-w-48">This conversation lives in {label}. Reply there; new messages show up here within seconds.</p>
            <Button onClick={cont} disabled={busy} data-tip="Copy this conversation into a new Gibbous thread you can keep working in"><MessageSquareShare size={14} />Continue in Gibbous</Button>
          </div>
        )}
      </div>
    </div>
  );
}
