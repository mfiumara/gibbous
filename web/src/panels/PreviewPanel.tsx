// Preview of a dev server the agent (or you) started. Opens itself on Hermes' preview.open events.
import { useEffect, useState } from 'react';
import { RotateCw, ExternalLink, Globe } from 'lucide-react';
import { IconButton, Empty, inputCls } from '../ui';

const isLocal = (u: string) => { try { return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

export function PreviewPanel({ url, setUrl, suggestions }: { url?: string; setUrl(u: string): void; suggestions: string[] }) {
  const [draft, setDraft] = useState(url ?? '');
  const [n, setN] = useState(0);
  useEffect(() => { setDraft(url ?? ''); }, [url]);
  // A localhost URL only resolves on the Mac itself; over the tailnet the phone would load its own localhost.
  const remote = url && isLocal(url) && !['localhost', '127.0.0.1'].includes(location.hostname);
  const go = (u: string) => setUrl(/^https?:\/\//.test(u) ? u : `http://${u}`);
  return (
    <div className="h-full flex flex-col">
      <form onSubmit={e => { e.preventDefault(); if (draft.trim()) go(draft.trim()); }} className="flex items-center gap-1 px-2 py-1.5 border-b border-line">
        <Globe size={14} className="text-ash ml-1" />
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="http://localhost:5173" aria-label="Preview address" className={inputCls + ' py-1 text-[12.5px] font-mono border-transparent bg-transparent focus:bg-basalt'} />
        <IconButton label="Reload" type="button" onClick={() => setN(x => x + 1)} disabled={!url}><RotateCw size={14} /></IconButton>
        <IconButton label="Open in browser" type="button" onClick={() => url && window.open(url, '_blank')} disabled={!url}><ExternalLink size={14} /></IconButton>
      </form>
      {!url ? (
        <Empty title="Nothing to preview yet">
          <p>Dev servers open here, or type an address above.</p>
          {suggestions.length > 0 && <div className="flex flex-wrap justify-center gap-1.5">{suggestions.map(s => <button key={s} onClick={() => go(s)} className="press h-7 px-2.5 rounded-md border border-line font-mono text-[12px] hover:border-ash/50">{s}</button>)}</div>}
        </Empty>
      ) : remote ? (
        <Empty title="This preview runs on your Mac">
          <p><span className="font-mono">{url}</span> is only reachable on the Mac. Open it there, or expose it with <span className="font-mono">tailscale serve</span>.</p>
        </Empty>
      ) : <iframe key={n} src={url} title="Preview" className="flex-1 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" />}
    </div>
  );
}
