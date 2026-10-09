import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, Check, UserRound } from 'lucide-react';
import { api, hermes } from '../api';
import { rpc } from '../rpc';
import { useStore, toastError } from '../store';
import { Button, IconButton, Modal, Field, Switch, Skeleton, inputCls } from '../ui';
import { Section } from './common';
import type { ProfileRow, ProfilesDescribeResult } from '../hermes/contract';

function CreateProfile({ open, onClose, profiles, onDone }: { open: boolean; onClose(): void; profiles: ProfileRow[]; onDone(): void }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  const [cloneFrom, setCloneFrom] = useState(''); const [cloneAll, setCloneAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { await rpc.call('profiles.create', { name, description: description || undefined, clone_from: cloneFrom || undefined, clone_all: cloneAll || undefined }); onDone(); onClose(); setName(''); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New profile">
      
      <Field label="Name"><input className={inputCls} value={name} onChange={e => setName(e.target.value.replace(/[^\w-]/g, '-').toLowerCase())} placeholder="research" autoFocus /></Field>
      <Field label="Description"><input className={inputCls} value={description} onChange={e => setDescription(e.target.value)} placeholder="Deep research and long reports" /></Field>
      <Field label="Start from" hint="Cloning copies settings; Everything also copies memory, skills and sessions.">
        <select className={inputCls} value={cloneFrom} onChange={e => setCloneFrom(e.target.value)}><option value="">A fresh profile</option>{profiles.map(p => <option key={p.name} value={p.name}>Copy of {p.display_name || p.name}</option>)}</select>
      </Field>
      {cloneFrom && <label className="flex items-center gap-2 text-sm"><Switch label="Copy everything" checked={cloneAll} onChange={setCloneAll} />Copy everything</label>}
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!name || busy} onClick={create}>Create profile</Button></div>
    </Modal>
  );
}

function Detail({ name, onClose, onChanged }: { name: string; onClose(): void; onChanged(): void }) {
  const [d, setD] = useState<ProfilesDescribeResult>();
  const [desc, setDesc] = useState(''); const [soul, setSoul] = useState('');
  const [rename, setRename] = useState(name);
  useEffect(() => { rpc.call('profiles.describe', { name }).then(r => { setD(r); setDesc(r.description ?? ''); setSoul(r.soul ?? ''); }, toastError); }, [name]);
  const save = async () => {
    try {
      await rpc.call('profiles.configure', { name, description: desc, soul });
      if (rename && rename !== name) await hermes.patch(`profiles/${encodeURIComponent(name)}`, { new_name: rename });
      onChanged(); onClose();
    } catch (e) { toastError(e); }
  };
  const toggleSkill = (skill: string) => {
    if (!d) return;
    const disabled = (d.skills ?? []).filter(s => !s.enabled).map(s => s.name);
    const next = disabled.includes(skill) ? disabled.filter(x => x !== skill) : [...disabled, skill];
    rpc.call('profiles.configure', { name, disabled_skills: next }).then(() => setD({ ...d, skills: (d.skills ?? []).map(s => s.name === skill ? { ...s, enabled: !s.enabled } : s) }), toastError);
  };
  return (
    <Modal open onClose={onClose} title={`Profile · ${name}`} wide>
      {!d ? <Skeleton className="h-40" /> : <>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Name"><input className={inputCls + ' font-mono'} value={rename} onChange={e => setRename(e.target.value)} disabled={name === 'default'} /></Field>
          <Field label="Model"><input className={inputCls + ' font-mono'} value={`${d.model?.default ?? ''}${d.model?.provider ? ` · ${d.model.provider}` : ''}`} readOnly /></Field>
        </div>
        <Field label="Description"><input className={inputCls} value={desc} onChange={e => setDesc(e.target.value)} /></Field>
        <Field label="Soul" hint="The profile's personality and standing instructions (SOUL.md)."><textarea className={inputCls + ' min-h-32 text-[13px]'} value={soul} onChange={e => setSoul(e.target.value)} /></Field>
        <Field label={`Skills · ${(d.skills ?? []).filter(s => s.enabled).length}/${(d.skills ?? []).length} on`}>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">{(d.skills ?? []).map(s => (
            <button key={s.name} onClick={() => toggleSkill(s.name)} aria-pressed={s.enabled} className={`press h-6 px-2 rounded-md border text-[12px] font-mono ${s.enabled ? 'border-tide/50 bg-tide/10 text-moon' : 'border-line text-ash line-through'}`}>{s.name}</button>
          ))}</div>
        </Field>
        <p className="text-xs text-dust">MCP servers: {(d.mcp_servers ?? []).filter(m => m.enabled).map(m => m.name).join(', ') || 'none'}</p>
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button tone="primary" onClick={save}>Save profile</Button></div>
      </>}
    </Modal>
  );
}

export function ProfilesTab() {
  const settings = useStore(s => s.settings)!;
  const [profiles, setProfiles] = useState<ProfileRow[]>();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => rpc.call('profiles.list', {}).then(r => setProfiles(r.profiles ?? []), toastError);
  useEffect(() => { load(); }, []);
  const remove = async (p: ProfileRow) => {
    if (!confirm(`Delete the "${p.name}" profile and everything in it (memory, sessions, skills)? This can't be undone.`)) return;
    await hermes.del(`profiles/${encodeURIComponent(p.name)}`).then(load, toastError);
  };
  return <>
    <Section title="Profiles" description="New threads use the default."
      aside={<Button tone="primary" onClick={() => setCreating(true)}><Plus size={14} />New profile</Button>}>
      {!profiles ? <Skeleton className="h-24" /> : <ul className="space-y-2">{profiles.map(p => {
        const isDefault = (settings.profile || 'default') === p.name;
        return (
          <li key={p.name} className={`rounded-xl border p-3 flex flex-wrap items-center gap-x-3 gap-y-2 ${isDefault ? 'border-tide/40 bg-tide/[0.04]' : 'border-line'}`}>
            <span className="size-9 rounded-full bg-ridge grid place-items-center flex-none"><UserRound size={16} className="text-dust" /></span>
            <div className="flex-1 min-w-[min(12rem,70%)]">
              <p className="font-bold text-sm">{p.display_name || p.name}{p.is_default && <span className="label ml-2">launch profile</span>}</p>
              <p className="text-[12.5px] text-dust truncate">{p.description || p.model || 'No description'}{p.skill_count != null ? ` · ${p.skill_count} skills` : ''}</p>
            </div>
            <div className="flex items-center gap-1 ml-auto">
            {isDefault ? <span className="inline-flex items-center gap-1 text-[12px] text-tide"><Check size={13} />New threads</span>
              : <Button size="sm" onClick={() => api.patch('/api/settings', { profile: p.name === 'default' ? '' : p.name }).catch(toastError)}>Use for new threads</Button>}
            <IconButton label="Edit profile" onClick={() => setOpen(p.name)}><Pencil size={14} /></IconButton>
            {!p.is_default && p.name !== 'default' && <IconButton label="Delete profile" onClick={() => remove(p)}><Trash2 size={14} /></IconButton>}
            </div>
          </li>
        );
      })}</ul>}
    </Section>
    <CreateProfile open={creating} onClose={() => setCreating(false)} profiles={profiles ?? []} onDone={load} />
    {open && <Detail name={open} onClose={() => setOpen(null)} onChanged={load} />}
  </>;
}
