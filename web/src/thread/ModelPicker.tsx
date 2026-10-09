import { useEffect, useState } from 'react';
import { ChevronDown, Zap, Search, Check, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { useRpc } from '../rpc';
import { useStore, toastError } from '../store';
import { Menu, MoonLoader, inputCls } from '../ui';
import type { ModelOptionProvider, SessionLiveInfo, Usage } from '../hermes/contract';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Only providers Hermes finds signed in on this machine (subscriptions such as ChatGPT/Codex, Copilot, Grok OAuth, plus API keys).
const usable = (ps: ModelOptionProvider[]) => ps.filter(p => p.authenticated !== false && p.models?.length);

// Model, reasoning effort and fast mode for one thread; lives in the composer and opens upward.
export function ModelPicker({ info, sid }: { info?: SessionLiveInfo; sid?: string }) {
  const rpc = useRpc();
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ModelOptionProvider[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState('');
  const load = (refresh = false) => {
    if (refresh) setRefreshing(true);
    return rpc.call('model.options', { session_id: sid, ...(refresh ? { refresh: true } : {}) }).then(r => setProviders(usable(r.providers)), toastError).finally(() => setRefreshing(false));
  };
  useEffect(() => { if (open && !providers) load(); }, [open, providers]);
  useEffect(() => { if (!open) setQ(''); }, [open]);
  const run = (cmd: string) => sid && rpc.call('slash.exec', { session_id: sid, command: cmd }).then(r => r.warning && useStore.getState().toast({ title: r.warning }), toastError);
  const needle = q.toLowerCase();
  const isCurrent = (p: ModelOptionProvider, m: string) => info?.model === m && (!info.provider || info.provider === p.slug);
  return (
    <div className="relative min-w-0">
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" disabled={!sid} data-tip="Model for this thread"
        className="press inline-flex items-center gap-1.5 h-8 px-2 rounded-lg text-[12px] text-dust hover:text-moon hover:bg-ridge disabled:opacity-40 min-w-0">
        <span className="font-mono truncate min-w-0 max-w-36 sm:max-w-52">{info?.model ?? 'model'}</span>
        {info?.reasoning_effort && <span className="label text-[9px] text-ash hidden sm:inline">{info.reasoning_effort}</span>}
        {info?.fast && <Zap size={11} className="text-halo flex-none" />}
        <ChevronDown size={11} className="flex-none" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} align="left" side="top" className="w-80 flex flex-col">
        <div className="px-2 pt-1.5 pb-2 space-y-2">
          <p className="label">Reasoning effort</p>
          <div className="flex gap-1">{EFFORTS.map(e => (
            <button key={e} onClick={() => sid && rpc.call('config.set', { session_id: sid, key: 'reasoning', value: e }).catch(toastError)} className={`press flex-1 h-7 rounded-md text-[12px] border ${info?.reasoning_effort === e ? 'border-tide/60 bg-tide/10 text-moon' : 'border-line text-dust hover:text-moon'}`}>{e}</button>
          ))}</div>
          <button onClick={() => run(`/fast ${info?.fast ? 'normal' : 'fast'}`)} className="press w-full flex items-center gap-2 h-8 px-2 rounded-md text-[13px] hover:bg-ridge">
            <Zap size={14} className={info?.fast ? 'text-halo' : 'text-ash'} /><span className="flex-1 text-left">Priority (fast) mode</span><span className="label">{info?.fast ? 'on' : 'off'}</span>
          </button>
        </div>
        <div className="border-t border-line p-1.5 flex flex-col min-h-0">
          <div className="flex items-center gap-1 mb-1">
            <div className="relative flex-1"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ash" />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search models" aria-label="Search models" className={inputCls + ' pl-8 py-1.5 text-[13px]'} /></div>
            <button onClick={() => load(true)} aria-label="Rescan signed-in providers" data-tip="Rescan subscriptions on this machine" disabled={refreshing}
              className="press size-8 grid place-items-center rounded-md text-dust hover:text-moon hover:bg-ridge flex-none"><RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /></button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {providers?.map(p => {
              const models = (p.models ?? []).filter(m => !needle || m.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)).slice(0, needle ? 60 : 30);
              if (!models.length) return null;
              return <div key={p.slug} className="py-1"><p className="label px-2 py-1">{p.name}</p>
                {models.map(m => <button key={m} onClick={() => { run(`/model ${m} --provider ${p.slug}`); setOpen(false); }}
                  className="press w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left font-mono text-[12.5px] hover:bg-ridge">
                  <span className="flex-1 truncate">{m}</span>{isCurrent(p, m) && <Check size={13} className="text-tide" />}
                </button>)}
              </div>;
            })}
            {!providers && <p className="px-2 py-2 text-[13px] text-dust">Finding your subscriptions…</p>}
            {providers && !providers.length && <p className="px-2 py-2 text-[13px] text-dust">No signed-in providers. Run <span className="font-mono">hermes model</span> to add one.</p>}
          </div>
        </div>
      </Menu>
    </div>
  );
}

