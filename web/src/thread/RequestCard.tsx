// Questions the agent asks the user (approval, clarify, sudo/secret). Answered via Gibbous's server,
// which owns these requests for every thread.
import { useEffect, useState } from 'react';
import { ShieldAlert, HelpCircle, KeyRound, Plug, Check, ExternalLink } from 'lucide-react';
import { api, type OpenRequest } from '../api';
import { toastError, useStore } from '../store';
import { Button, inputCls, go } from '../ui';
import { haptic } from '../iosBridge';

const answer = (r: OpenRequest, result: unknown) =>
  api.post(`/api/requests/${encodeURIComponent(r.id)}/answer`, { result }).catch(toastError);

export function RequestCard({ r, showThread }: { r: OpenRequest; showThread?: boolean }) {
  const thread = useStore(s => s.threads.find(t => t.id === r.threadId));
  const p = r.params ?? {};
  const head = showThread && thread && (
    <button onClick={() => go(`/t/${thread.id}`)} className="label hover:text-moon truncate max-w-full block text-left">{thread.title}</button>
  );
  const shell = (icon: React.ReactNode, body: React.ReactNode) => (
    <div className="rounded-lg border border-halo/50 bg-halo/[0.06] p-3.5 space-y-2.5">
      {head}
      <div className="flex gap-2.5 items-start">{icon}<div className="min-w-0 flex-1 space-y-2.5">{body}</div></div>
    </div>
  );

  if (r.method === 'approval') {
    const choices: string[] = p.choices ?? ['once', ...(p.allow_session !== false ? ['session'] : []), ...(p.allow_permanent ? ['always'] : []), 'deny'];
    const label: Record<string, string> = { once: 'Allow once', session: 'Allow this session', always: 'Always allow', deny: 'Deny' };
    return shell(<ShieldAlert size={17} className="text-halo flex-none mt-0.5" />, <>
      <p className="text-sm font-bold">{p.tool_name ? `Run ${p.tool_name}?` : 'Allow this command?'}</p>
      {p.command && <pre className="font-mono text-[12.5px] bg-well border border-line rounded-md p-2.5 overflow-x-auto whitespace-pre-wrap">{p.command}</pre>}
      {p.description && <p className="text-[13px] text-dust">{p.description}</p>}
      <div className="flex flex-wrap gap-2">
        {choices.map(c => <Button key={c} size="sm" tone={c === 'once' ? 'halo' : c === 'deny' ? 'danger' : 'ghost'} onClick={() => { haptic(c === 'deny' ? 'deny' : 'allow'); answer(r, { choice: c }); }}>{label[c] ?? c}</Button>)}
      </div>
    </>);
  }

  if (r.method === 'connection') return shell(<Plug size={17} className="text-halo flex-none mt-0.5" />, <Connection r={r} />);

  if (r.method === 'clarify') return shell(<HelpCircle size={17} className="text-halo flex-none mt-0.5" />, <Clarify r={r} />);

  if (r.method === 'vault.save_login') return shell(<KeyRound size={17} className="text-halo flex-none mt-0.5" />, <SaveLogin r={r} />);
  if (r.method === 'sudo' || r.method === 'secret' || r.method === 'vault.code' || r.method === 'vault.unlock_prompt') {
    return shell(<KeyRound size={17} className="text-halo flex-none mt-0.5" />, <SecretInput r={r} />);
  }

  return shell(<HelpCircle size={17} className="text-halo flex-none mt-0.5" />, <>
    <p className="text-sm">The agent asked for <code className="font-mono">{r.method}</code>, which Gibbous can't answer.</p>
    <Button size="sm" tone="danger" onClick={() => answer(r, {})}>Dismiss</Button>
  </>);
}

