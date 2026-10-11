// First-run setup (#/setup): 1) install Hermes (official installer, live log) or do it yourself, 2) choose a model
// (in-app sign-in, an API key, or a terminal command where Hermes only offers one), 3) the session import (Welcome).
// Opens on its own while setup is incomplete (needsSetup in setup.ts); Settings → General links here later.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, KeyRound, LogIn, Settings2, SquareTerminal } from 'lucide-react';
import { api, hermes as hermesApi } from './api';
import { useStore, toastError } from './store';
import { useShallow } from 'zustand/react/shallow';
import { Button, Logo, MoonLoader, PhaseMoon, inputCls, go, NO_PREDICT } from './ui';
import { setupStep, SIGN_INS, KEYS, ELSEWHERE, moreKeyProviders, pickModel, osLabel, type Choice, type OptionProvider } from './onboarding';

interface SetupInfo {
  os: 'macos' | 'linux' | 'wsl' | 'windows';
  hermes: { home: string; homeShown: string; bin?: string; version?: string; error?: string };
  install: { running: boolean; command: string; docs: string; result?: { ok: boolean; error?: string } };
  serveLog?: string[];
}

export function Setup() {
  const { h, ready, log, result } = useStore(useShallow(s => ({ h: s.hermes, ready: s.hermesReady, log: s.setupLog, result: s.setupResult })));
  const [info, setInfo] = useState<SetupInfo>();
  const [changing, setChanging] = useState(false); // "Change model" on an already set-up agent
  const [justSet, setJustSet] = useState<string>(); // the model chosen here, for the closing line
  const step = setupStep(h, ready);
  const refresh = () => api.get<SetupInfo>('/api/setup').then(setInfo, () => {});
  useEffect(() => {
    refresh();
    api.get<{ lines: string[]; result?: { ok: boolean; error?: string; at: number } }>('/api/setup/log')
      .then(r => useStore.setState({ setupLog: r.lines, setupResult: r.result }), () => {});
  }, []);
  useEffect(() => { refresh(); }, [step, h?.error, result]); // eslint-disable-line react-hooks/exhaustive-deps

  const showModel = step === 'model' || (step === 'done' && changing);
  const current = step === 'install' ? 0 : step === 'starting' ? 0.5 : showModel ? 1 : 2;
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden" data-pane="items">
      <div className="mx-auto max-w-xl px-5 pt-[max(calc(env(safe-area-inset-top)+1.5rem),8vh)] sm:pt-[13vh] pb-[max(env(safe-area-inset-bottom),2.5rem)] space-y-8 animate-rise">
        <header className="space-y-6">
          <div className="flex items-center gap-2.5"><Logo size={20} /><span className="font-label tracking-[0.2em] text-[13px]">gibbous</span></div>
          <Steps at={current} />
        </header>

        {step === 'install' && <InstallStep info={info} log={log} result={result} />}
        {step === 'starting' && <StartingStep info={info} log={log} />}
        {showModel && <ModelStep os={info?.os} configured={h?.configured === true} onDone={m => { setJustSet(m); setChanging(false); }} onCancel={changing ? () => setChanging(false) : undefined} />}
        {step === 'done' && !changing && <DoneStep model={justSet ?? h?.model} provider={h?.provider} freeTier={h?.freeTier} onChange={() => setChanging(true)} />}

        {step !== 'install' && <p className="pt-2 text-[12px] text-ash">Gibbous runs on <a className="underline underline-offset-2 hover:text-moon" href="https://hermes-agent.nousresearch.com" target="_blank" rel="noreferrer">Hermes</a>, the open-source agent by Nous Research.</p>}
      </div>
    </div>
  );
}

