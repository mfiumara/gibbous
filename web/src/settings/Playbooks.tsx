import { useEffect, useState } from 'react';
import { Copy, Trash2, Lock, Wrench, RotateCcw, Download, Upload, ClipboardCopy } from 'lucide-react';
import { api, type Playbook } from '../api';
import { rpc } from '../rpc';
import { useStore, toastError } from '../store';
import { Button, IconButton, Field, Switch, Segmented, inputCls, ago } from '../ui';
import { Section, Row } from './common';
import type { ModelOptionProvider } from '../hermes/contract';
import { viewportReport } from '../viewport';

const PASSES = ['correctness', 'security', 'tests'] as const;

function Editor({ pb, onDone }: { pb: Playbook; onDone(): void }) {
  const [d, setD] = useState(pb);
  const [providers, setProviders] = useState<ModelOptionProvider[]>([]);
  useEffect(() => { rpc.call('model.options', {}).then(r => setProviders(r.providers.filter(p => p.authenticated !== false && p.models?.length))).catch(() => {}); }, []);
  const set = (p: Partial<Playbook>) => setD(x => ({ ...x, ...p }));
  const save = () => api.patch(`/api/playbooks/${d.id}`, d).then(onDone, toastError);
  return (
    <div className="space-y-4 animate-fade">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Name"><input className={inputCls} value={d.name} onChange={e => set({ name: e.target.value })} /></Field>
        <Field label="Description"><input className={inputCls} value={d.description} onChange={e => set({ description: e.target.value })} /></Field>
      </div>
      <Row title="Plan first" description="A planner splits the goal into tasks you review."><Switch label="Plan first" checked={d.plan} onChange={v => set({ plan: v })} /></Row>
      {d.plan && <Field label="Planner guidance"><textarea className={inputCls + ' min-h-16 text-[13px]'} value={d.planPrompt ?? ''} onChange={e => set({ planPrompt: e.target.value || undefined })} placeholder="e.g. one task per package; start with a failing test" /></Field>}
      <Field label="Extra instructions for every task"><textarea className={inputCls + ' min-h-16 text-[13px]'} value={d.workerNote ?? ''} onChange={e => set({ workerNote: e.target.value || undefined })} placeholder="e.g. follow CONTRIBUTING.md; keep the public API stable" /></Field>
      <Row title="Require tests" description="Workers must add or extend tests for their change."><Switch label="Require tests" checked={d.writeTests} onChange={v => set({ writeTests: v })} /></Row>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Review rounds" hint="Reviewer ↔ author loops; 0 skips review."><input type="number" min={0} max={5} className={inputCls} value={d.reviewRounds} onChange={e => set({ reviewRounds: Number(e.target.value) })} /></Field>
        <Field label="Reviewer model">
          <select className={inputCls} value={d.reviewer?.model ? `${d.reviewer.provider ?? ''}\u0000${d.reviewer.model}` : ''} onChange={e => { const [provider, model] = e.target.value.split('\u0000'); set({ reviewer: e.target.value ? { provider, model } : undefined }); }}>
            <option value="">Same as the worker</option>
            {providers.map(p => <optgroup key={p.slug} label={p.name}>{p.models!.slice(0, 40).map(m => <option key={m} value={`${p.slug}\u0000${m}`}>{m}</option>)}</optgroup>)}
          </select>
        </Field>
      </div>
      <Field label="Review checks">
        <div className="flex gap-1.5">{PASSES.map(p => { const on = d.reviewPasses.includes(p); return (
          <button key={p} aria-pressed={on} onClick={() => set({ reviewPasses: on ? d.reviewPasses.filter(x => x !== p) : [...d.reviewPasses, p] })}
            className={`press h-8 px-3 rounded-lg border text-[13px] capitalize ${on ? 'border-tide/60 bg-tide/10 text-moon' : 'border-line text-dust'}`}>{p}</button>
        ); })}</div>
      </Field>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Test gate" hint="A project script that must pass."><input className={inputCls + ' font-mono'} value={d.testScript ?? ''} onChange={e => set({ testScript: e.target.value || undefined })} placeholder="test" /></Field>
        <Field label="Budget per task (USD)" hint="Agents stop past this."><input type="number" min={0} step={0.5} className={inputCls} value={d.budgetUsd ?? ''} onChange={e => set({ budgetUsd: e.target.value ? Number(e.target.value) : undefined })} placeholder="no limit" /></Field>
      </div>
      <Field label="When a task is approved">
        <Segmented label="Finish" value={d.finish} onChange={v => set({ finish: v })} options={[{ value: 'manual', label: 'Wait for me' }, { value: 'merge', label: 'Merge automatically' }, { value: 'pr', label: 'Open a PR' }]} />
      </Field>
      <div className="flex justify-end gap-2"><Button onClick={onDone}>Cancel</Button><Button tone="primary" onClick={save}>Save playbook</Button></div>
    </div>
  );
}

