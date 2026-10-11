import { useEffect, useState } from 'react';
import { ChevronDown, Zap, Search, Check, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { useRpc } from '../rpc';
import { useStore, toastError } from '../store';
import { Menu, MoonLoader, MoonDisc, PhaseMoon, inputCls, useSheet, useRichTip } from '../ui';
export { PhaseMoon };
import type { ModelOptionProvider, SessionLiveInfo, Usage } from '../hermes/contract';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Only providers Hermes finds signed in on this machine (subscriptions such as ChatGPT/Codex, Copilot, Grok OAuth, plus API keys).
const usable = (ps: ModelOptionProvider[]) => ps.filter(p => p.authenticated !== false && p.models?.length);

// Model, reasoning effort and fast mode for one thread; lives in the composer and opens upward.
// Phones: the row has room for ~8 characters, so drop the vendor ("claude-opus-5-5" → "opus-5-5", "openai/gpt-6" → "gpt-6").
export const shortModel = (m: string) => m.replace(/^.*\//, '').replace(/^(claude|anthropic|google|meta-llama)-/, '');

export function ModelPicker({ info, sid }: { info?: SessionLiveInfo; sid?: string }) {
  const rpc = useRpc();
  const [open, setOpen] = useState(false);
  const sheet = useSheet(); // phones: no autofocus, the keyboard would cover the sheet
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
  // config.set, not `/model`: the slash mirror only touches a live, idle agent, so a pick made while a turn runs (or
  // retries after the credits ran out) or before the agent exists silently did nothing. config.set defers a busy
  // session's pick to the next message, builds the agent when it's missing, and asks before a pricey model.
  const pick = async (provider: string, model: string, confirmed = false): Promise<void> => {
    if (!sid) return;
    const toast = useStore.getState().toast;
    try {
      const r = await rpc.call('config.set', { session_id: sid, key: 'model', value: `${model} --provider ${provider}`, ...(confirmed ? { confirm_expensive_model: true } : {}) });
      if (r.confirm_required) { if (window.confirm(r.confirm_message || `Switch to ${model}?`)) return pick(provider, model, true); return; }
      if (r.deferred) toast({ title: `${shortModel(model)} takes over from your next message`, body: 'The turn running now finishes on the old model. Stop it to switch right away.' });
      else if (r.warning) toast({ title: r.warning });
    } catch (e) { toastError(e); }
  };
  const needle = q.toLowerCase();
  const isCurrent = (p: ModelOptionProvider, m: string) => info?.model === m && (!info.provider || info.provider === p.slug);
  return (
    // flex + max-w-full: the button must shrink with its wrapper. A plain block wrapper shrank alone and the button
    // spilled out under the next chips (model name, shield, subagents and context moon piled up on a phone).
    <div className="relative min-w-0 flex">
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" disabled={!sid} data-tip="Model for this thread"
        className="press inline-flex items-center gap-1.5 h-8 px-2 rounded-lg text-[12px] text-dust hover:text-moon hover:bg-ridge disabled:opacity-40 min-w-0 max-w-full overflow-hidden">
        <span className="font-mono truncate min-w-0 max-w-36 sm:max-w-52"><span className="sm:hidden">{shortModel(info?.model ?? 'model')}</span><span className="hidden sm:inline">{info?.model ?? 'model'}</span></span>
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
              <input autoFocus={!sheet} value={q} onChange={e => setQ(e.target.value)} placeholder="Search models" aria-label="Search models" className={inputCls + ' pl-8 py-1.5 text-[13px]'} /></div>
            <button onClick={() => load(true)} aria-label="Rescan signed-in providers" data-tip="Rescan subscriptions on this machine" disabled={refreshing}
              className="press size-8 grid place-items-center rounded-md text-dust hover:text-moon hover:bg-ridge flex-none"><RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /></button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {providers?.map(p => {
              const models = (p.models ?? []).filter(m => !needle || m.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)).slice(0, needle ? 60 : 30);
              if (!models.length) return null;
              return <div key={p.slug} className="py-1"><p className="label px-2 py-1">{p.name}</p>
                {models.map(m => <button key={m} onClick={() => { pick(p.slug, m); setOpen(false); }}
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
  smart: 'Smart: asks before commands it judges risky (rm -rf, force-push, installs…) and runs the rest.',
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

// The plain-text tip (screen readers, and the fallback): how much of the window is used, compaction and caching.
export function contextTip(u: Usage | undefined, compacting?: boolean) {
  if (compacting) return 'Compacting · summarizing earlier conversation to free up the context window.';
  const pct = u?.context_percent;
  if (pct == null) return 'Context window: no usage reported yet.';
  const lines = [`Context window · ${pct}% used`];
  if (u?.context_used != null && u?.context_max) lines.push(`${u.context_estimated ? '≈' : ''}${fmtK(u.context_used)} of ${fmtK(u.context_max)} tokens · ${fmtK(Math.max(0, u.context_max - u.context_used))} left`);
  if (u?.compressions) lines.push(`Compacted ${u.compressions}× this session`);
  if (u?.cache_hit_pct != null) lines.push(`Prompt cache hits ${Math.round(u.cache_hit_pct)}%`);
  if (pct > 80) lines.push('Nearly full: older turns will be compacted soon.');
  return lines.join('\n');
}

// The hover card: a large real moon filled to the context level, the percentage under it, then label/value rows
// (no rules; values right-aligned in tabular figures so 26% / 738k / 1× / 96% line up).
function ContextCard({ usage: u, compacting }: { usage?: Usage; compacting?: boolean }) {
  const pct = u?.context_percent;
  const rows: [string, string][] = [];
  if (u?.context_used != null && u?.context_max) {
    rows.push(['Used', `${u.context_estimated ? '≈' : ''}${fmtK(u.context_used)} / ${fmtK(u.context_max)}`]);
    rows.push(['Left', fmtK(Math.max(0, u.context_max - u.context_used))]);
  }
  if (u?.compressions) rows.push(['Compacted', `${u.compressions}×`]);
  if (u?.cache_hit_pct != null) rows.push(['Cache hits', `${Math.round(u.cache_hit_pct)}%`]);
  return (
    <div className="w-[208px] flex flex-col items-center">
      {compacting ? <MoonLoader size={88} label="Compacting context" /> : <MoonDisc fraction={(pct ?? 0) / 100} size={88} />}
      <p className="mt-3 text-[22px] leading-none font-medium tabular-nums text-moon">{compacting ? 'Compacting' : pct != null ? `${pct}%` : '—'}</p>
      <p className="mt-1 label text-ash">{compacting ? 'Summarizing earlier turns' : 'of the context window'}</p>
      {!compacting && rows.length > 0 && (
        <dl className="mt-3.5 w-full grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[12px]">
          {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-dust">{k}</dt><dd className="text-right font-mono tabular-nums text-moon">{v}</dd></div>)}
        </dl>
      )}
      {!compacting && pct != null && pct > 80 && <p className="mt-3 text-[11.5px] text-oxide text-center">Nearly full: older turns will be compacted soon.</p>}
      {pct == null && !compacting && <p className="mt-2 text-[12px] text-dust">No usage reported yet.</p>}
    </div>
  );
}

// How full the context window is, as a moon filling left to right. While Hermes compacts, it cycles through a lunation.
export function ContextMeter({ usage, compacting }: { usage?: Usage; compacting?: boolean }) {
  const pct = usage?.context_percent ?? 0;
  const tone = pct > 80 ? 'var(--color-oxide)' : pct > 60 ? 'var(--color-halo)' : 'var(--color-tide)';
  const rich = useRichTip(() => <ContextCard usage={usage} compacting={compacting} />);
  return (
    <span role="img" aria-label={compacting ? 'Compacting context' : `Context window ${pct}% used`}
      className="inline-grid place-items-center size-8 rounded-lg hover:bg-ridge flex-none" data-tip={contextTip(usage, compacting)} data-tip-rich={rich}>
      {compacting ? <MoonLoader size={15} label="Compacting context" /> : <PhaseMoon fraction={pct / 100} color={tone} size={15} />}
    </span>
  );
}

