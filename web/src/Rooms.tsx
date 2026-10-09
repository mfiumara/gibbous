// Bot Mode rooms: two to six Hermes profiles discuss in one room; you post, they answer in turn.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, Users, ArrowUp, Trash2, Bot } from 'lucide-react';
import { rpc } from './rpc';
import { toastError } from './store';
import { Button, IconButton, Modal, Field, Skeleton, inputCls, go, ago, useDraft } from './ui';
import { PageHeader } from './Inbox';
import { Markdown } from './thread/Items';
import type { Room, RoomEvent, ProfileRow } from './hermes/contract';

// Room timestamps may be seconds or milliseconds.
const ms = (t: number) => t < 1e12 ? t * 1000 : t;

function NewRoom({ open, onClose }: { open: boolean; onClose(): void }) {
  const [name, setName] = useState('');
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => { if (open) rpc.call('profiles.list', {}).then(r => setProfiles(r.profiles ?? []), toastError); }, [open]);
  const create = async () => {
    try {
      const room_id = `room_${Date.now().toString(36)}`;
      await rpc.call('groups.create', { room_id, name, members: picked.map(p => ({ member_id: p, profile: p, handle: p })) });
      onClose(); setName(''); setPicked([]); go(`/rooms/${room_id}`);
    } catch (e) { toastError(e); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New room">
      <p className="text-sm text-dust">Pick two to six profiles.</p>
      <Field label="Name"><input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="Architecture review" autoFocus /></Field>
      <Field label="Members">
        <div className="flex flex-wrap gap-1.5">{profiles.map(p => { const on = picked.includes(p.name); return (
          <button key={p.name} aria-pressed={on} disabled={!on && picked.length >= 6} onClick={() => setPicked(x => on ? x.filter(y => y !== p.name) : [...x, p.name])}
            className={`press h-8 px-3 rounded-lg border text-[13px] disabled:opacity-40 ${on ? 'border-tide/60 bg-tide/10 text-moon' : 'border-line text-dust'}`}>{p.display_name || p.name}</button>
        ); })}</div>
      </Field>
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!name || picked.length < 2} onClick={create}>Create room</Button></div>
    </Modal>
  );
}

function RoomView({ id }: { id: string }) {
  const [room, setRoom] = useState<Room>();
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [text, setText] = useDraft(`room:${id}`);
  const cursor = useRef<number | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    setEvents([]); cursor.current = undefined;
    rpc.call('groups.state', { room_id: id }).then(r => alive && setRoom(r.room), toastError);
    const poll = async () => {
      const r = await rpc.call('groups.log', { room_id: id, since_seq: cursor.current, limit: 200 }).catch(() => null);
      if (!alive || !r) return;
      if (r.events.length) setEvents(e => [...e, ...r.events.filter(x => !e.some(y => y.seq === x.seq))]);
      cursor.current = r.cursor;
    };
    poll();
    const h = setInterval(poll, 2000); // ponytail: polling the room log; the gateway has no room event stream to subscribe to here
    return () => { alive = false; clearInterval(h); };
  }, [id]);
  useLayoutEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [events.length]);
  const send = async () => {
    const t = text.trim(); if (!t) return;
    setText('');
    try { await rpc.call('groups.send', { room_id: id, payload: { text: t, thread_id: `t_${Date.now().toString(36)}` } }); } catch (e) { toastError(e); setText(t); }
  };
  const working = events.filter(e => e.kind === 'turn.started').length > events.filter(e => /turn\.(settled|failed|cancelled)/.test(e.kind)).length;
  const name = (e: RoomEvent) => e.actor.kind === 'user' ? 'You' : room?.members?.find((m: any) => m.member_id === e.actor.id || m.member_id === (e.payload as any).member_id)?.handle ?? e.actor.id;
  return (
    <div className="h-full flex flex-col">
      <PageHeader title={room?.name ?? 'Room'}>
        <span className="label ml-2">{room?.members?.map((m: any) => m.handle).join(' · ')}</span>
        <span className="ml-auto"><IconButton label="Disband room" onClick={() => confirm('Disband this room?') && rpc.call('groups.disband', { room_id: id }).then(() => go('/rooms'), toastError)}><Trash2 size={15} /></IconButton></span>
      </PageHeader>
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto"><div className="mx-auto max-w-3xl px-4 py-6 space-y-4">
        {!room && <Skeleton className="h-24" />}
        {events.filter(e => e.kind.startsWith('message.')).map(e => {
          const mine = e.actor.kind === 'user';
          const body = String((e.payload as any).text ?? '');
          return mine
            ? <div key={e.seq} className="flex justify-end animate-rise"><div className="max-w-[85%] rounded-2xl rounded-br-md bg-ridge px-3.5 py-2 whitespace-pre-wrap">{body}</div></div>
            : <div key={e.seq} className="animate-rise"><p className="label mb-1">{name(e)} · {ago(ms(e.created_at))}</p><Markdown text={body} /></div>;
        })}
        {working && <p className="text-[13px] text-tide animate-pulse">Members are replying…</p>}
      </div></div>
      <div className="flex-none px-3 pb-3 pt-1"><div className="mx-auto max-w-3xl surface rounded-2xl flex items-end gap-2 p-2">
        <textarea value={text} onChange={e => setText(e.target.value)} rows={1} placeholder="Say something to the room" aria-label="Message the room"
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] placeholder:text-ash focus:outline-none" />
        <button onClick={send} disabled={!text.trim()} aria-label="Send" className="press size-8 grid place-items-center rounded-full bg-moon text-basalt disabled:opacity-25"><ArrowUp size={17} strokeWidth={2.5} /></button>
      </div></div>
    </div>
  );
}

