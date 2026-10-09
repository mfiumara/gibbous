// Background processes the agent started in this session (dev servers, watchers, long builds).
import { useEffect, useState } from 'react';
import { Square, Activity } from 'lucide-react';
import { useRpc } from '../rpc';
import { toastError } from '../store';
import { IconButton, Empty } from '../ui';
import type { ProcessEntry } from '../hermes/contract';

const uptime = (s?: number | null) => s == null ? '' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

export function ProcessesPanel({ sid }: { sid?: string }) {
  const rpc = useRpc();
  const [list, setList] = useState<ProcessEntry[]>();
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!sid) return;
    const load = () => rpc.call('process.list', { session_id: sid }).then(r => setList(r.processes ?? []), () => setList([]));
    load();
    const h = setInterval(load, 3000); // ponytail: polling; switch to agent.terminal.output events if 3s feels laggy
    return () => clearInterval(h);
  }, [sid]);
  const kill = (p: ProcessEntry) => sid && rpc.call('process.kill', { session_id: sid, process_id: p.session_id }).catch(toastError);
  if (!list) return null;
  if (!list.length) return <Empty title="No background processes" />;
  return (
    <ul className="h-full overflow-y-auto p-3 space-y-2">
      {list.map(p => {
        const live = (p.status ?? '').match(/run|start|alive/i) && p.exit_code == null;
        return (
          <li key={p.session_id} className="rounded-xl border border-line overflow-hidden animate-rise">
            <div className="flex items-center gap-2.5 px-3 py-2">
              <Activity size={14} className={live ? 'text-sprout animate-pulse' : 'text-ash'} />
              <button onClick={() => setOpen(open === p.session_id ? null : p.session_id)} className="flex-1 min-w-0 text-left">
                <span className="block font-mono text-[12.5px] truncate">{p.command}</span>
                <span className="block text-[11px] text-ash">{live ? `running · ${uptime(p.uptime_seconds)}` : `exited${p.exit_code != null ? ` ${p.exit_code}` : ''}`}{p.pid ? ` · pid ${p.pid}` : ''}</span>
              </button>
              {live && <IconButton label="Stop (SIGTERM)" onClick={() => kill(p)}><Square size={12} /></IconButton>}
            </div>
            {(open === p.session_id || live) && (p.output_tail || p.output_preview) && <pre className="max-h-56 overflow-auto bg-well border-t border-line px-3 py-2 font-mono text-[11.5px] text-dust whitespace-pre-wrap">{(p.output_tail || p.output_preview || '').slice(-6000)}</pre>}
          </li>
        );
      })}
    </ul>
  );
}
