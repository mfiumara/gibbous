// Other machines running Hermes (a Mac mini, a server…), reached over SSH. Threads can run on any of them.
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, FlaskConical, Server, Radar } from 'lucide-react';
import { api } from '../api';
import { useStore, toastError } from '../store';
import { Button, IconButton, Field, inputCls } from '../ui';
import { Section } from './common';

export function HostsTab() {
  const hosts = useStore(s => s.hosts);
  const toast = useStore(s => s.toast);
  const [draft, setDraft] = useState({ name: '', ssh: '', remotePort: '9120' });
  const [peers, setPeers] = useState<{ name: string; dns: string; os: string; online: boolean }[]>([]);
  const sshInput = useRef<HTMLInputElement>(null);
  useEffect(() => { api.get<typeof peers>('/api/tailnet/peers').then(setPeers, () => {}); }, []);
  const known = new Set(hosts.map(h => h.ssh.split('@').pop()));
  // Picking a peer fills in its MagicDNS name; you add the login user (e.g. root@) yourself.
  const pick = (p: (typeof peers)[number]) => { setDraft({ ...draft, name: p.name, ssh: `@${p.dns}` }); requestAnimationFrame(() => { sshInput.current?.focus(); sshInput.current?.setSelectionRange(0, 0); }); };
  const add = () => api.post('/api/hosts', draft).then(() => setDraft({ name: '', ssh: '', remotePort: '9120' }), toastError);
  const test = (id: string) => api.post<{ ok: boolean; output: string }>(`/api/hosts/${id}/test`).then(r => toast({ title: r.ok ? 'Hermes found' : 'Hermes not found', body: r.output, tone: r.ok ? undefined : 'error' }), toastError);
  return <>
    <Section title="Hosts" description="Reached over SSH; nothing listens on the network.">
      {hosts.length > 0 && <ul className="divide-y divide-line">{hosts.map(h => (
        <li key={h.id} className="py-3 flex items-center gap-3 text-sm">
          <Server size={15} className="text-dust" />
          <span className="flex-1 min-w-0"><span className="block font-bold">{h.name}</span><span className="block font-mono text-[12px] text-dust">{h.ssh} · port {h.remotePort}</span></span>
          <span className="flex items-center gap-1.5 text-[12px]"><span className={`size-1.5 rounded-full ${h.connected ? 'bg-sprout' : 'bg-halo animate-pulse'}`} />{h.connected ? 'connected' : 'connecting'}</span>
          <IconButton label="Test SSH" onClick={() => test(h.id)}><FlaskConical size={14} /></IconButton>
          <IconButton label="Remove host" onClick={() => confirm(`Remove ${h.name}? Its threads stay listed but can't be opened.`) && api.del(`/api/hosts/${h.id}`).catch(toastError)}><Trash2 size={14} /></IconButton>
        </li>
      ))}</ul>}
      <div className="grid sm:grid-cols-[1fr_1fr_6rem_auto] gap-2 items-end">
        <Field label="Name"><input className={inputCls} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Mac mini" /></Field>
        <Field label="SSH target"><input ref={sshInput} className={inputCls + ' font-mono'} value={draft.ssh} onChange={e => setDraft({ ...draft, ssh: e.target.value })} placeholder="me@mini.local" /></Field>
        <Field label="Port"><input className={inputCls + ' font-mono'} value={draft.remotePort} onChange={e => setDraft({ ...draft, remotePort: e.target.value })} /></Field>
        <Button tone="primary" className="h-9" disabled={!draft.ssh} onClick={add}><Plus size={14} />Add</Button>
      </div>
      <p className="text-xs text-dust">On a Tailscale SSH machine in <em>check</em> mode, run <span className="font-mono">ssh {draft.ssh || 'user@host'} true</span> once in Terminal and approve the browser prompt; Gibbous can't answer it. Needs SSH key login that works without a password prompt (try <span className="font-mono">ssh {draft.ssh || 'host'} true</span>). Remote threads are chats on that machine; projects, worktrees and the board stay on this Mac.</p>
    </Section>
    {peers.length > 0 && <Section title="On your tailnet" description="Pick one, then add the login user in front.">
      <ul className="divide-y divide-line">{peers.map(p => (
        <li key={p.dns} className="py-2.5 flex items-center gap-3 text-sm">
          <Radar size={14} className={p.online ? 'text-sprout' : 'text-ash'} />
          <span className="flex-1 min-w-0"><span className="block font-bold truncate">{p.name}</span><span className="block font-mono text-[12px] text-dust truncate">{p.dns} · {p.os}{p.online ? '' : ' · offline'}</span></span>
          {known.has(p.dns) ? <span className="label text-tide">added</span> : <Button size="sm" disabled={!p.online} onClick={() => pick(p)}>Use</Button>}
        </li>
      ))}</ul>
    </Section>}
  </>;
}
