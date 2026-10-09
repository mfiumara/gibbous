import { useEffect, useMemo, useState } from 'react';
import { Search, Eye, Trash2, Save } from 'lucide-react';
import { api, hermes } from '../api';
import { useStore, toastError } from '../store';
import { Button, IconButton, Modal, Switch, Segmented, Skeleton, inputCls } from '../ui';
import { Section } from './common';
import { DiffView } from '../panels/DiffView';

interface Field { type: 'boolean' | 'number' | 'string' | 'list' | 'object' | 'select'; description?: string; category?: string; options?: string[] }
interface EnvRow { is_set: boolean; redacted_value?: string; description?: string; category?: string; is_password?: boolean; url?: string; provider_label?: string }

const getPath = (o: any, p: string) => p.split('.').reduce((v, k) => v?.[k], o);
const setPath = (o: any, p: string, val: unknown) => { const ks = p.split('.'); const out = structuredClone(o ?? {}); let cur = out; ks.slice(0, -1).forEach(k => { cur[k] = { ...(cur[k] ?? {}) }; cur = cur[k]; }); cur[ks.at(-1)!] = val; return out; };
const show = (v: unknown) => v === undefined ? '—' : typeof v === 'string' ? v || '""' : JSON.stringify(v);

function FormEditor() {
  const [schema, setSchema] = useState<{ fields: Record<string, Field>; category_order?: string[] }>();
  const [config, setConfig] = useState<any>();
  const [changes, setChanges] = useState<Record<string, unknown>>({});
  const [cat, setCat] = useState<string>('');
  const [q, setQ] = useState('');
  const [review, setReview] = useState(false);
  const load = () => { hermes.get<any>('config/schema').then(setSchema, toastError); hermes.get<any>('config').then(setConfig, toastError); };
  useEffect(() => { load(); }, []);
  const cats = useMemo(() => schema ? (schema.category_order ?? [...new Set(Object.values(schema.fields).map(f => f.category ?? 'other'))]) : [], [schema]);
  useEffect(() => { if (!cat && cats.length) setCat(cats[0]); }, [cats, cat]);
  if (!schema || !config) return <Skeleton className="h-64 rounded-2xl" />;
  const fields = Object.entries(schema.fields).filter(([k, f]) => q ? k.toLowerCase().includes(q.toLowerCase()) || f.description?.toLowerCase().includes(q.toLowerCase()) : (f.category ?? 'other') === cat);
  const value = (k: string) => k in changes ? changes[k] : getPath(config, k);
  const change = (k: string, v: unknown) => setChanges(c => { const n = { ...c, [k]: v }; if (JSON.stringify(v) === JSON.stringify(getPath(config, k))) delete n[k]; return n; });
  const save = async () => {
    const patch = Object.entries(changes).reduce((o, [k, v]) => setPath(o, k, v), {} as any);
    try { await hermes.put('config', { config: patch }); setChanges({}); setReview(false); useStore.getState().toast({ title: 'Config saved', body: 'New sessions use it; some settings need a Hermes restart.' }); load(); }
    catch (e) { toastError(e); }
  };
  const n = Object.keys(changes).length;
  return (
    <Section title="Hermes settings"
      aside={n > 0 && <Button tone="primary" onClick={() => setReview(true)}>Review {n} change{n > 1 ? 's' : ''}</Button>}>
      <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" /><input className={inputCls + ' pl-9'} placeholder="Search every setting" value={q} onChange={e => setQ(e.target.value)} /></div>
      {!q && <div className="flex flex-wrap gap-1">{cats.map(c => <button key={c} onClick={() => setCat(c)} aria-pressed={c === cat} className={`press h-7 px-2.5 rounded-md text-[12.5px] capitalize ${c === cat ? 'bg-ridge text-moon' : 'text-dust hover:text-moon'}`}>{c.replace(/_/g, ' ')}</button>)}</div>}
      <ul className="divide-y divide-line">{fields.slice(0, 150).map(([k, f]) => {
        const v = value(k);
        return (
          <li key={k} className={`py-2.5 flex flex-wrap items-start gap-x-4 gap-y-2 ${k in changes ? 'bg-tide/[0.04] -mx-2 px-2 rounded-md' : ''}`}>
            <div className="flex-1 min-w-[min(13rem,70%)]"><p className="font-mono text-[12.5px] break-all">{k}</p>{f.description && <p className="text-[12px] text-dust">{f.description}</p>}</div>
            <div className={`flex-none flex justify-end ${f.type === 'boolean' ? '' : 'w-full sm:w-56'}`}>
              {f.type === 'boolean' ? <Switch label={k} checked={!!v} onChange={x => change(k, x)} />
                : f.type === 'select' ? <select className={inputCls + ' py-1.5 text-[13px]'} value={String(v ?? '')} onChange={e => change(k, e.target.value)}>{(f.options ?? []).map(o => <option key={o}>{o}</option>)}</select>
                : f.type === 'number' ? <input type="number" className={inputCls + ' py-1.5 text-[13px]'} value={v == null ? '' : String(v)} onChange={e => change(k, e.target.value === '' ? null : Number(e.target.value))} />
                : f.type === 'string' ? <input className={inputCls + ' py-1.5 text-[13px] font-mono'} value={String(v ?? '')} onChange={e => change(k, e.target.value)} />
                : <textarea className={inputCls + ' py-1.5 text-[12px] font-mono min-h-9'} rows={1} defaultValue={JSON.stringify(v ?? (f.type === 'list' ? [] : {}))}
                    onBlur={e => { try { change(k, JSON.parse(e.target.value)); } catch { useStore.getState().toast({ title: `${k}: not valid JSON`, tone: 'error' }); } }} />}
            </div>
          </li>
        );
      })}</ul>
      <Modal open={review} onClose={() => setReview(false)} title="Review changes">
        <ul className="space-y-2 max-h-80 overflow-y-auto">{Object.entries(changes).map(([k, v]) => (
          <li key={k} className="rounded-lg border border-line p-2.5"><p className="font-mono text-[12.5px]">{k}</p><p className="font-mono text-[12px]"><span className="text-oxide line-through">{show(getPath(config, k))}</span> → <span className="text-sprout">{show(v)}</span></p></li>
        ))}</ul>
        <div className="flex justify-end gap-2"><Button onClick={() => { setChanges({}); setReview(false); }}>Discard all</Button><Button tone="primary" onClick={save}><Save size={13} />Save to config.yaml</Button></div>
      </Modal>
    </Section>
  );
}

