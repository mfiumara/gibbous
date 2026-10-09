// Read-only view of any Hermes session's transcript (a subagent's own conversation, for example).
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toastError } from '../store';
import { Modal, Skeleton } from '../ui';
import { fromStored, type StoredRow, type Item } from './timeline';
import { AssistantMessage, ToolRow, ReasoningBlock, UserMessage } from './Items';

export function TranscriptModal({ sessionId, title, onClose }: { sessionId: string | null; title: string; onClose(): void }) {
  const [items, setItems] = useState<Item[]>();
  useEffect(() => {
    if (!sessionId) return;
    setItems(undefined);
    api.get<{ messages: StoredRow[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/transcript`).then(r => setItems(fromStored(r.messages)), e => { toastError(e); setItems([]); });
  }, [sessionId]);
  return (
    <Modal open={!!sessionId} onClose={onClose} title={title} wide>
      <div className="max-h-[65vh] overflow-y-auto space-y-3 pr-1">
        {!items ? <div className="space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>
          : !items.length ? <p className="text-sm text-dust">This session has no stored messages yet.</p>
          : items.map(it => it.kind === 'user' ? <UserMessage key={it.id} item={it} /> : it.kind === 'assistant' ? <AssistantMessage key={it.id} item={it} />
            : it.kind === 'reasoning' ? <ReasoningBlock key={it.id} item={it} /> : it.kind === 'tool' ? <ToolRow key={it.id} item={it} /> : null)}
      </div>
    </Modal>
  );
}