export function PlaybooksTab() {
  const playbooks = useStore(s => s.playbooks);
  const [editing, setEditing] = useState<string | null>(null);
  const duplicate = async (pb: Playbook) => {
    const { id: _id, builtin: _b, ...rest } = pb;
    const copy = await api.post<Playbook>('/api/playbooks', { ...rest, name: `${pb.name} (copy)` }).catch(toastError);
    if (copy) setEditing(copy.id);
  };
  const current = playbooks.find(p => p.id === editing);
  if (current) return <Section title={`Edit · ${current.name}`}><Editor pb={current} onDone={() => setEditing(null)} /></Section>;
  return (
    <Section title="Playbooks" description="Pick one per project or per task.">
      <ul className="space-y-2">{playbooks.map(pb => (
        <li key={pb.id} className="rounded-xl border border-line p-3 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-bold text-sm flex items-center gap-1.5">{pb.name}{pb.builtin && <Lock size={11} className="text-ash" />}</p>
            <p className="text-[12.5px] text-dust">{pb.description}</p>
            <p className="label mt-1.5">{[pb.plan && 'plan', pb.writeTests && 'tests', pb.reviewRounds ? `${pb.reviewRounds}× review` : 'no review', pb.reviewer?.model && `reviewer ${pb.reviewer.model}`, pb.testScript && `gate: ${pb.testScript}`, pb.finish !== 'manual' && `auto-${pb.finish}`, pb.budgetUsd && `$${pb.budgetUsd} cap`].filter(Boolean).join(' · ')}</p>
          </div>
          <IconButton label="Duplicate" onClick={() => duplicate(pb)}><Copy size={14} /></IconButton>
          {!pb.builtin && <>
            <Button size="sm" onClick={() => setEditing(pb.id)}>Edit</Button>
            <IconButton label="Delete" onClick={() => confirm(`Delete "${pb.name}"?`) && api.del(`/api/playbooks/${pb.id}`).catch(toastError)}><Trash2 size={14} /></IconButton>
          </>}
        </li>
      ))}</ul>
    </Section>
  );
}

function Data() {
  const [diag, setDiag] = useState<string>();
  useEffect(() => { api.get<{ text: string }>('/api/diagnostics').then(r => setDiag(`${r.text}\n\nThis device: ${JSON.stringify({ ...viewportReport(), ua: navigator.userAgent }, null, 2)}`), () => {}); }, []);
  const bytes = diag ? Number(/"stateBytes": (\d+)/.exec(diag)?.[1] ?? 0) : 0;
  const restoreFrom = async (f?: File) => {
    if (!f || !confirm(`Replace all projects, threads, tasks and settings with ${f.name}? The current state is kept as a .before-restore file next to state.json.`)) return;
    try { await api.post('/api/restore', JSON.parse(await f.text())); useStore.getState().toast({ title: 'Backup restored' }); }
    catch (e) { toastError(e); }
  };
  const copy = () => diag && navigator.clipboard.writeText(diag).then(() => useStore.getState().toast({ title: 'Debug bundle copied' }), toastError);
  return <>
    <Section title="Backup" description={`Projects, threads, tasks, playbooks, schedules and settings in one file. Conversations themselves live in Hermes.${bytes ? ` Current state: ${(bytes / 1024).toFixed(0)} KB.` : ''}`}
      aside={<div className="flex gap-2">
        <a href="/api/backup" download={`gibbous-backup-${new Date().toLocaleDateString('en-CA')}.json`} className="press inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-line text-[13px] hover:bg-ridge"><Download size={13} />Download backup</a>
        <label className="press inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-line text-[13px] hover:bg-ridge cursor-pointer focus-within:outline-2"><Upload size={13} />Restore…
          <input type="file" accept="application/json,.json" className="sr-only" onChange={e => { restoreFrom(e.target.files?.[0]); e.target.value = ''; }} /></label>
      </div>} />
    <Section title="Diagnostics" description="Tokens and keys are removed. Attach it to bug reports."
      aside={<Button onClick={copy} disabled={!diag}><ClipboardCopy size={13} />Copy debug bundle</Button>}>
      {diag && <pre className="max-h-72 overflow-auto rounded-xl bg-well border border-line p-3 font-mono text-[11.5px] text-dust whitespace-pre-wrap">{diag}</pre>}
    </Section>
  </>;
}

export function MaintenanceTab() {
  const [m, setM] = useState<{ orphans: string[]; stuck: { id: string; title: string; status: string; projectId: string; idleMinutes: number }[] }>();
  const load = () => api.get<NonNullable<typeof m>>('/api/maintenance').then(setM, toastError);
  useEffect(() => { load(); }, []);
  if (!m) return null;
  return <>
    <Section title="Stuck tasks">
      {!m.stuck.length ? <p className="text-sm text-sprout">Nothing stuck.</p> : <ul className="divide-y divide-line">{m.stuck.map(t => (
        <li key={t.id} className="flex items-center gap-3 py-2.5 text-sm">
          <span className="flex-1 min-w-0"><span className="block font-bold truncate">{t.title}</span><span className="block text-xs text-dust">{t.status} · idle {ago(Date.now() - t.idleMinutes * 60_000)}</span></span>
          <Button size="sm" onClick={() => { location.hash = `/board/${t.projectId}`; }}>Open board</Button>
          <Button size="sm" onClick={() => api.patch(`/api/tasks/${t.id}`, { status: 'queued' }).then(load, toastError)}><RotateCcw size={12} />Restart</Button>
          <Button size="sm" tone="danger" onClick={() => api.patch(`/api/tasks/${t.id}`, { status: 'failed' }).then(load, toastError)}>Mark failed</Button>
        </li>
      ))}</ul>}
    </Section>
    <Section title="Orphaned worktrees" description="Removing deletes the folder and any uncommitted changes.">
      {!m.orphans.length ? <p className="text-sm text-sprout">No orphaned worktrees.</p> : <ul className="divide-y divide-line">{m.orphans.map(p => (
        <li key={p} className="flex items-center gap-3 py-2"><Wrench size={13} className="text-ash" /><span className="flex-1 font-mono text-[12px] truncate">{p}</span>
          <Button size="sm" tone="danger" onClick={() => confirm(`Delete ${p}?`) && api.post<typeof m>('/api/maintenance/remove', { path: p }).then(setM, toastError)}>Remove</Button></li>
      ))}</ul>}
    </Section>
    <Data />
  </>;
}