function Clarify({ r }: { r: OpenRequest }) {
  const qs: { qid: string; question: string; choices?: string[]; multi_select?: boolean }[] = r.params?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const set = (qid: string, v: string) => setAnswers(a => ({ ...a, [qid]: v }));
  return <div data-clarify className="space-y-2.5">
    {qs.map(q => (
      <div key={q.qid} className="space-y-1.5">
        <p className="text-sm font-bold">{q.question}</p>
        {q.choices?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {q.choices.map(c => {
              const picked = q.multi_select ? (answers[q.qid] ?? '').split('\n').includes(c) : answers[q.qid] === c;
              const toggle = () => {
                if (!q.multi_select) return set(q.qid, c);
                const cur = new Set((answers[q.qid] ?? '').split('\n').filter(Boolean));
                cur.has(c) ? cur.delete(c) : cur.add(c);
                set(q.qid, [...cur].join('\n'));
              };
              return <Button key={c} size="sm" tone={picked ? 'primary' : 'ghost'} onClick={toggle} aria-pressed={picked}
                // Hermes' choices can be whole sentences: let them wrap instead of widening the thread.
                className="max-w-full !h-auto min-h-8 pointer-coarse:min-h-10 !py-1.5 !whitespace-normal !justify-start text-left">{c}</Button>;
            })}
          </div>
        ) : null}
        <input className={inputCls} placeholder={q.choices?.length ? 'Or type your own answer' : 'Your answer'}
          value={q.choices?.includes(answers[q.qid]) ? '' : (answers[q.qid] ?? '')} onChange={e => set(q.qid, e.target.value)}
          // Enter sends (or moves on to the next question's field when there are several).
          onKeyDown={e => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const fields = [...(e.currentTarget.closest('[data-clarify]')?.querySelectorAll('input') ?? [])];
            const next = fields[fields.indexOf(e.currentTarget) + 1];
            if (next) next.focus(); else answer(r, { answers });
          }} />
      </div>
    ))}
    <div className="flex gap-2">
      <Button size="sm" tone="halo" onClick={() => answer(r, { answers })}>Send answer</Button>
      <Button size="sm" onClick={() => answer(r, {})}>Skip</Button>
    </div>
  </div>;
}

function SecretInput({ r }: { r: OpenRequest }) {
  const [v, setV] = useState('');
  const what = r.method === 'sudo' ? 'Your sudo password'
    : r.method === 'vault.code' ? `One-time code${r.params?.site ? ` for ${r.params.site}` : ''}${r.params?.hint ? ` (${r.params.hint})` : ''}`
    : r.method === 'vault.unlock_prompt' ? `Master password to unlock ${r.params?.display_name ?? r.params?.backend ?? 'your password manager'}`
    : r.params?.prompt ?? r.params?.description ?? r.params?.name ?? 'A secret value';
  return <form className="space-y-2" onSubmit={e => { e.preventDefault(); answer(r, { value: v }); }}>
    <p className="text-sm font-bold">{what}</p>
    <input type="password" autoComplete="off" className={inputCls} value={v} onChange={e => setV(e.target.value)} />
    <div className="flex gap-2"><Button size="sm" tone="halo" type="submit">Send</Button><Button size="sm" type="button" onClick={() => answer(r, {})}>Cancel</Button></div>
  </form>;
}

// The agent wants to log in to a site with no saved login: you type it here, Hermes stores it encrypted in its vault
// (bound to that site) and fills the page. The agent never sees the password.
function SaveLogin({ r }: { r: OpenRequest }) {
  const [id, setId] = useState(''), [pw, setPw] = useState('');
  const site = r.params?.site || r.params?.origin || 'this site';
  return <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (pw) answer(r, { value: JSON.stringify({ identifier: id.trim(), password: pw }) }); }}>
    <p className="text-sm font-bold">Save a login for {site}</p>
    <p className="text-xs text-dust">Stored encrypted on this machine, for {r.params?.origin ?? site} only. The agent can fill it in but never sees the password.</p>
    <input autoComplete="off" placeholder="Email or username" className={inputCls} value={id} onChange={e => setId(e.target.value)} autoFocus />
    <input type="password" autoComplete="off" placeholder="Password" className={inputCls} value={pw} onChange={e => setPw(e.target.value)} />
    <div className="flex gap-2"><Button size="sm" tone="halo" type="submit" disabled={!pw}>Save and fill</Button><Button size="sm" type="button" onClick={() => answer(r, {})}>Cancel</Button></div>
  </form>;
}

