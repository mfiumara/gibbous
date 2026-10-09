import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Play, RotateCcw, Square, Plus, TerminalSquare, X } from 'lucide-react';
import type { Thread, Project } from '../api';
import { IconButton } from '../ui';

// One PTY, attached over /pty. The server keeps it alive across panel closes and replays recent output.
function Term({ thread, name, onExit, controls }: { thread: Thread; name: string; onExit(code: number | null): void; controls: Map<string, (m: object) => void> }) {
  const el = useRef<HTMLDivElement>(null);
  const ws = useRef<WebSocket>(undefined);
  useEffect(() => {
    // Colours come from the theme tokens so the terminal follows night/light.
    const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${n}`).trim();
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, allowProposedApi: true,
      theme: { background: v('well'), foreground: v('moon'), cursor: v('tide'), selectionBackground: v('tide') + '55', black: v('crater'), brightBlack: v('ash'), red: v('oxide'), green: v('sprout'), yellow: v('halo'), blue: v('tide'), magenta: '#b8a6e0', cyan: '#7fc4c0', white: v('moon') },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el.current!);
    let closed = false;
    const sendSize = () => ws.current?.readyState === 1 && ws.current.send('\x00' + JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
    const connect = () => {
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pty?thread=${thread.id}&name=${encodeURIComponent(name)}`);
      ws.current = s;
      s.onopen = () => { fit.fit(); sendSize(); onExit(null); };
      s.onmessage = e => {
        const d = String(e.data);
        if (d.startsWith('\x00')) { try { const m = JSON.parse(d.slice(1)); if (m.exit != null) { onExit(m.exit); term.write(`\r\n\x1b[2m[exited with code ${m.exit}]\x1b[0m\r\n`); } } catch {} return; }
        term.write(d);
      };
      s.onclose = e => { if (!closed && e.code !== 4001) setTimeout(connect, 1500); };
    };
    connect();
    const data = term.onData(d => ws.current?.readyState === 1 && ws.current.send(d));
    const ro = new ResizeObserver(() => { try { fit.fit(); sendSize(); } catch {} });
    ro.observe(el.current!);
    term.focus();
    controls.set(name, m => { if ('restart' in m) term.reset(); ws.current?.send('\x00' + JSON.stringify(m)); });
    return () => { controls.delete(name); closed = true; ro.disconnect(); data.dispose(); ws.current?.close(); term.dispose(); };
  }, [thread.id, name]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el} className="h-full bg-well" />;
}

export function TerminalPanel({ thread, project }: { thread: Thread; project?: Project }) {
  const scripts = project?.scripts ?? [];
  const [tabs, setTabs] = useState(['shell']);
  const [active, setActive] = useState('shell');
  const [exit, setExit] = useState<Record<string, number | null>>({});
  const controls = useRef(new Map<string, (m: object) => void>()).current;
  const control = (m: object) => controls.get(active)?.(m);
  const open = (id: string) => { setTabs(t => t.includes(id) ? t : [...t, id]); setActive(id); };
  const closeTab = (id: string) => {
    control({ close: true });
    setTabs(t => t.filter(x => x !== id));
    setActive('shell');
  };
  const isScript = active.startsWith('script:');
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line overflow-x-auto">
        {tabs.map(id => (
          <span key={id} className={`group inline-flex items-center rounded-lg ${active === id ? 'bg-ridge text-moon' : 'text-dust hover:text-moon'}`}>
            <button onClick={() => setActive(id)} className="press inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 text-[12.5px] font-mono">
              {id.startsWith('script:') ? <Play size={11} className={exit[id] == null ? 'text-tide' : exit[id] === 0 ? 'text-sprout' : 'text-oxide'} /> : <TerminalSquare size={12} />}
              {id.startsWith('script:') ? id.slice(7) : id === 'shell' ? 'shell' : `shell ${id.split('-')[1]}`}
            </button>
            {id !== 'shell' && <button onClick={() => closeTab(id)} aria-label={`Close ${id}`} className="press pr-1.5 text-ash hover:text-moon opacity-0 group-hover:opacity-100"><X size={11} /></button>}
          </span>
        ))}
        <IconButton label="New shell" onClick={() => open(`shell-${tabs.filter(t => t.startsWith('shell')).length + 1}`)}><Plus size={14} /></IconButton>
        <span className="flex-1" />
        {isScript && <>
          <IconButton label="Restart" onClick={() => control({ restart: true })}><RotateCcw size={13} /></IconButton>
          {exit[active] == null && <IconButton label="Stop" onClick={() => control({ kill: true })}><Square size={12} /></IconButton>}
        </>}
      </div>
      {scripts.length > 0 && <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 border-b border-line">
        <span className="label mr-1">Run</span>
        {scripts.map(s => <button key={s.name} onClick={() => open(`script:${s.name}`)} data-tip={s.command}
          className="press inline-flex items-center gap-1 h-6 px-2 rounded-md border border-line bg-crater text-[12px] font-mono hover:border-ash/50"><Play size={10} className="text-sprout" />{s.name}</button>)}
      </div>}
      <div className="flex-1 min-h-0">
        {tabs.map(id => <div key={id} className={id === active ? 'h-full' : 'hidden'}><Term thread={thread} name={id} controls={controls} onExit={c => setExit(e => ({ ...e, [id]: c }))} /></div>)}
      </div>
    </div>
  );
}