function RawEditor() {
  const [orig, setOrig] = useState<string>();
  const [text, setText] = useState('');
  const [diff, setDiff] = useState<string | null>(null);
  const load = () => hermes.get<{ yaml: string }>('config/raw').then(r => { setOrig(r.yaml); setText(r.yaml); }, toastError);
  useEffect(() => { load(); }, []);
  if (orig == null) return <Skeleton className="h-64 rounded-2xl" />;
  const reviewChanges = () => api.post<{ diff: string }>('/api/diff', { a: orig, b: text, name: 'config.yaml' }).then(r => setDiff(r.diff), toastError);
  const save = () => hermes.put('config/raw', { yaml_text: text }).then(() => { setDiff(null); useStore.getState().toast({ title: 'config.yaml saved' }); load(); }, toastError);
  return (
    <Section title="config.yaml" description="You see the diff before saving."
      aside={text !== orig && <div className="flex gap-2"><Button onClick={() => setText(orig)}>Revert</Button><Button tone="primary" onClick={reviewChanges}>Review & save</Button></div>}>
      <textarea value={text} onChange={e => setText(e.target.value)} spellCheck={false} aria-label="config.yaml" className="w-full min-h-[60vh] rounded-xl bg-well border border-line p-3 font-mono text-[12.5px] leading-relaxed focus:outline-none focus:border-tide/50" />
      <Modal open={diff != null} onClose={() => setDiff(null)} title="Changes to config.yaml" wide>
        <div className="max-h-[55vh] overflow-y-auto"><DiffView diff={diff ?? ''} /></div>
        <div className="flex justify-end gap-2"><Button onClick={() => setDiff(null)}>Keep editing</Button><Button tone="primary" onClick={save}><Save size={13} />Write config.yaml</Button></div>
      </Modal>
    </Section>
  );
}

