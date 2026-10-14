import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { rpc } from '../rpc';
import { useStore, toastError, NONE } from '../store';
import { Field, Segmented, Switch, inputCls, usePref, type Theme, type Density } from '../ui';
import { Section, Row } from './common';
import { CORNER_ITEMS, setCorner, useCorner } from '../corner';
import type { ModelOptionProvider } from '../hermes/contract';
import { moonPhase, savedLoc, upcomingEclipses, eclipseLabel } from '../moon';
import { EDITORS } from '../panels/FilesPanel';

export function GeneralTab() {
  const settings = useStore(s => s.settings)!;
  const [providers, setProviders] = useState<ModelOptionProvider[]>([]);
  const [current, setCurrent] = useState<{ model?: string; provider?: string }>({});
  const [approvals, setApprovals] = useState<string>();
  useEffect(() => {
    rpc.call('model.options', {}).then(r => { setProviders(r.providers.filter(p => p.authenticated !== false && p.models?.length)); setCurrent({ model: r.model, provider: r.provider }); }).catch(() => {});
    rpc.call('config.get', { key: 'approvals.mode' }).then((r: any) => setApprovals(String(r?.value ?? r ?? 'smart')), () => {});
  }, []);
  const patch = (b: Record<string, unknown>) => api.patch('/api/settings', b).catch(toastError);
  const setMode = (m: string) => rpc.call('config.set', { key: 'approvals.mode', value: m }).then(() => setApprovals(m), toastError);
  const modelValue = settings.model ? `${settings.provider}\u0000${settings.model}` : '';
  return <>
    <Section title="Agents">
      <Field label="Model for new threads" hint={`Default: ${current.model ?? '…'}${current.provider ? ` (${current.provider})` : ''}.`}>
        <select className={inputCls} value={modelValue} onChange={e => { const [provider, model] = e.target.value ? e.target.value.split('\u0000') : ['', '']; patch({ provider, model }); }}>
          <option value="">Use the default model</option>
          {providers.map(p => <optgroup key={p.slug} label={p.name}>{p.models!.slice(0, 60).map(m => <option key={m} value={`${p.slug}\u0000${m}`}>{m}</option>)}</optgroup>)}
        </select>
      </Field>
    </Section>
    <Section title="Approvals" description="Your Hermes profile setting; it applies to the CLI and Discord too.">
      {approvals && <Segmented label="Approval mode" value={approvals} onChange={setMode} options={[
        { value: 'manual', label: 'Ask every time' }, { value: 'smart', label: 'Smart', tip: 'The agent judges which commands are risky' }, { value: 'off', label: 'Never ask' },
      ]} />}
    </Section>
    <Snippets />
    <CornerSection />
    <Section title="Housekeeping">
      <Row title="Archive idle chats" description="Pinned threads are never archived.">
        <select className={inputCls + ' py-1.5 w-36'} value={settings.autoArchiveDays ?? 0} onChange={e => patch({ autoArchiveDays: Number(e.target.value) })}>
          {[[0, 'Never'], [7, 'After 7 days'], [14, 'After 14 days'], [30, 'After 30 days'], [90, 'After 90 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Row>
      <Row title="Monthly budget" description="One notification a month when spend passes this. 0 turns it off.">
        <span className="flex items-center gap-1.5 text-sm text-dust">$<input type="number" min={0} step={10} className={inputCls + ' py-1.5 w-28'} defaultValue={settings.monthlyBudgetUsd || ''} placeholder="0"
          onBlur={e => patch({ monthlyBudgetUsd: Number(e.target.value) || 0 })} /></span>
      </Row>
    </Section>
    <About />
  </>;
}

// The one place that names the backend: Gibbous is a UI for Hermes, which runs the agents and keeps the sessions.
function About() {
  const version = useStore(s => s.hermes?.version), update = useStore(s => s.hermes?.updateAvailable);
  return (
    <Section title="About">
      <Row title={`Runs on Hermes${version ? ` · ${/^\d/.test(version) ? `v${version}` : version}` : ''}`} description="Hermes by Nous Research runs the agents and keeps every session; Gibbous is the window onto it.">
        <span className="flex gap-4"><a href="#/setup" className="press text-[13px] text-tide hover:underline whitespace-nowrap">Model &amp; setup</a>
        <a href="#/settings/update" className="press text-[13px] text-tide hover:underline whitespace-nowrap">{update ? 'Update available' : 'Check for updates'}</a></span>
      </Row>
    </Section>
  );
}

const patch = (b: Record<string, unknown>) => api.patch('/api/settings', b).catch(toastError);

// Saved prompts. Type ;name in any composer to insert one.
function Snippets() {
  const snippets = useStore(s => s.settings?.snippets ?? NONE);
  const [draft, setDraft] = useState({ name: '', text: '' });
  const save = (list: typeof snippets) => patch({ snippets: list });
  return (
    <Section title="Snippets" description={<>Type <span className="font-mono text-moon">;name</span> in any message box.</>}>
      {snippets.length > 0 && <ul className="divide-y divide-line">{snippets.map((x, i) => (
        <li key={x.name + i} className="py-2.5 flex items-start gap-3">
          <span className="font-mono text-[13px] text-tide flex-none pt-px">;{x.name}</span>
          <span className="flex-1 min-w-0 text-[13px] text-dust line-clamp-2 whitespace-pre-wrap">{x.text}</span>
          <button className="press text-[12.5px] text-dust hover:text-moon flex-none" onClick={() => { setDraft(x); save(snippets.filter((_, j) => j !== i)); }}>Edit</button>
          <button className="press text-[12.5px] text-oxide/80 hover:text-oxide flex-none" onClick={() => save(snippets.filter((_, j) => j !== i))}>Remove</button>
        </li>
      ))}</ul>}
      <div className="space-y-2">
        <input className={inputCls + ' font-mono'} placeholder="name, e.g. review" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value.replace(/\s+/g, '-') })} aria-label="Snippet name" />
        <textarea className={inputCls + ' min-h-24'} placeholder="The prompt it inserts" value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} aria-label="Snippet text" />
        <div className="flex justify-end"><button className="press h-8 px-3 rounded-lg bg-moon text-basalt text-[13px] font-bold disabled:opacity-40" disabled={!draft.name.trim() || !draft.text.trim()}
          onClick={() => { save([...snippets.filter(x => x.name !== draft.name), draft]); setDraft({ name: '', text: '' }); }}>Save snippet</button></div>
      </div>
    </Section>
  );
}

