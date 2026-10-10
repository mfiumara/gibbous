import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, CircleDot, Minimize2, RotateCcw } from 'lucide-react';
import { useRpc } from '../rpc';
import { useStore, toastError } from '../store';
import type { Timeline } from '../thread/timeline';
import type { RollbackCheckpoint, SessionContextBreakdownResult } from '../hermes/contract';
import { IconButton, Button, Switch, inputCls, fmtTokens, fmtUsd } from '../ui';
import { DiffView } from './DiffView';

const H = ({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) => <div className="flex items-center gap-2"><h3 className="label flex-1">{children}</h3>{aside}</div>;

function ContextSection({ tl, sid }: { tl: Timeline; sid?: string }) {
  const rpc = useRpc();
  const [bd, setBd] = useState<SessionContextBreakdownResult>();
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const u = tl.usage;
  useEffect(() => { if (sid && !tl.running) rpc.call('session.context_breakdown', { session_id: sid }).then(setBd, () => {}); }, [sid, tl.running, u?.context_used]);
  const used = bd?.context_used ?? u?.context_used ?? 0, max = bd?.context_max ?? u?.context_max ?? 0;
  const compress = async () => {
    if (!sid) return;
    setBusy(true);
    try {
      const r = await rpc.call('session.compress', { session_id: sid, focus_topic: focus || undefined });
      useStore.getState().toast({ title: r.compressed === false ? (r.message ?? 'Nothing to compress yet') : 'Context compressed', body: r.before_tokens && r.after_tokens ? `${fmtTokens(r.before_tokens)} → ${fmtTokens(r.after_tokens)} tokens` : undefined });
      setFocus('');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <section className="space-y-3">
      <H aside={<span className="font-mono text-[11px] text-dust">{fmtTokens(used)} / {fmtTokens(max)}</span>}>Context</H>
      <div className="h-2 rounded-full bg-ridge overflow-hidden flex" role="img" aria-label={`${bd?.context_percent ?? u?.context_percent ?? 0}% of context used`}>
        {bd ? bd.categories.filter(c => c.tokens > 0).map(c => <span key={c.id} className="h-full transition-[width] duration-700" style={{ width: `${(c.tokens / Math.max(1, max)) * 100}%`, background: c.color }} />)
          : <span className="h-full bg-tide" style={{ width: `${Math.min(100, u?.context_percent ?? 0)}%` }} />}
      </div>
      {bd && <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">{bd.categories.filter(c => c.tokens > 0).map(c => (
        <li key={c.id} className="flex items-center gap-2 text-dust"><span className="size-2 rounded-sm flex-none" style={{ background: c.color }} /><span className="truncate flex-1">{c.label}</span><span className="font-mono text-[11px]">{fmtTokens(c.tokens)}</span></li>
      ))}</ul>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11.5px] text-dust pt-1">
        <dt>tokens in / out</dt><dd className="text-right">{fmtTokens(u?.prompt)} / {fmtTokens(u?.completion)}</dd>
        <dt>cache hit</dt><dd className="text-right">{u?.cache_hit_pct != null ? `${u.cache_hit_pct}%` : '—'}</dd>
        <dt>calls</dt><dd className="text-right">{u?.calls ?? '—'}</dd>
        {u?.cost_usd != null && <><dt>cost</dt><dd className="text-right text-moon">{fmtUsd(u.cost_usd)}</dd></>}
      </dl>
      <div className="flex gap-2">
        <input className={inputCls + ' py-1.5 text-[13px]'} placeholder="Keep focus on… (optional)" value={focus} onChange={e => setFocus(e.target.value)} />
        <Button size="sm" className="h-8.5" onClick={compress} disabled={!sid || busy || tl.running}><Minimize2 size={13} />Compress</Button>
      </div>
    </section>
  );
}

