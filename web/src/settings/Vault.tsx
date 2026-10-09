// Vault: logins and cards Hermes can fill in the browser; connectors: hosted account integrations.
import { useEffect, useState } from 'react';
import { Lock, Unlock, Plus, Trash2, KeyRound, CreditCard, MapPin, Link2 } from 'lucide-react';
import { rpc } from '../rpc';
import { toastError, useStore } from '../store';
import { Button, IconButton, Modal, Field, Switch, Skeleton, inputCls } from '../ui';
import { Section } from './common';

interface Item { id: string; kind: 'login' | 'payment' | 'address'; label: string; origin?: string; identifier?: string; backend?: string; has_otp?: boolean }
interface Source { name: string; display_name: string; enabled: boolean; needs_unlock: boolean; unlocked: boolean; installed: boolean }
const icon = { login: KeyRound, payment: CreditCard, address: MapPin };

function AddLogin({ open, onClose, onDone }: { open: boolean; onClose(): void; onDone(): void }) {
  const [f, setF] = useState({ label: '', origin: '', identifier: '', password: '', otp: '' });
  const save = () => rpc.call('vault.add', { kind: 'login', label: f.label || f.origin, origin: f.origin, secret: { identifier: f.identifier, identifier_type: f.identifier.includes('@') ? 'email' : 'username', password: f.password, ...(f.otp ? { otp_secret: f.otp } : {}) } })
    .then(() => { onDone(); onClose(); setF({ label: '', origin: '', identifier: '', password: '', otp: '' }); }, toastError);
  return (
    <Modal open={open} onClose={onClose} title="Save a login">
      <p className="text-sm text-dust">The password never appears in a conversation.</p>
      <Field label="Website"><input className={inputCls} value={f.origin} onChange={e => setF({ ...f, origin: e.target.value })} placeholder="https://github.com" autoFocus /></Field>
      <Field label="Label (optional)"><input className={inputCls} value={f.label} onChange={e => setF({ ...f, label: e.target.value })} /></Field>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Email or username"><input className={inputCls} value={f.identifier} onChange={e => setF({ ...f, identifier: e.target.value })} autoComplete="off" /></Field>
        <Field label="Password"><input type="password" className={inputCls} value={f.password} onChange={e => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
      </div>
      <Field label="2FA secret (optional)" hint="The base32 TOTP secret, so Hermes can produce codes."><input className={inputCls + ' font-mono'} value={f.otp} onChange={e => setF({ ...f, otp: e.target.value })} autoComplete="off" /></Field>
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!f.origin || !f.identifier || !f.password} onClick={save}>Save login</Button></div>
    </Modal>
  );
}

function Connectors() {
  const [state, setState] = useState<{ available: boolean; connectors: { connector: string; enabled: boolean; connected: boolean; connection_status?: string }[] } | null>();
  useEffect(() => { rpc.call('connectors.list', { owner: { type: 'account' } }).then((r: any) => setState(r), () => setState(null)); }, []);
  if (state === undefined) return null;
  if (!state || !state.available) return <Section title="Connectors" description="Not available with this Hermes setup." />;
  const connect = (slug: string) => rpc.call('connectors.connect', { owner: { type: 'account' }, connectors: [slug] }).then((op: any) => { const url = op.targets?.find((t: any) => t.connect_url)?.connect_url; if (url) window.open(url, '_blank'); useStore.getState().toast({ title: `Connecting ${slug}…` }); }, toastError);
  return (
    <Section title="Connectors">
      <ul className="divide-y divide-line">{state.connectors.map(c => (
        <li key={c.connector} className="py-2.5 flex items-center gap-3 text-sm">
          <Link2 size={14} className={c.connected ? 'text-sprout' : 'text-ash'} />
          <span className="flex-1 font-mono">{c.connector}</span><span className="label">{c.connection_status ?? (c.connected ? 'connected' : 'not connected')}</span>
          {!c.connected && <Button size="sm" onClick={() => connect(c.connector)}>Connect</Button>}
        </li>
      ))}</ul>
    </Section>
  );
}

export function VaultTab() {
  const [items, setItems] = useState<Item[]>();
  const [sources, setSources] = useState<Source[]>([]);
  const [adding, setAdding] = useState(false);
  const [unlocking, setUnlocking] = useState<Source | null>(null);
  const [pw, setPw] = useState('');
  const load = () => {
    rpc.call('vault.list', {}).then((r: any) => setItems(r.items ?? []), e => { toastError(e); setItems([]); });
    rpc.call('vault.sources', {}).then((r: any) => setSources(r.sources ?? []), () => {});
  };
  useEffect(() => { load(); }, []);
  const unlock = () => rpc.call('vault.unlock', { name: unlocking!.name, password: pw }).then(() => { setUnlocking(null); setPw(''); load(); }, toastError);
  return <>
    <Section title="Vault" description="Hermes fills these in the browser without seeing them."
      aside={<div className="flex gap-2"><Button onClick={() => rpc.call('vault.lock', {}).then(load, toastError)}><Lock size={13} />Lock all</Button><Button tone="primary" onClick={() => setAdding(true)}><Plus size={14} />Save a login</Button></div>}>
      {!items ? <Skeleton className="h-24" /> : !items.length ? <p className="text-sm text-dust">Nothing saved yet{sources.some(s => s.needs_unlock && !s.unlocked) ? ', or your password manager is locked' : ''}.</p> : <ul className="divide-y divide-line">{items.map(i => { const I = icon[i.kind]; return (
        <li key={i.id} className="py-2.5 flex items-center gap-3 text-sm">
          <I size={14} className="text-dust" />
          <span className="flex-1 min-w-0"><span className="block truncate">{i.label}</span><span className="block text-[12px] text-dust truncate">{i.identifier ?? i.origin}{i.has_otp ? ' · 2FA' : ''}</span></span>
          <span className="label">{i.backend}</span>
          {i.backend === 'local' && <IconButton label="Remove" onClick={() => confirm(`Remove ${i.label}?`) && rpc.call('vault.remove', { id: i.id }).then(load, toastError)}><Trash2 size={13} /></IconButton>}
        </li>
      ); })}</ul>}
    </Section>
    {sources.length > 1 && <Section title="Password managers">
      <ul className="divide-y divide-line">{sources.filter(s => s.name !== 'local').map(s => (
        <li key={s.name} className="py-2.5 flex items-center gap-3 text-sm">
          <span className="flex-1">{s.display_name}{!s.installed && <span className="label ml-2">not installed</span>}</span>
          {s.enabled && s.needs_unlock && (s.unlocked ? <Button size="sm" onClick={() => rpc.call('vault.lock', { name: s.name }).then(load, toastError)}><Lock size={12} />Lock</Button> : <Button size="sm" tone="halo" onClick={() => setUnlocking(s)}><Unlock size={12} />Unlock</Button>)}
          <Switch label={`Use ${s.display_name}`} checked={s.enabled} onChange={v => rpc.call('vault.source.set', { name: s.name, enabled: v }).then(load, toastError)} />
        </li>
      ))}</ul>
    </Section>}
    <Connectors />
    <AddLogin open={adding} onClose={() => setAdding(false)} onDone={load} />
    <Modal open={!!unlocking} onClose={() => setUnlocking(null)} title={`Unlock ${unlocking?.display_name ?? ''}`}>
      <input type="password" autoFocus className={inputCls} value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && unlock()} placeholder="Master password" />
      <div className="flex justify-end gap-2"><Button onClick={() => setUnlocking(null)}>Cancel</Button><Button tone="primary" onClick={unlock}>Unlock</Button></div>
    </Modal>
  </>;
}
