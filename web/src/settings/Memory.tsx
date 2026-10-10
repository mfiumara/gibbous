// What Hermes remembers: facts about you (USER.md) and its own working notes (MEMORY.md), entry by entry.
import { useEffect, useState } from 'react';
import { Pencil, Trash2, Save, Search } from 'lucide-react';
import { hermes } from '../api';
import { toastError } from '../store';
import { Button, IconButton, Skeleton, inputCls, ago } from '../ui';
import { Section } from './common';

interface Node { id: string; label: string; kind: string; memorySource?: 'memory' | 'profile'; timestamp?: number }
interface Card { body: string; fingerprint: string; source: string; timestamp?: number }
interface Entry { id: string; source: 'memory' | 'profile'; body: string; timestamp?: number }

function EntryRow({ e, reload }: { e: Entry; reload(): void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const save = () => hermes.put('learning/node', { id: e.id, content: edit }).then(() => { setEdit(null); reload(); }, toastError);
  const remove = () => confirm('Forget this?') && hermes.del('learning/node', { id: e.id }).then(reload, toastError);
  return (
    <li className="group py-2.5">
      {edit == null ? <div className="flex gap-3">
        <p className="flex-1 text-[13.5px] whitespace-pre-wrap">{e.body}</p>
        <div className="flex-none flex items-start opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <IconButton label="Edit" onClick={() => setEdit(e.body)}><Pencil size={13} /></IconButton>
          <IconButton label="Forget" onClick={remove}><Trash2 size={13} /></IconButton>
        </div>
      </div> : <div className="space-y-2 animate-fade">
        <textarea autoFocus value={edit} onChange={x => setEdit(x.target.value)} className={inputCls + ' min-h-24 text-[13.5px]'} />
        <div className="flex justify-end gap-2"><Button size="sm" onClick={() => setEdit(null)}>Cancel</Button><Button size="sm" tone="primary" onClick={save}><Save size={12} />Save</Button></div>
      </div>}
      {e.timestamp && <p className="text-[11px] text-ash mt-0.5">{ago(e.timestamp * 1000)} ago</p>}
    </li>
  );
}

export function MemoryTab() {
  const [entries, setEntries] = useState<Entry[]>();
  const [q, setQ] = useState('');
  const load = () => hermes.get<{ nodes: Node[]; memory: Card[] }>('learning/graph').then(g => {
    // Node ids end with the entry's fingerprint; the matching card carries the full text.
    const body = new Map(g.memory.map(c => [c.fingerprint, c.body]));
    setEntries(g.nodes.filter(n => n.kind === 'memory').map(n => ({ id: n.id, source: n.memorySource ?? 'memory', body: body.get(n.id.split(':').pop()!) ?? n.label, timestamp: n.timestamp })));
  }, toastError);
  useEffect(() => { load(); }, []);
  if (!entries) return <Skeleton className="h-64 rounded-2xl" />;
  const match = (e: Entry) => !q || e.body.toLowerCase().includes(q.toLowerCase());
  const group = (src: Entry['source'], title: string, description: string) => {
    const list = entries.filter(e => e.source === src && match(e));
    return <Section title={`${title} · ${entries.filter(e => e.source === src).length}`} description={description}>
      {list.length ? <ul className="divide-y divide-line">{list.map(e => <EntryRow key={e.id} e={e} reload={load} />)}</ul> : <p className="text-sm text-dust">Nothing here{q ? ' matches' : ' yet'}.</p>}
    </Section>;
  };
  return <>
    <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" /><input className={inputCls + ' pl-9'} placeholder="Search memory" value={q} onChange={e => setQ(e.target.value)} /></div>
    {group('profile', 'About you', 'What the agent has learned about you and your preferences (USER.md). Every session reads it.')}
    {group('memory', 'Notes', "The agent's own working notes: environment facts, conventions, lessons learned (MEMORY.md).")}
  </>;
}
