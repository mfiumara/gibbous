import { useEffect, useState } from 'react';
import { RefreshCw, FlaskConical, ExternalLink, UserCheck, UserX, ChevronDown } from 'lucide-react';
import { hermes } from '../api';
import { useStore, toastError } from '../store';
import { Button, IconButton, Switch, Skeleton, inputCls } from '../ui';
import { Section } from './common';

interface EnvVar { key: string; required?: boolean; is_set: boolean; redacted_value?: string; description?: string; prompt?: string; password?: boolean; is_password?: boolean }
interface Platform { id: string; name: string; description?: string; docs_url?: string; enabled: boolean; configured: boolean; state: string; error_message?: string; home_channel?: string; env_vars: EnvVar[] }
interface Pairing { pending: { platform: string; request_id?: string; code?: string; user_id?: string; username?: string }[]; approved: { platform: string; user_id: string; username?: string }[] }

const stateTone = (s: string) => s === 'connected' ? 'bg-sprout' : /connecting|retrying|pending/.test(s) ? 'bg-halo animate-pulse' : /fatal|failed|startup/.test(s) ? 'bg-oxide' : 'bg-ash';

function PlatformRow({ p, reload }: { p: Platform; reload(): void }) {
  const [open, setOpen] = useState(false);
  const [env, setEnv] = useState<Record<string, string>>({});
  const toast = useStore(s => s.toast);
  const save = async (patch: { enabled?: boolean }) => {
    const values = Object.fromEntries(Object.entries(env).filter(([, v]) => v.trim()));
    try { const r = await hermes.put<{ hot_served?: boolean }>(`messaging/platforms/${p.id}`, { ...patch, env: values }); setEnv({}); toast({ title: `${p.name} saved`, body: r.hot_served ? undefined : 'Restart the gateway to apply.' }); reload(); }
    catch (e) { toastError(e); }
  };
  const test = () => hermes.post<{ ok: boolean; message?: string }>(`messaging/platforms/${p.id}/test`).then(r => toast({ title: r.ok ? `${p.name} works` : `${p.name} failed`, body: r.message, tone: r.ok ? undefined : 'error' }), toastError);
  return (
    <li className="py-3">
      <div className="flex items-center gap-3 text-sm">
        <span className={`size-2 rounded-full flex-none ${stateTone(p.state)}`} data-tip={p.state} />
        <button onClick={() => setOpen(!open)} className="flex-1 min-w-0 text-left pointer-coarse:py-2">
          <span className="font-bold">{p.name}</span><span className="label ml-2">{p.state.replace(/_/g, ' ')}</span>
          {p.error_message && <span className="block text-[12px] text-oxide truncate">{p.error_message}</span>}
        </button>
        {p.configured && <IconButton label="Test" onClick={test}><FlaskConical size={14} /></IconButton>}
        <Switch label={`Enable ${p.name}`} checked={p.enabled} onChange={v => save({ enabled: v })} />
        <IconButton label={open ? 'Hide settings' : 'Settings'} onClick={() => setOpen(!open)}><ChevronDown size={15} className={`transition-transform ${open ? 'rotate-180' : ''}`} /></IconButton>
      </div>
      {open && <div className="mt-3 ml-5 space-y-2.5 animate-fade">
        {p.description && <p className="text-[12.5px] text-dust">{p.description} {p.docs_url && <a href={p.docs_url} target="_blank" rel="noreferrer" className="text-tide inline-flex items-center gap-0.5">Setup guide <ExternalLink size={11} /></a>}</p>}
        {p.env_vars.map(v => (
          <label key={v.key} className="block space-y-1">
            <span className="flex items-center gap-2"><span className="font-mono text-[12px]">{v.key}</span>{v.required && <span className="label text-[9px]">required</span>}{v.is_set && <span className="label text-[9px] text-sprout">set</span>}</span>
            <input type={v.is_password || v.password || /TOKEN|KEY|SECRET|PASSWORD/.test(v.key) ? 'password' : 'text'} className={inputCls + ' font-mono text-[12.5px]'} placeholder={v.is_set ? `${v.redacted_value ?? '••••'} (leave empty to keep)` : v.prompt ?? v.description ?? ''}
              value={env[v.key] ?? ''} onChange={e => setEnv(x => ({ ...x, [v.key]: e.target.value }))} autoComplete="off" />
          </label>
        ))}
        <div className="flex justify-end"><Button size="sm" tone="primary" disabled={!Object.values(env).some(v => v.trim())} onClick={() => save({})}>Save credentials</Button></div>
      </div>}
    </li>
  );
}

export function PlatformsTab() {
  const toast = useStore(s => s.toast);
  const [platforms, setPlatforms] = useState<Platform[]>();
  const [pairing, setPairing] = useState<Pairing>();
  const load = () => {
    hermes.get<{ platforms: Platform[] }>('messaging/platforms').then(r => setPlatforms(r.platforms), toastError);
    hermes.get<Pairing>('pairing').then(setPairing, () => {});
  };
  useEffect(() => { load(); }, []);
  const restart = () => hermes.post('gateway/restart').then(() => { toast({ title: 'Gateway restarting', body: 'Channels reconnect in a few seconds.' }); setTimeout(load, 5000); }, toastError);
  const sorted = [...(platforms ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  return <>
    <Section title="Messaging platforms"
      aside={<Button size="sm" onClick={restart}><RefreshCw size={12} />Restart gateway</Button>}>
      {!platforms ? <Skeleton className="h-48" /> : <ul className="divide-y divide-line">{sorted.map(p => <PlatformRow key={p.id} p={p} reload={load} />)}</ul>}
    </Section>
    {pairing && (pairing.pending.length > 0 || pairing.approved.length > 0) && (
      <Section title="People who can DM Hermes" description="Approve people who asked to pair.">
        {pairing.pending.map(r => (
          <div key={`${r.platform}:${r.request_id ?? r.code}`} className="flex items-center gap-3 py-1.5 text-sm">
            <span className="flex-1"><span className="label mr-2">{r.platform}</span>{r.username ?? r.user_id ?? r.code}</span>
            <Button size="sm" tone="halo" onClick={() => hermes.post('pairing/approve', { platform: r.platform, request_id: r.request_id, code: r.code }).then(load, toastError)}><UserCheck size={12} />Approve</Button>
          </div>
        ))}
        {pairing.approved.map(a => (
          <div key={`${a.platform}:${a.user_id}`} className="flex items-center gap-3 py-1.5 text-sm">
            <span className="flex-1"><span className="label mr-2">{a.platform}</span>{a.username ?? a.user_id}</span>
            <IconButton label="Revoke" onClick={() => confirm('Revoke access?') && hermes.post('pairing/revoke', { platform: a.platform, user_id: a.user_id }).then(load, toastError)}><UserX size={14} /></IconButton>
          </div>
        ))}
      </Section>
    )}
  </>;
}
