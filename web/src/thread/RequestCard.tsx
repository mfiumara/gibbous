// Questions the agent asks the user (approval, clarify, sudo/secret). Answered via Gibbous's server,
// which owns these requests for every thread.
import { useState } from 'react';
import { ShieldAlert, HelpCircle, KeyRound } from 'lucide-react';
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

  if (r.method === 'clarify') return shell(<HelpCircle size={17} className="text-halo flex-none mt-0.5" />, <Clarify r={r} />);

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
  const what = r.method === 'sudo' ? 'Your sudo password' : r.params?.prompt ?? r.params?.description ?? r.params?.name ?? 'A secret value';
  return <form className="space-y-2" onSubmit={e => { e.preventDefault(); answer(r, { value: v }); }}>
    <p className="text-sm font-bold">{what}</p>
    <input type="password" autoComplete="off" className={inputCls} value={v} onChange={e => setV(e.target.value)} />
    <div className="flex gap-2"><Button size="sm" tone="halo" type="submit">Send</Button><Button size="sm" type="button" onClick={() => answer(r, {})}>Cancel</Button></div>
  </form>;
}
