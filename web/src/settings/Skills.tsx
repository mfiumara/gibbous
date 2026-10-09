import { useEffect, useMemo, useState } from 'react';
import { Search, Download, Trash2, Pencil, Save, BadgeCheck } from 'lucide-react';
import { hermes } from '../api';
import { rpc } from '../rpc';
import { useStore, toastError } from '../store';
import { Button, IconButton, Modal, Switch, Skeleton, Segmented, inputCls } from '../ui';
import { Section } from './common';
import { Markdown } from '../thread/Items';

interface Skill { name: string; description?: string; category?: string; enabled: boolean; provenance?: 'hub' | 'bundled' | 'agent'; usage?: { total_count?: number } }
interface HubHit { name: string; description: string; source: string; identifier: string; trust_level?: string; repo?: string }

function SkillModal({ name, onClose }: { name: string; onClose(): void }) {
  const [content, setContent] = useState<string>();
  const [editing, setEditing] = useState(false);
  useEffect(() => { hermes.get<{ content: string }>(`skills/content?name=${encodeURIComponent(name)}`).then(r => setContent(r.content), toastError); }, [name]);
  const save = () => hermes.put('skills/content', { name, content }).then(() => { setEditing(false); useStore.getState().toast({ title: `Saved ${name}` }); }, toastError);
  return (
    <Modal open onClose={onClose} title={name} wide>
      {content == null ? <Skeleton className="h-48" /> : editing
        ? <textarea value={content} onChange={e => setContent(e.target.value)} spellCheck={false} className={inputCls + ' font-mono text-[12.5px] min-h-[50vh]'} />
        : <div className="max-h-[60vh] overflow-y-auto text-[13.5px]"><Markdown text={content} /></div>}
      <div className="flex justify-end gap-2">
        {editing ? <><Button onClick={() => setEditing(false)}>Cancel</Button><Button tone="primary" onClick={save}><Save size={13} />Save</Button></> : <><Button onClick={onClose}>Close</Button><Button onClick={() => setEditing(true)}><Pencil size={13} />Edit SKILL.md</Button></>}
      </div>
    </Modal>
  );
}

function Hub({ installed, onChange }: { installed: Set<string>; onChange(): void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<HubHit[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const search = () => { setHits(null); hermes.get<{ results: HubHit[] }>(`skills/hub/search?q=${encodeURIComponent(q)}&limit=30`).then(r => setHits(r.results), e => { toastError(e); setHits([]); }); };
  const install = async (h: HubHit) => {
    setBusy(h.identifier);
    try { const r = await hermes.post<{ name: string }>('skills/hub/install', { identifier: h.identifier }); await waitAction(r.name); useStore.getState().toast({ title: `Installed ${h.name}` }); onChange(); }
    catch (e) { toastError(e); } finally { setBusy(null); }
  };
  return (
    <Section title="Skills Hub" description="Installs run a safety scan first.">
      <form onSubmit={e => { e.preventDefault(); search(); }} className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" /><input className={inputCls + ' pl-9'} placeholder="Search the hub, e.g. pdf, github, testing" value={q} onChange={e => setQ(e.target.value)} /></form>
      {hits === null && q && <Skeleton className="h-20" />}
      {hits && <ul className="divide-y divide-line">{hits.map(h => (
        <li key={h.identifier} className="py-2.5 flex items-start gap-3 text-sm">
          <div className="flex-1 min-w-0"><p className="font-bold flex items-center gap-1.5">{h.name}{h.trust_level === 'trusted' || h.trust_level === 'official' ? <BadgeCheck size={13} className="text-tide" /> : null}<span className="label">{h.source}</span></p><p className="text-[12.5px] text-dust line-clamp-2">{h.description}</p></div>
          {installed.has(h.name) ? <span className="label text-sprout">installed</span> : <Button size="sm" disabled={!!busy} onClick={() => install(h)}><Download size={12} className={busy === h.identifier ? 'animate-pulse' : ''} />Install</Button>}
        </li>
      ))}{hits.length === 0 && <li className="py-3 text-sm text-dust">No skills match.</li>}</ul>}
    </Section>
  );
}

// Hermes runs installs as background actions; poll their status until they finish.
async function waitAction(name: string) {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await hermes.get<{ running: boolean; exit_code?: number; lines?: string[] }>(`actions/${name}/status?lines=20`).catch(() => null);
    if (s && !s.running) { if (s.exit_code) throw new Error(s.lines?.slice(-3).join('\n') || `${name} failed`); return; }
  }
}

export function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'on' | 'off'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const load = () => hermes.get<Skill[]>('skills').then(setSkills, toastError);
  useEffect(() => { load(); }, []);
  const shown = useMemo(() => (skills ?? []).filter(s => (filter === 'all' || (filter === 'on') === s.enabled) && (!q || `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase()))), [skills, q, filter]);
  const byCat = useMemo(() => { const m = new Map<string, Skill[]>(); for (const s of shown) m.set(s.category ?? 'other', [...(m.get(s.category ?? 'other') ?? []), s]); return [...m.entries()].sort(); }, [shown]);
  const toggle = (s: Skill, enabled: boolean) => { setSkills(ss => ss?.map(x => x.name === s.name ? { ...x, enabled } : x)); hermes.put('skills/toggle', { name: s.name, enabled }).catch(e => { toastError(e); load(); }); };
  const uninstall = async (s: Skill) => { if (!confirm(`Uninstall ${s.name}?`)) return; try { const r = await hermes.post<{ name: string }>('skills/hub/uninstall', { name: s.name }); await waitAction(r.name); load(); } catch (e) { toastError(e); } };
  return <>
    <Section title={`Skills${skills ? ` · ${skills.filter(s => s.enabled).length} on` : ''}`}
      aside={<Button size="sm" onClick={() => rpc.call('skills.reload', {}).then(() => { useStore.getState().toast({ title: 'Skills reloaded' }); load(); }, toastError)}>Reload</Button>}>
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-48"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" /><input className={inputCls + ' pl-9'} placeholder="Filter skills" value={q} onChange={e => setQ(e.target.value)} /></div>
        <Segmented label="Show" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
      </div>
      {!skills ? <Skeleton className="h-48" /> : byCat.map(([cat, list]) => (
        <div key={cat} className="space-y-1">
          <p className="label pt-2">{cat}</p>
          <ul className="divide-y divide-line">{list.map(s => (
            <li key={s.name} className="group py-2 flex items-center gap-3 text-sm">
              <button onClick={() => setOpen(s.name)} className="flex-1 min-w-0 text-left">
                <span className="font-mono text-[13px]">{s.name}</span>{s.provenance && s.provenance !== 'bundled' && <span className="label ml-2">{s.provenance}</span>}{s.usage?.total_count ? <span className="label ml-2 text-ash">used {s.usage.total_count}×</span> : null}
                <span className="block text-[12.5px] text-dust truncate">{s.description}</span>
              </button>
              {s.provenance === 'hub' && <IconButton label="Uninstall" className="opacity-0 group-hover:opacity-100" onClick={() => uninstall(s)}><Trash2 size={13} /></IconButton>}
              <Switch label={`Enable ${s.name}`} checked={s.enabled} onChange={v => toggle(s, v)} />
            </li>
          ))}</ul>
        </div>
      ))}
    </Section>
    <Hub installed={new Set(skills?.map(s => s.name))} onChange={load} />
    {open && <SkillModal name={open} onClose={() => setOpen(null)} />}
  </>;
}