// Three moons: done = full, here = waxing, ahead = new.
function Steps({ at }: { at: number }) {
  const names = ['Install', 'Model', 'Sessions'];
  return (
    <ol className="flex items-center gap-2 text-[12.5px]" aria-label="Setup steps">
      {names.map((n, i) => {
        const f = at > i ? 1 : Math.floor(at) === i ? 0.5 : 0;
        return (
          <li key={n} className="flex items-center gap-2" aria-current={f === 0.5 ? 'step' : undefined}>
            {i > 0 && <span className="w-5 sm:w-8 h-px bg-line" />}
            <PhaseMoon fraction={f} color={f === 1 ? 'var(--color-moon)' : 'var(--color-tide)'} size={13} />
            <span className={f === 0.5 ? 'text-moon' : f === 1 ? 'text-dust' : 'text-ash'}>{n}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return <div className="space-y-2"><h1 className="text-[28px] sm:text-[32px] leading-[1.1] font-bold tracking-[-.02em]">{children}</h1>{sub && <p className="text-[14.5px] text-dust">{sub}</p>}</div>;
}

// ── 1. Install ──────────────────────────────────────────────────────────
function InstallStep({ info, log, result }: { info?: SetupInfo; log: string[]; result?: { ok: boolean; error?: string } }) {
  const [busy, setBusy] = useState(false), [manual, setManual] = useState(false);
  const installing = busy || (log.length > 0 && !result); // lines only flow while an install runs; `result` ends it
  const failed = result && !result.ok && !installing;
  const start = () => { setBusy(true); useStore.setState({ setupLog: [], setupResult: undefined }); api.post('/api/setup/hermes/install', {}).catch(toastError).finally(() => setBusy(false)); };
  return (
    <section className="space-y-6">
      <Title sub={<>Gibbous runs on Hermes, the open-source agent by Nous Research. It isn't on this {osLabel(info?.os)} yet.</>}>Install the agent</Title>
      {!installing && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button tone="primary" size="lg" onClick={start} disabled={!info}>{failed ? 'Try again' : 'Install Hermes'}</Button>
            <Button size="lg" onClick={() => setManual(m => !m)} aria-expanded={manual}>I'll do it myself</Button>
          </div>
          {!failed && <p className="text-[12.5px] text-ash">Uses Hermes' official installer. It sets up in <span className="font-mono">{info?.hermes.homeShown ?? '~/.hermes'}</span>, adds the <span className="font-mono">hermes</span> command and takes a few minutes.</p>}
        </div>
      )}
      {installing && (
        <div className="flex items-center gap-3" role="status">
          <MoonLoader size={22} label="Installing" />
          <span className="flex-1 text-sm">Installing Hermes… <span className="text-dust">this takes a few minutes.</span></span>
          <Button size="sm" onClick={() => api.post('/api/setup/hermes/cancel', {}).catch(toastError)}>Cancel</Button>
        </div>
      )}
      {failed && <p className="text-sm text-oxide select-text">{result!.error}</p>}
      {(installing || log.length > 0) && <LogWell lines={log} live={installing} />}
      {manual && !installing && <Manual info={info} />}
    </section>
  );
}

function Manual({ info }: { info?: SetupInfo }) {
  const [checking, setChecking] = useState(false);
  const win = info?.os === 'windows';
  return (
    <div className="surface rounded-2xl p-5 space-y-3 animate-rise">
      <p className="text-sm">Run this in {win ? 'PowerShell' : 'a terminal'}, then come back:</p>
      {info && <CommandLine command={info.install.command} />}
      <p className="text-[12.5px] text-dust">Gibbous notices on its own once Hermes is installed. If your installer asks to set up a model, you can do that there or here afterwards.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={checking} onClick={() => { setChecking(true); api.post('/api/setup/hermes/check', {}).catch(toastError).finally(() => setTimeout(() => setChecking(false), 800)); }}>
          {checking ? <><MoonLoader size={13} />Checking…</> : 'Check again'}</Button>
        {info && <a className="press inline-flex items-center gap-1.5 text-[13px] text-tide hover:underline" href={info.install.docs} target="_blank" rel="noreferrer">Installation guide<ExternalLink size={12} /></a>}
      </div>
    </div>
  );
}

// ── Hermes installed, `serve` coming up (or failing) ────────────────────
function StartingStep({ info, log }: { info?: SetupInfo; log: string[] }) {
  const error = useStore(s => s.hermes?.error);
  const [retrying, setRetrying] = useState(false);
  if (!error) return (
    <section className="space-y-6">
      <Title sub="Hermes is installed. Starting it up for the first time can take a minute.">Starting the agent</Title>
      <div className="flex items-center gap-3 text-sm text-dust" role="status"><MoonLoader size={22} label="Starting" />Waiting for Hermes…</div>
      {log.length > 0 && <Fold label="Install log"><LogWell lines={log} /></Fold>}
    </section>
  );
  return (
    <section className="space-y-6">
      <Title sub="Hermes is installed but didn't start. Gibbous keeps trying in the background.">The agent won't start</Title>
      <p className="text-sm text-oxide select-text">{error}</p>
      {!!info?.serveLog?.length && <LogWell lines={info.serveLog} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button tone="primary" disabled={retrying} onClick={() => { setRetrying(true); api.post('/api/setup/hermes/check', {}).catch(toastError).finally(() => setTimeout(() => setRetrying(false), 1500)); }}>{retrying ? <><MoonLoader size={14} />Trying…</> : 'Try again'}</Button>
        <span className="text-[12.5px] text-dust">In a terminal, <span className="font-mono text-moon/85">hermes doctor</span> explains most problems.</span>
      </div>
    </section>
  );
}

// ── 2. Model ────────────────────────────────────────────────────────────
type Flow =
  | { stage: 'idle' }
  | { stage: 'starting' | 'saving' | 'checking'; choice: Choice }
  | { stage: 'device'; choice: Choice; session: string; code: string; url: string; copied?: boolean }
  | { stage: 'confirm'; choice: Choice; provider: string; models: string[]; model: string; warning?: string }
  | { stage: 'error'; choice: Choice; message: string };

function ModelStep({ os, configured, onDone, onCancel }: { os?: string; configured: boolean; onDone(model: string): void; onCancel?(): void }) {
  const [open, setOpen] = useState<string>();
  const [flow, setFlow] = useState<Flow>({ stage: 'idle' });
  const [more, setMore] = useState<Choice[]>();
  const poll = useRef<ReturnType<typeof setInterval>>(undefined);
  const stopPoll = () => { clearInterval(poll.current); poll.current = undefined; };
  useEffect(() => () => stopPoll(), []);
  useEffect(() => { hermesApi.get<{ providers: OptionProvider[] }>('model/options?include_unconfigured=1').then(r => setMore(moreKeyProviders(r.providers ?? [])), () => setMore([])); }, []);

  const fail = (choice: Choice, e: unknown) => setFlow({ stage: 'error', choice, message: (e as Error)?.message ?? String(e) });
  // A credential landed: offer the provider's models, starting on Hermes' recommended default.
  const confirm = async (choice: Choice) => {
    setFlow({ stage: 'checking', choice });
    try {
      const s = await api.post<{ configured: boolean | null; hermes: { model?: string; reason?: string } }>('/api/setup/check', {});
      if (choice.id === ELSEWHERE.id) { // `hermes model` picked provider and model itself
        if (s.configured === false) throw new Error(s.hermes.reason ?? 'The agent still has no usable model. Finish `hermes model` in the terminal, then check again.');
        setFlow({ stage: 'idle' }); onDone(s.hermes.model ?? ''); return;
      }
      const opts = await hermesApi.get<{ providers: OptionProvider[]; model?: string; provider?: string }>('model/options?include_unconfigured=1');
      const p = opts.providers?.find(x => x.slug === choice.id);
      if (p && p.authenticated === false) throw new Error(choice.kind === 'terminal' ? `${choice.label} isn't connected yet. Run the command above, finish it, then check again.` : `The agent can't use ${choice.label} with that yet.`);
      const rec = await hermesApi.get<{ model?: string }>(`model/recommended-default?provider=${encodeURIComponent(choice.id)}`).catch(() => ({ model: '' }));
      const models = (p?.models ?? []).map(String);
      setFlow({ stage: 'confirm', choice, provider: choice.id, models, model: pickModel(models, rec.model || undefined, opts.provider === choice.id ? opts.model : undefined) });
    } catch (e) { fail(choice, e); }
  };
  const useModel = async (f: Extract<Flow, { stage: 'confirm' }>, sure = false) => {
    setFlow({ stage: 'saving', choice: f.choice });
    try {
      const r = await hermesApi.post<{ ok: boolean; confirm_required?: boolean; confirm_message?: string }>('model/set', { scope: 'main', provider: f.provider, model: f.model, ...(sure ? { confirm_expensive_model: true } : {}) });
      if (r.confirm_required) { setFlow({ ...f, warning: r.confirm_message ?? 'This model is expensive.' }); return; }
      const s = await api.post<{ configured: boolean | null; hermes: { reason?: string } }>('/api/setup/check', {});
      if (s.configured === false) { fail(f.choice, new Error(s.hermes.reason ?? `The agent still can't use ${f.choice.label}.`)); return; }
      setFlow({ stage: 'idle' }); onDone(f.model);
    } catch (e) { fail(f.choice, e); }
  };
  const pick = async (c: Choice) => {
    stopPoll();
    if (flow.stage === 'device') hermesApi.del(`providers/oauth/sessions/${flow.session}`).catch(() => {});
    if (open === c.label) { setOpen(undefined); setFlow({ stage: 'idle' }); return; }
    setOpen(c.label); setFlow({ stage: 'idle' });
    if (c.kind !== 'oauth') return;
    setFlow({ stage: 'starting', choice: c });
    try {
      const s = await hermesApi.post<{ session_id: string; user_code: string; verification_url: string; poll_interval?: number }>(`providers/oauth/${c.id}/start`, {});
      setFlow({ stage: 'device', choice: c, session: s.session_id, code: s.user_code, url: s.verification_url });
      window.open(s.verification_url, '_blank', 'noopener');
      poll.current = setInterval(async () => {
        try {
          const r = await hermesApi.get<{ status: string; error_message?: string }>(`providers/oauth/${c.id}/poll/${s.session_id}`);
          if (r.status === 'pending') return;
          stopPoll();
          if (r.status === 'approved') confirm(c); else fail(c, new Error(r.error_message || `Sign-in ${r.status}.`));
        } catch (e) { stopPoll(); fail(c, e); }
      }, Math.max(2, s.poll_interval ?? 3) * 1000);
    } catch (e) { fail(c, e); }
  };

  const row = (c: Choice, icon: ReactNode) => (
    <div key={c.kind + c.id + c.label} className="border-t border-line first:border-t-0">
      <button onClick={() => pick(c)} aria-expanded={open === c.label} data-vim-item
        className="press w-full flex items-center gap-3 px-4 py-3 pointer-coarse:py-3.5 text-left hover:bg-ridge/50 focus-visible:bg-ridge/50 focus:outline-none">
        <span className="text-dust">{icon}</span>
        <span className="flex-1 min-w-0"><span className="block text-sm">{c.label}</span><span className="block text-[12.5px] text-dust truncate">{c.blurb}</span></span>
        {open === c.label ? <ChevronDown size={15} className="text-ash" /> : <ChevronRight size={15} className="text-ash" />}
      </button>
      {open === c.label && <div className="px-4 pb-4 pt-1 animate-fade"><Panel c={c} flow={flow} setFlow={setFlow} confirm={confirm} useModel={useModel} /></div>}
    </div>
  );
  return (
    <section className="space-y-6" data-vim-list>
      <Title sub={<>Sign in with a plan you already pay for, or paste an API key. The agent keeps it in its own settings on this {osLabel(os)}.</>}>{configured ? 'Change the model' : 'Choose a model'}</Title>
      {onCancel && <Button size="sm" onClick={onCancel}>Keep the current model</Button>}
      <Group label="Sign in">{SIGN_INS.map(c => row(c, c.kind === 'terminal' ? <SquareTerminal size={16} /> : <LogIn size={16} />))}</Group>
      <Group label="API key">
        {KEYS.map(c => row(c, <KeyRound size={16} />))}
        <div className="border-t border-line px-4 py-3 flex items-center gap-3">
          <span className="text-dust"><KeyRound size={16} /></span>
          <select aria-label="More providers" className={inputCls + ' flex-1 py-1.5'} value="" disabled={!more?.length}
            onChange={e => { const c = more?.find(m => m.id === e.target.value); if (c) { setMore(m => m && [c, ...m.filter(x => x !== c)]); pick(c); } }}>
            <option value="">{more ? `More providers (${more.length})…` : 'Loading providers…'}</option>
            {more?.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        {more?.filter(m => m.label === open && !KEYS.includes(m)).map(c => row(c, <KeyRound size={16} />))}
      </Group>
      <Group>{row(ELSEWHERE, <Settings2 size={16} />)}</Group>
    </section>
  );
}

function Group({ label, children }: { label?: string; children: ReactNode }) {
  return <div className="space-y-2">{label && <p className="label">{label}</p>}<div className="surface rounded-2xl overflow-hidden">{children}</div></div>;
}

function Panel({ c, flow, setFlow, confirm, useModel }: { c: Choice; flow: Flow; setFlow(f: Flow): void; confirm(c: Choice): void; useModel(f: Extract<Flow, { stage: 'confirm' }>, sure?: boolean): void }) {
  const [key, setKey] = useState('');
  const mine = 'choice' in flow && flow.choice.label === c.label ? flow : undefined;
  if (mine?.stage === 'starting' || mine?.stage === 'checking' || mine?.stage === 'saving')
    return <p className="flex items-center gap-2.5 text-sm text-dust" role="status"><MoonLoader size={18} />{mine.stage === 'starting' ? 'Opening the sign-in page…' : mine.stage === 'saving' ? 'Saving…' : 'Checking with the agent…'}</p>;
  if (mine?.stage === 'error') return (
    <div className="space-y-3"><p className="text-sm text-oxide select-text">{mine.message}</p>
      <Button size="sm" onClick={() => setFlow({ stage: 'idle' })}>Try again</Button></div>
  );
  if (mine?.stage === 'device') return (
    <div className="space-y-3">
      <p className="text-sm text-dust">Approve the sign-in in your browser. If it asks for a code, enter:</p>
      <div className="flex items-center gap-3">
        <span className="well rounded-lg px-4 py-2 font-mono text-[20px] tracking-[0.18em] select-text">{mine.code}</span>
        <Button size="sm" onClick={() => navigator.clipboard.writeText(mine.code).then(() => setFlow({ ...mine, copied: true }))}>{mine.copied ? <><Check size={13} />Copied</> : <><Copy size={13} />Copy</>}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => window.open(mine.url, '_blank', 'noopener')}><ExternalLink size={13} />Open the sign-in page</Button>
        <span className="flex items-center gap-2 text-[12.5px] text-dust"><MoonLoader size={14} />Waiting for you to approve…</span>
      </div>
    </div>
  );
  if (mine?.stage === 'confirm') return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm"><Check size={15} className="text-sprout" />Connected. Pick the model to start on:</p>
      {mine.models.length > 1
        ? <select aria-label="Model" className={inputCls} value={mine.model} onChange={e => setFlow({ ...mine, model: e.target.value, warning: undefined })}>{mine.models.map(m => <option key={m}>{m}</option>)}</select>
        : <p className="well rounded-lg px-3 py-2 font-mono text-[13px]">{mine.model || 'the provider’s default'}</p>}
      {mine.warning && <p className="text-[13px] text-halo select-text">{mine.warning}</p>}
      <Button tone="primary" onClick={() => useModel(mine, !!mine.warning)} disabled={!mine.model}>{mine.warning ? 'Use it anyway' : `Use ${mine.model || 'this model'}`}</Button>
    </div>
  );
  if (c.kind === 'key') return (
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault();
      if (!key.trim()) return;
      setFlow({ stage: 'saving', choice: c });
      try { await hermesApi.put('env', { key: c.envKey, value: key.trim(), provider_setup: true }); setKey(''); confirm(c); }
      catch (err) { setFlow({ stage: 'error', choice: c, message: (err as Error).message }); }
    }}>
      <input type="password" autoFocus className={inputCls + ' font-mono'} placeholder={c.placeholder ?? c.envKey} aria-label={`${c.label} API key`} value={key} onChange={e => setKey(e.target.value)} {...NO_PREDICT} />
      <div className="flex flex-wrap items-center gap-3">
        <Button tone="primary" type="submit" disabled={!key.trim()}>Save key</Button>
        {c.url && <a className="press inline-flex items-center gap-1.5 text-[13px] text-tide hover:underline" href={c.url} target="_blank" rel="noreferrer">Get a key<ExternalLink size={12} /></a>}
      </div>
    </form>
  );
  if (c.kind === 'terminal') return (
    <div className="space-y-3">
      <p className="text-sm text-dust">{c.id === 'anthropic' ? 'Hermes signs in to Claude plans only from a terminal. Run this in a new terminal window, follow it, then come back:' : 'Hermes sets these up in a terminal. Run this in a new terminal window, pick your provider, then come back:'}</p>
      <CommandLine command={c.command} />
      <Button size="sm" onClick={() => confirm(c)}>Done, check again</Button>
    </div>
  );
  return null;
}

// ── 3. Done → the session import ─────────────────────────────────────────
function DoneStep({ model, provider, freeTier, onChange }: { model?: string; provider?: string; freeTier?: boolean; onChange(): void }) {
  const fresh = useStore(s => !s.welcomeDone && !s.threads.length && !s.projects.length);
  return (
    <section className="space-y-6">
      <Title sub={model ? <>The agent works with <span className="font-mono text-moon/90">{model}</span>{provider ? <> via {provider}</> : null}{freeTier ? ' on the free tier' : ''}.</> : 'The agent is ready.'}>You're set</Title>
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" size="lg" autoFocus onClick={() => go('/')}>{fresh ? 'Bring your sessions in' : 'Start using Gibbous'}</Button>
        <Button size="lg" onClick={onChange}>Change model</Button>
      </div>
    </section>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────
function LogWell({ lines, live }: { lines: string[]; live?: boolean }) {
  const ref = useRef<HTMLPreElement>(null), pinned = useRef(true);
  useEffect(() => { const el = ref.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [lines]);
  const text = useMemo(() => lines.join('\n'), [lines]);
  return (
    <pre ref={ref} aria-live={live ? 'polite' : undefined} aria-label="Install log" tabIndex={0}
      onScroll={e => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      className="well rounded-xl p-3.5 max-h-72 overflow-auto font-mono text-[11.5px] leading-[1.6] text-dust whitespace-pre-wrap break-words">{text || ' '}</pre>
  );
}

function Fold({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="space-y-2"><button className="press inline-flex items-center gap-1 text-[12.5px] text-dust hover:text-moon" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{label}</button>{open && children}</div>;
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="well rounded-lg flex items-center gap-2 pl-3.5 pr-1.5 py-1.5">
      <code className="flex-1 min-w-0 font-mono text-[12.5px] break-all select-text">{command}</code>
      <Button size="sm" onClick={() => navigator.clipboard.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, toastError)}>{copied ? <><Check size={13} />Copied</> : <><Copy size={13} />Copy</>}</Button>
    </div>
  );
}