// Bots made in the official Hermes desktop app live in each profile's ui_meta: an identity, and group rooms whose
// logs the desktop app keeps there. Shown read-only; Gibbous doesn't drive them.
interface BotMeta { title?: string; color?: string; shape?: string; groups?: string[] }
interface BotRoom { name: string; log?: { from?: { kind?: string; name?: string }; text?: string; at?: number }[] }
const botOf = (p: ProfileRow) => (p as any).ui_meta?.['hermes-bots'] as BotMeta | undefined;

function BotChip({ p }: { p: ProfileRow }) {
  const b = botOf(p)!;
  return (
    <li className="tile flex items-center gap-2.5 rounded-xl px-3 py-2" data-tip={p.description || undefined}>
      <span className={`size-6 grid place-items-center text-[11px] font-bold text-white ${b.shape === 'square' ? 'rounded-md' : 'rounded-full'}`} style={{ background: b.color ?? 'var(--color-ridge)' }}>{(b.title || p.name)[0].toUpperCase()}</span>
      <span className="min-w-0"><span className="block text-[13px] font-bold truncate">{b.title || p.name}</span>{b.title && b.title !== p.name && <span className="block text-[11.5px] text-dust font-mono truncate">{p.name}</span>}</span>
    </li>
  );
}

function DesktopBots() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [open, setOpen] = useState<BotRoom | null>(null);
  useEffect(() => { rpc.call('profiles.list', {}).then(r => setProfiles(r.profiles ?? []), () => {}); }, []);
  const bots = profiles.filter(p => botOf(p));
  const rooms = profiles.flatMap(p => Object.values(((p as any).ui_meta?.['hermes-bots-groups']?.rooms ?? {}) as Record<string, BotRoom>));
  if (!bots.length && !rooms.length) return null;
  return (
    <section className="mx-auto max-w-2xl px-4 pb-8 space-y-3">
      <div><h2 className="font-bold text-[15px] flex items-center gap-2"><Bot size={15} className="text-dust" />Bots from the Hermes desktop app</h2>
        <p className="text-[13px] text-dust">Read-only. Edit them in the Hermes desktop app.</p></div>
      <ul className="grid sm:grid-cols-2 gap-2">{bots.map(p => <BotChip key={p.name} p={p} />)}</ul>
      {rooms.length > 0 && <ul className="space-y-1.5">{rooms.map(r => (
        <li key={r.name}><button onClick={() => setOpen(r)} className="press tile w-full flex items-center gap-3 rounded-xl px-4 py-2.5 text-left">
          <Users size={15} className="text-dust" /><span className="flex-1 font-bold text-[13.5px] truncate">{r.name}</span>
          <span className="text-xs text-ash">{r.log?.length ?? 0} messages{r.log?.length ? ` · ${ago(r.log[r.log.length - 1].at ?? 0)}` : ''}</span>
        </button></li>
      ))}</ul>}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.name ?? ''} wide>
        <div className="max-h-[60vh] overflow-y-auto space-y-3 pr-1">{(open?.log ?? []).map((m, i) => (
          <div key={i}><p className="label mb-0.5">{m.from?.kind === 'user' ? 'You' : m.from?.name ?? 'bot'}{m.at ? ` · ${ago(m.at)}` : ''}</p><Markdown text={String(m.text ?? '')} /></div>
        ))}</div>
      </Modal>
    </section>
  );
}

export function RoomsView({ id }: { id?: string }) {
  const [rooms, setRooms] = useState<Room[]>();
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!id) rpc.call('groups.list', {}).then(r => setRooms(r.rooms), e => { toastError(e); setRooms([]); }); }, [id]);
  if (id) return <RoomView id={id} />;
  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Rooms"><span className="ml-auto"><Button size="sm" tone="primary" onClick={() => setCreating(true)}><Plus size={14} />New room</Button></span></PageHeader>
      {rooms && !rooms.length ? <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-sm px-4 pt-16 pb-10 text-center space-y-4"><p className="font-bold">No rooms yet</p><p className="text-sm text-dust">Group chats between your Hermes profiles.</p><Button tone="primary" onClick={() => setCreating(true)}>Create a room</Button></div>
          <DesktopBots /></div>
        : <div className="flex-1 overflow-y-auto"><ul className="mx-auto max-w-2xl p-4 space-y-2">{(rooms ?? []).map(r => (
          <li key={r.room_id}><a href={`#/rooms/${r.room_id}`} className="press tile flex items-center gap-3 rounded-xl px-4 py-3">
            <Users size={16} className="text-dust" /><span className="flex-1 min-w-0"><span className="block font-bold truncate">{r.name}</span><span className="block text-[12.5px] text-dust truncate">{(r.members ?? []).map((m: any) => m.handle).join(' · ')}</span></span>
            <span className="text-xs text-ash">{ago(ms(r.updated_at))}</span>
          </a></li>
        ))}</ul><DesktopBots /></div>}
      <NewRoom open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