export function AppearanceTab() {
  const [editor, setEditor] = useState(() => localStorage.getItem('gibbous.editor') ?? 'VS Code');
  const [theme, setTheme] = usePref<Theme>('theme', 'night');
  const [density, setDensity] = usePref<Density>('density', 'cozy');
  const [sky, setSky] = usePref<'on' | 'off'>('skymoon', 'on');
  const [chimeOn, setChimeOn] = useState(() => localStorage.getItem('gibbous.chime') === 'on');
  const [motion, setMotion] = useState(() => localStorage.getItem('gibbous.motion') !== 'off');
  return (
    <Section title="Appearance" description="Stored on this device.">
      <Row title="Theme"><Segmented label="Theme" value={theme} onChange={setTheme} options={[{ value: 'night', label: 'Night' }, { value: 'light', label: 'Daylight' }, { value: 'system', label: 'System' }]} /></Row>
      <Row title="Density" description="Scales the whole interface."><Segmented label="Density" value={density} onChange={setDensity} options={[{ value: 'compact', label: 'Compact' }, { value: 'cozy', label: 'Cozy' }, { value: 'roomy', label: 'Roomy' }]} /></Row>
      <Row title="Tonight's moon" description={`Tonight: ${moonPhase().name.toLowerCase()}, ${Math.round(moonPhase().lit * 100)}% lit.`}>
        <Switch label="Tonight's moon" checked={sky === 'on'} onChange={v => setSky(v ? 'on' : 'off')} />
      </Row>
      <Row title="Lunar eclipses" description={<EclipseList />}>{null}</Row>
      <Row title="Chime when something needs you" description="This device only.">
        <Switch label="Chime when something needs you" checked={chimeOn} onChange={v => { setChimeOn(v); localStorage.setItem('gibbous.chime', v ? 'on' : 'off'); }} />
      </Row>
      <Row title="Open files in">
        <select className={inputCls + ' py-1.5 w-36'} value={editor} onChange={e => { setEditor(e.target.value); localStorage.setItem('gibbous.editor', e.target.value); }}>{Object.keys(EDITORS).map(n => <option key={n}>{n}</option>)}</select>
      </Row>
      <Row title="Animations" description="Reduced motion in system settings always wins.">
        <Switch label="Animations" checked={motion} onChange={v => { setMotion(v); localStorage.setItem('gibbous.motion', v ? 'on' : 'off'); document.documentElement.dataset.motion = v ? 'on' : 'off'; }} />
      </Row>
    </Section>
  );
}

// Upcoming lunar eclipses, with whether the Moon is above your horizon at mid-eclipse.
function EclipseList() {
  const loc = savedLoc(), list = useMemo(() => upcomingEclipses(4, loc), [loc?.lat, loc?.lon]);
  const fmt = (d: Date) => d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <span className="block space-y-0.5">
    {list.map(e => <span key={+e.peak} className={`block ${e.kind === 'total' ? 'text-oxide' : ''}`}>{eclipseLabel(e.kind)} · {fmt(e.peak)}{e.altitude == null ? '' : e.visible ? ' · visible here' : ' · below your horizon'}</span>)}
    <span className="block text-ash">{loc ? `Location: ${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)} (${loc.src === 'device' ? 'this device' : 'approximate, from your IP'}). The background moon is tilted as it stands in your sky.` : 'Location unknown: the moon is drawn north-up and visibility is not checked.'}</span>
  </span>;
}

// The sidebar's bottom-left corner: pick what shows there (this device). Settings always stays.
function CornerSection() {
  const corner = useCorner();
  return <Section title="Sidebar corner" description="What the bottom-left of the sidebar shows on this device. Settings is always there; the rest stays in ⌘K and on Home.">
    {CORNER_ITEMS.map(i => (
      <Row key={i.key} title={i.label} description={'hint' in i ? i.hint : undefined}>
        <Switch label={i.label} checked={corner.includes(i.key)} onChange={on => setCorner(on ? [...corner, i.key] : corner.filter(k => k !== i.key))} />
      </Row>
    ))}
  </Section>;
}