// Connecting an app (Linear, Gmail…, or installing an MCP server). Hermes holds the agent's turn while this card is
// open and settles it once the account shows up as connected, every row is skipped, or Continue is pressed.
type ConnTarget = { name: string; kind: string; action: string; state: string; display?: string | null; detail?: string | null; instructions?: string | null;
  connect_url?: string | null; description?: string | null; required_env?: { name: string; required: boolean; secret: boolean; default: string; prompt?: string | null }[] | null };
const STATE: Record<string, string> = { pending: 'Not connected yet', initiated: 'Waiting for you to sign in…', connected: 'Connected', skipped: 'Skipped', failed: 'Failed', expired: 'Link expired', not_connected: 'Not connected' };

function Connection({ r }: { r: OpenRequest }) {
  const targets: ConnTarget[] = r.params?.targets ?? [];
  const [env, setEnv] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(i); }, []);
  const send = (result: unknown) => { setBusy(true); answer(r, result).finally(() => setBusy(false)); };
  const row = (t: ConnTarget, status: 'approved' | 'skipped') => send({ respond: { targets: [{ name: t.name, status, ...(status === 'approved' && env[t.name] ? { env: env[t.name] } : {}) }] } });
  const label = (t: ConnTarget) => t.display || t.name.charAt(0).toUpperCase() + t.name.slice(1);
  const left = r.params?.deadline_at ? Math.max(0, Math.round((r.params.deadline_at * 1000 - now) / 60_000)) : null;
  return <div className="space-y-2.5">
    <p className="text-sm font-bold">Connect {targets.map(label).join(', ')}</p>
    {targets.map(t => {
      const open = t.state === 'pending' || t.state === 'initiated';
      const install = t.kind !== 'connector';
      return <div key={t.name} className="space-y-1.5 rounded-md border border-line bg-well/50 p-2.5">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-semibold">{label(t)}</span>
          <span className={`text-[12px] ${t.state === 'connected' ? 'text-sprout' : t.state === 'failed' || t.state === 'expired' ? 'text-oxide' : 'text-ash'}`}>{t.state === 'connected' && <Check size={12} className="inline -mt-0.5 mr-0.5" />}{STATE[t.state] ?? t.state}</span>
        </div>
        {(t.description || t.instructions) && <p className="text-[12.5px] text-dust">{t.instructions || t.description}</p>}
        {t.detail && t.state !== 'connected' && <p className="text-[12.5px] text-ash">{t.detail}</p>}
        {install && open && t.state === 'pending' && t.required_env?.map(f =>
          <input key={f.name} type={f.secret ? 'password' : 'text'} autoComplete="off" placeholder={f.prompt || f.name} defaultValue={f.default} className={inputCls}
            onChange={e => setEnv(v => ({ ...v, [t.name]: { ...v[t.name], [f.name]: e.target.value } }))} />)}
        {t.state !== 'connected' && t.state !== 'skipped' && <div className="flex flex-wrap gap-2 pt-0.5">
          {!install && open && t.connect_url && <a href={t.connect_url} target="_blank" rel="noreferrer" onClick={() => haptic('allow')}
            className="press inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-halo text-basalt text-[12.5px] font-semibold">Sign in to {label(t)} <ExternalLink size={12} /></a>}
          {!install && (t.state === 'failed' || t.state === 'expired') && <Button size="sm" tone="halo" disabled={busy} onClick={() => send({ retry: t.name })}>Try again</Button>}
          {install && (t.state === 'pending' || t.state === 'failed') && <Button size="sm" tone="halo" disabled={busy} onClick={() => row(t, 'approved')}>{t.state === 'failed' ? 'Try again' : t.action === 'enable' ? 'Enable' : t.action === 'authorize' ? 'Authorize' : 'Install'}</Button>}
          <Button size="sm" disabled={busy} onClick={() => row(t, 'skipped')}>Not now</Button>
        </div>}
      </div>;
    })}
    <div className="flex items-center gap-2">
      <Button size="sm" tone="ghost" disabled={busy} onClick={() => send({ respond: { settled_by: 'continue' } })}>Continue without waiting</Button>
      {left != null && <span className="text-[11.5px] text-ash">{left > 0 ? `closes in ~${left} min` : 'closing…'}</span>}
    </div>
  </div>;
}
