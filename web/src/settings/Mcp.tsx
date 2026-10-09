import { useEffect, useState } from 'react';
import { Plus, Trash2, FlaskConical, KeyRound, RefreshCw, Store, ChevronDown } from 'lucide-react';
import { hermes } from '../api';
import { rpc } from '../rpc';
import { useStore, toastError } from '../store';
import { Button, IconButton, Modal, Field, Segmented, Switch, Skeleton, inputCls } from '../ui';
import { Section } from './common';
import type { McpServerSummary } from '../hermes/contract';

type Status = { name: string; status: string; tools: number; connected: boolean };
const dot: Record<string, string> = { connected: 'bg-sprout', failed: 'bg-oxide', connecting: 'bg-halo animate-pulse', disabled: 'bg-ash', lazy: 'bg-tide', configured: 'bg-tide' };

function AddServer({ open, onClose, onDone }: { open: boolean; onClose(): void; onDone(): void }) {
  const [kind, setKind] = useState<'http' | 'stdio'>('http');
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [oauth, setOauth] = useState(false); const [token, setToken] = useState('');
  const [command, setCommand] = useState(''); const [args, setArgs] = useState(''); const [env, setEnv] = useState('');
  const save = async () => {
    const config = kind === 'http'
      ? { url, ...(oauth ? { auth: 'oauth' } : {}), enabled: true }
      : { command, args: args.split(/\s+/).filter(Boolean), env: Object.fromEntries(env.split('\n').map(l => l.split('=')).filter(([k]) => k?.trim()).map(([k, ...v]) => [k.trim(), v.join('=').trim()])), enabled: true };
    try { await rpc.call('mcp.servers.add', { name, config, bearer_token: kind === 'http' && token ? token : undefined }); await rpc.call('reload.mcp', {}).catch(() => {}); onDone(); onClose(); }
    catch (e) { toastError(e); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add an MCP server" wide>
      <Segmented label="Transport" value={kind} onChange={setKind} options={[{ value: 'http', label: 'Remote (HTTP)' }, { value: 'stdio', label: 'Local command' }]} />
      <Field label="Name"><input className={inputCls + ' font-mono'} value={name} onChange={e => setName(e.target.value.replace(/[^\w-]/g, '_'))} placeholder="github" autoFocus /></Field>
      {kind === 'http' ? <>
        <Field label="URL"><input className={inputCls + ' font-mono'} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" /></Field>
        <label className="flex items-center gap-2 text-sm"><Switch label="Sign in with OAuth" checked={oauth} onChange={setOauth} />Sign in with OAuth (connect after adding)</label>
        {!oauth && <Field label="API key (optional)" hint="Stored in .env."><input type="password" className={inputCls + ' font-mono'} value={token} onChange={e => setToken(e.target.value)} /></Field>}
      </> : <>
        <Field label="Command"><input className={inputCls + ' font-mono'} value={command} onChange={e => setCommand(e.target.value)} placeholder="npx" /></Field>
        <Field label="Arguments"><input className={inputCls + ' font-mono'} value={args} onChange={e => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ~/Documents" /></Field>
        <Field label="Environment" hint="KEY=value per line; ${VAR} reads from Hermes' environment."><textarea className={inputCls + ' font-mono text-[12.5px] min-h-16'} value={env} onChange={e => setEnv(e.target.value)} /></Field>
      </>}
      <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button tone="primary" disabled={!name || (kind === 'http' ? !url : !command)} onClick={save}>Add server</Button></div>
    </Modal>
  );
}

function Catalog({ installed, onDone }: { installed: Set<string>; onDone(): void }) {
  const [items, setItems] = useState<{ name: string; description: string; installed: boolean; requires: string[] }[]>();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && !items) rpc.call('mcp.catalog', {}).then((r: any) => setItems(r.servers ?? []), toastError); }, [open, items]);
  const install = (name: string) => rpc.call('mcp.servers.add', { name, preset: name }).then(() => rpc.call('reload.mcp', {})).then(onDone, toastError);
  return (
    <Section title="Catalog" aside={<IconButton label={open ? 'Hide' : 'Show'} onClick={() => setOpen(!open)}><ChevronDown size={15} className={open ? 'rotate-180' : ''} /></IconButton>}>
      {open && (!items ? <Skeleton className="h-20" /> : <ul className="grid sm:grid-cols-2 gap-2">{items.map(i => (
        <li key={i.name} className="rounded-xl border border-line p-3 flex flex-col gap-1.5">
          <p className="font-bold text-sm flex items-center gap-1.5"><Store size={13} className="text-ash" />{i.name}</p>
          <p className="text-[12.5px] text-dust flex-1">{i.description}</p>
          {i.requires?.length > 0 && <p className="text-[11px] text-ash font-mono">needs {i.requires.join(', ')}</p>}
          <div>{i.installed || installed.has(i.name) ? <span className="label text-sprout">installed</span> : <Button size="sm" onClick={() => install(i.name)}>Install</Button>}</div>
        </li>
      ))}</ul>)}
    </Section>
  );
}