function EnvEditor() {
  const [env, setEnv] = useState<Record<string, EnvRow>>();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const load = () => hermes.get<Record<string, EnvRow>>('env').then(setEnv, toastError);
  useEffect(() => { load(); }, []);
  if (!env) return <Skeleton className="h-64 rounded-2xl" />;
  const rows = Object.entries(env).filter(([k, v]) => !q || `${k} ${v.description} ${v.provider_label}`.toLowerCase().includes(q.toLowerCase())).sort(([a, x], [b, y]) => Number(y.is_set) - Number(x.is_set) || a.localeCompare(b));
  const save = (k: string) => hermes.put('env', { key: k, value: editing[k] }).then(() => { setEditing(e => { const n = { ...e }; delete n[k]; return n; }); load(); }, toastError);
  return (
    <Section title="Keys & secrets" description="Masked until you reveal them.">
      <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ash" /><input className={inputCls + ' pl-9'} placeholder="Filter keys" value={q} onChange={e => setQ(e.target.value)} /></div>
      <ul className="divide-y divide-line">{rows.slice(0, 120).map(([k, v]) => (
        <li key={k} className="py-2.5 space-y-1.5">
          <div className="flex items-center gap-3">
            <span className={`size-1.5 rounded-full flex-none ${v.is_set ? 'bg-sprout' : 'bg-ash'}`} />
            <div className="flex-1 min-w-0"><p className="font-mono text-[12.5px]">{k}</p><p className="text-[12px] text-dust truncate">{v.provider_label ?? v.description}</p></div>
            {v.is_set && <span className="font-mono text-[12px] text-ash">{revealed[k] ?? v.redacted_value}</span>}
            {v.is_set && !revealed[k] && <IconButton label="Reveal" onClick={() => hermes.post<{ value: string }>('env/reveal', { key: k }).then(r => setRevealed(x => ({ ...x, [k]: r.value })), toastError)}><Eye size={13} /></IconButton>}
            <Button size="sm" onClick={() => setEditing(e => ({ ...e, [k]: '' }))}>{v.is_set ? 'Change' : 'Set'}</Button>
            {v.is_set && <IconButton label="Clear" onClick={() => confirm(`Clear ${k}?`) && hermes.del('env', { key: k }).then(load, toastError)}><Trash2 size={13} /></IconButton>}
          </div>
          {k in editing && <div className="flex gap-2 pl-4 animate-fade">
            <input type="password" autoFocus autoComplete="off" className={inputCls + ' font-mono text-[12.5px]'} value={editing[k]} onChange={e => setEditing(x => ({ ...x, [k]: e.target.value }))} onKeyDown={e => e.key === 'Enter' && save(k)} />
            <Button size="sm" className="h-9" onClick={() => setEditing(x => { const n = { ...x }; delete n[k]; return n; })}>Cancel</Button>
            <Button size="sm" className="h-9" tone="primary" disabled={!editing[k]} onClick={() => save(k)}>Save</Button>
          </div>}
        </li>
      ))}</ul>
    </Section>
  );
}

export function ConfigTab() {
  const [mode, setMode] = useState<'form' | 'yaml' | 'env'>('form');
  return <>
    <Segmented label="Editor" value={mode} onChange={setMode} options={[{ value: 'form', label: 'Settings' }, { value: 'yaml', label: 'config.yaml' }, { value: 'env', label: 'Keys & secrets' }]} />
    {mode === 'form' ? <FormEditor /> : mode === 'yaml' ? <RawEditor /> : <EnvEditor />}
  </>;
}