function CheckpointsSection({ sid, state, onRestore, onChanged }: { sid?: string; state?: { enabled: boolean; list: RollbackCheckpoint[] }; onRestore(c: RollbackCheckpoint): void; onChanged(): void }) {
  const rpc = useRpc();
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  useEffect(() => { if (open && sid) rpc.call('rollback.diff', { session_id: sid, hash: open }).then(r => setDiff(r.diff ?? r.stat ?? ''), toastError); }, [open, sid]);
  const toggle = async (on: boolean) => {
    try {
      await rpc.call('config.set', { key: 'checkpoints.enabled', value: on });
      if (on) useStore.getState().toast({ title: 'Checkpoints are on', body: 'Files are snapshotted before each turn changes them, so you can undo a turn.' });
      onChanged();
    } catch (e) { toastError(e); }
  };
  return (
    <section className="space-y-2.5">
      <H aside={state && <Switch label="File checkpoints" checked={state.enabled} onChange={toggle} />}>Checkpoints</H>
      {!state ? null : !state.enabled ? <p className="text-[13px] text-dust">Turn on to undo a turn's file changes.</p>
        : !state.list.length ? <p className="text-[13px] text-dust">No checkpoints yet.</p>
        : <ul className="space-y-1">{state.list.slice(0, 30).map(c => (
          <li key={c.hash} className="rounded-lg border border-line">
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <button onClick={() => setOpen(open === c.hash ? null : c.hash!)} className="press flex-1 min-w-0 text-left">
                <span className="block text-[13px] truncate">{c.message || 'Checkpoint'}</span>
                <span className="block font-mono text-[10.5px] text-ash">{c.timestamp ? new Date(c.timestamp).toLocaleString() : ''} · {c.hash?.slice(0, 8)}</span>
              </button>
              <IconButton label="Restore files to this checkpoint" onClick={() => onRestore(c)}><RotateCcw size={13} /></IconButton>
            </div>
            {open === c.hash && <div className="px-2 pb-2 max-h-80 overflow-y-auto animate-fade"><DiffView diff={diff} /></div>}
          </li>
        ))}</ul>}
    </section>
  );
}

export function SessionPanel({ tl, sid, checkpoints, onRestore, onChanged }: { tl: Timeline; sid?: string; checkpoints?: { enabled: boolean; list: RollbackCheckpoint[] }; onRestore(c: RollbackCheckpoint): void; onChanged(): void }) {
  const info = tl.info;
  return (
    <div className="h-full overflow-y-auto p-4 space-y-7 text-sm">
      <ContextSection tl={tl} sid={sid} />

      {!!tl.todos?.length && <section className="space-y-2">
        <H>Plan</H>
        <ul className="space-y-1">{tl.todos.map((t: any, i) => {
          const st = String(t.status ?? '');
          const Icon = st === 'completed' ? CheckCircle2 : st === 'in_progress' ? CircleDot : Circle;
          return <li key={t.id ?? i} className={`flex gap-2 ${st === 'completed' ? 'text-ash line-through' : ''}`}><Icon size={15} className={`flex-none mt-0.5 ${st === 'in_progress' ? 'text-tide' : st === 'completed' ? 'text-sprout' : ''}`} />{String(t.content ?? t.text ?? '')}</li>;
        })}</ul>
      </section>}

      <CheckpointsSection sid={sid} state={checkpoints} onRestore={onRestore} onChanged={onChanged} />


      {info && <section className="space-y-2">
        <H>Session</H>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-dust">model</dt><dd className="font-mono text-right truncate">{info.model}</dd>
          <dt className="text-dust">provider</dt><dd className="font-mono text-right">{info.provider}</dd>
          <dt className="text-dust">reasoning</dt><dd className="font-mono text-right">{info.reasoning_effort || '—'}</dd>
          <dt className="text-dust">approvals</dt><dd className="font-mono text-right">{info.yolo ? 'yolo' : info.approval_mode}</dd>
          <dt className="text-dust">tools</dt><dd className="font-mono text-right">{Object.values(info.tools ?? {}).flat().length}</dd>
          <dt className="text-dust">cwd</dt><dd className="font-mono text-right truncate" data-tip={info.cwd}>{info.cwd}</dd>
        </dl>
        {!!info.mcp_servers?.length && <ul className="space-y-1 pt-1">{info.mcp_servers.map(m => (
          <li key={m.name} className="flex items-center gap-2 text-[13px]">
            <span className={`size-1.5 rounded-full ${m.status === 'connected' || m.status === 'ok' ? 'bg-sprout' : m.error ? 'bg-oxide' : 'bg-ash'}`} />
            <span className="font-mono">{m.name}</span><span className="ml-auto text-ash text-xs">{m.tool_count ?? 0} tools</span>
          </li>
        ))}</ul>}
      </section>}
    </div>
  );
}