const MODE_TEXT: Record<string, string> = {
  smart: 'Smart: Hermes asks before commands it judges risky (rm -rf, force-push, installs…) and runs the rest.',
  manual: 'Ask every time: every shell command waits for your OK.',
  off: 'Never ask: commands run without approval.',
};

// Approvals for shell commands: shows the profile's mode; one click toggles YOLO for this session only.
// config.set (not the `/yolo` slash command): slash commands run in a worker process, so `/yolo` never reached the session.
export function ApprovalChip({ info, sid }: { info?: SessionLiveInfo; sid?: string }) {
  const rpc = useRpc();
  const yolo = !!info?.yolo;
  const mode = info?.approval_mode ?? 'smart';
  const tip = yolo
    ? 'YOLO (this thread only): every command runs without asking.\nClick to ask for approvals again.'
    : `Command approvals · ${MODE_TEXT[mode] ?? mode}\nClick for YOLO in this thread only. Change the default in Settings → General.`;
  return (
    <button onClick={() => sid && rpc.call('config.set', { session_id: sid, key: 'yolo', value: yolo ? 'off' : 'on' }).catch(toastError)} disabled={!sid}
      aria-label={yolo ? 'YOLO on: commands run without approval' : `Command approvals: ${mode}`}
      className={`press inline-flex items-center gap-1.5 h-8 px-2 rounded-lg text-[12px] hover:bg-ridge flex-none ${yolo ? 'text-halo bg-halo/8' : 'text-dust hover:text-moon'}`}
      data-tip={tip}>
      {yolo ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}<span className="hidden sm:inline">{yolo ? 'yolo' : mode}</span>
    </button>
  );
}

const fmtK = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n);

// The tooltip: how much of the window is used, in tokens, plus what Hermes knows about compaction and caching.
export function contextTip(u: Usage | undefined, compacting?: boolean) {
  if (compacting) return 'Compacting · Hermes is summarizing earlier conversation to free up the context window.';
  const pct = u?.context_percent;
  if (pct == null) return 'Context window: no usage reported yet.';
  const lines = [`Context window · ${pct}% used`];
  if (u?.context_used != null && u?.context_max) lines.push(`${u.context_estimated ? '≈' : ''}${fmtK(u.context_used)} of ${fmtK(u.context_max)} tokens · ${fmtK(Math.max(0, u.context_max - u.context_used))} left`);
  if (u?.compressions) lines.push(`Compacted ${u.compressions}× this session`);
  if (u?.cache_hit_pct != null) lines.push(`Prompt cache hits ${Math.round(u.cache_hit_pct)}%`);
  lines.push(pct > 80 ? 'Nearly full: Hermes will compact older turns soon.' : 'Hermes compacts older turns automatically when it fills up.');
  return lines.join('\n');
}

// How full the context window is, as a moon filling left to right. While Hermes compacts, it cycles through a lunation.
export function ContextMeter({ usage, compacting }: { usage?: Usage; compacting?: boolean }) {
  const pct = usage?.context_percent ?? 0;
  const tone = pct > 80 ? 'var(--color-oxide)' : pct > 60 ? 'var(--color-halo)' : 'var(--color-tide)';
  return (
    <span role="img" aria-label={compacting ? 'Compacting context' : `Context window ${pct}% used`}
      className="inline-grid place-items-center size-8 rounded-lg hover:bg-ridge flex-none" data-tip={contextTip(usage, compacting)}>
      {compacting ? <MoonLoader size={15} label="Compacting context" /> : <PhaseMoon fraction={pct / 100} color={tone} size={15} />}
    </span>
  );
}

// Fills from the left edge to the right; `fraction` 0 = new, .5 = half, 1 = full. (Path is drawn lit-right, then mirrored.)
export function PhaseMoon({ fraction, color, size = 14 }: { fraction: number; color: string; size?: number }) {
  const k = Math.min(1, Math.max(0, fraction)), r = 6, c = 7;
  const rx = r * Math.abs(1 - 2 * k);
  const lit = k <= 0.005 ? '' : k >= 0.995 ? `M${c} ${c - r}A${r} ${r} 0 1 1 ${c} ${c + r}A${r} ${r} 0 1 1 ${c} ${c - r}Z`
    : `M${c} ${c - r}A${r} ${r} 0 0 1 ${c} ${c + r}A${rx} ${r} 0 0 ${k > 0.5 ? 1 : 0} ${c} ${c - r}Z`;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden className="flex-none">
      <circle cx={c} cy={c} r={r} fill="var(--color-ridge)" stroke="color-mix(in srgb, var(--color-ash) 55%, transparent)" strokeWidth=".75" />
      {lit && <path d={lit} fill={color} transform="matrix(-1 0 0 1 14 0)" />}
    </svg>
  );
}