export function McpTab() {
  const toast = useStore(s => s.toast);
  const [servers, setServers] = useState<McpServerSummary[]>();
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [tools, setTools] = useState<Record<string, { name: string; description?: string }[]>>({});
  const load = () => {
    rpc.call('mcp.servers.list', {}).then(r => setServers(r.servers), toastError);
    rpc.call('mcp.servers.status', {}).then((r: any) => setStatus(Object.fromEntries((r.servers ?? []).map((s: Status) => [s.name, s]))), () => {});
  };
  useEffect(() => { load(); }, []);
  const test = async (name: string) => {
    setTesting(name);
    try {
      const r: any = await rpc.call('mcp.servers.test', { name });
      if (r.ok) { setTools(t => ({ ...t, [name]: r.tools ?? [] })); toast({ title: `${name}: ${r.tools?.length ?? 0} tools` }); }
      else toast({ title: `${name} didn't respond`, body: r.oauth_needed ? 'It needs an OAuth sign-in.' : r.error, tone: 'error' });
    } catch (e) { toastError(e); } finally { setTesting(null); }
  };
  const oauth = async (name: string) => {
    try {
      const s: any = await rpc.call('mcp.servers.oauth.start', { name });
      window.open(s.auth_url, '_blank');
      toast({ title: `Finish signing in to ${name} in the new tab` });
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 2500));
        const p: any = await rpc.call('mcp.servers.oauth.poll', { name, session_id: s.session_id });
        if (p.status === 'approved') { toast({ title: `${name} connected` }); await rpc.call('reload.mcp', {}); load(); return; }
        if (p.status === 'error') { toast({ title: `${name} sign-in failed`, body: p.error_message, tone: 'error' }); return; }
      }
    } catch (e) { toastError(e); }
  };
  const setEnabled = (name: string, enabled: boolean) => hermes.put(`mcp/servers/${encodeURIComponent(name)}/enabled`, { enabled }).then(() => rpc.call('reload.mcp', {})).then(load, toastError);
  const remove = (name: string) => confirm(`Remove ${name}?`) && rpc.call('mcp.servers.remove', { name }).then(() => rpc.call('reload.mcp', {})).then(load, toastError);

  return <>
    <Section title="MCP servers"
      aside={<div className="flex gap-2"><IconButton label="Reload all" onClick={() => rpc.call('reload.mcp', {}).then(() => { toast({ title: 'MCP servers reloaded' }); load(); }, toastError)}><RefreshCw size={14} /></IconButton><Button tone="primary" onClick={() => setAdding(true)}><Plus size={14} />Add server</Button></div>}>
      {!servers ? <Skeleton className="h-32" /> : <ul className="divide-y divide-line">{servers.map(m => {
        const st = status[m.name];
        return (
          <li key={m.name} className="py-3 space-y-2">
            <div className="flex items-center gap-3 text-sm">
              <span className={`size-2 rounded-full flex-none ${dot[st?.status ?? (m.enabled ? 'configured' : 'disabled')] ?? 'bg-ash'}`} data-tip={st?.status ?? (m.enabled ? 'configured' : 'disabled')} />
              <span className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono font-bold">{m.name}</span>
                <span className="label truncate max-w-full">{m.transport}{m.auth ? ` · ${m.auth}` : ''}{st?.tools ? ` · ${st.tools} tools` : ''}</span>
                <span className="text-xs text-ash truncate basis-full sm:basis-0 sm:flex-1 min-w-0">{m.url ?? [m.command, ...m.args].join(' ')}</span>
              </span>
              {m.auth === 'oauth' && !m.oauth_tokens_present && <Button size="sm" tone="halo" onClick={() => oauth(m.name)}><KeyRound size={12} />Sign in</Button>}
              <IconButton label="Test connection" disabled={testing === m.name} onClick={() => test(m.name)}><FlaskConical size={14} className={testing === m.name ? 'animate-pulse' : ''} /></IconButton>
              {m.source === 'config' && <Switch label={`Enable ${m.name}`} checked={m.enabled} onChange={v => setEnabled(m.name, v)} />}
              {m.source === 'config' && <IconButton label="Remove" onClick={() => remove(m.name)}><Trash2 size={14} /></IconButton>}
            </div>
            {tools[m.name] && <div className="flex flex-wrap gap-1 pl-5 animate-fade">{tools[m.name].map(t => <span key={t.name} data-tip={t.description} className="rounded-md bg-ridge px-1.5 py-0.5 font-mono text-[11px] text-dust">{t.name}</span>)}</div>}
          </li>
        );
      })}</ul>}
    </Section>
    <Catalog installed={new Set(servers?.map(s => s.name))} onDone={load} />
    <AddServer open={adding} onClose={() => setAdding(false)} onDone={load} />
  </>;
}
