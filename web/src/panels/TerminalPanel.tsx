import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Play, RotateCcw, Square, Plus, X, Check } from 'lucide-react';
import type { Thread, Project } from '../api';
import { IconButton, Moon } from '../ui';
import { baseName } from '../paths';

// ANSI colours tuned to the moon palette: soft, readable, nothing neon. The background is transparent so the terminal
// sits flush on its panel (no black box); foreground, cursor and selection follow the app's theme tokens.
const NIGHT = {
  black: '#2a2e36', red: '#e0898d', green: '#a9c98f', yellow: '#dcc583', blue: '#8fb2e3', magenta: '#c3a8e4', cyan: '#8cc7c1', white: '#c8cbd2',
  brightBlack: '#5d6371', brightRed: '#eda3a6', brightGreen: '#bcd9a5', brightYellow: '#e8d59e', brightBlue: '#a9c5ee', brightMagenta: '#d3bdee', brightCyan: '#a5d8d2', brightWhite: '#eceae4',
};
const DAY = {
  black: '#16181d', red: '#b4434b', green: '#4c7a32', yellow: '#8a6b12', blue: '#2f5f9e', magenta: '#7a4fa6', cyan: '#2a7a73', white: '#6b7180',
  brightBlack: '#8a909c', brightRed: '#c9575f', brightGreen: '#5b8f3d', brightYellow: '#a07d17', brightBlue: '#3d72b8', brightMagenta: '#8e60bd', brightCyan: '#358f87', brightWhite: '#2a2e36',
};
// xterm parses theme colours itself (no color-mix), so translucency is written as 8-digit hex.
const alpha = (hex: string, a: number) => /^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex;
function theme(): ITheme {
  const css = getComputedStyle(document.documentElement), v = (n: string) => css.getPropertyValue(`--color-${n}`).trim();
  const light = document.documentElement.dataset.theme === 'light';
  return {
    ...(light ? DAY : NIGHT), background: '#00000000', foreground: v('moon'),
    cursor: v('tide'), cursorAccent: v('basalt'), selectionBackground: alpha(v('tide'), .3), selectionInactiveBackground: alpha(v('ash'), .25),
    scrollbarSliderBackground: alpha(v('ash'), .2), scrollbarSliderHoverBackground: alpha(v('ash'), .38), scrollbarSliderActiveBackground: alpha(v('ash'), .5),
  };
}
const phone = () => matchMedia('(max-width: 640px)').matches;

// One PTY, attached over /pty. The server keeps it alive across panel closes and replays recent output.
function Term({ thread, name, active, onExit, controls }: { thread: Thread; name: string; active: boolean; onExit(code: number | null): void; controls: Map<string, (m: object) => void> }) {
  const el = useRef<HTMLDivElement>(null);
  const ws = useRef<WebSocket>(undefined);
  const term = useRef<Terminal>(undefined);
  useEffect(() => {
    let closed = false, cleanup = () => {};
    // Wait for the mono font: xterm measures its cell once, and a fallback font's metrics leave the grid misaligned.
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace';
    document.fonts.load(`13px ${font}`).catch(() => {}).finally(() => {
      if (closed || !el.current) return;
      const t = new Terminal({
        fontFamily: font, fontSize: phone() ? 12 : 13, lineHeight: 1.32, fontWeight: 400, fontWeightBold: 600,
        cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, cursorInactiveStyle: 'outline', allowTransparency: true, allowProposedApi: true,
        scrollback: 10000, minimumContrastRatio: 4.5, drawBoldTextInBrightColors: false, theme: theme(),
      });
      term.current = t;
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el.current);
      const sendSize = () => ws.current?.readyState === 1 && ws.current.send('\x00' + JSON.stringify({ resize: { cols: t.cols, rows: t.rows } }));
      const connect = () => {
        const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pty?thread=${thread.id}&name=${encodeURIComponent(name)}`);
        ws.current = s;
        s.onopen = () => { fit.fit(); sendSize(); onExit(null); };
        s.onmessage = e => {
          const d = String(e.data);
          if (d.startsWith('\x00')) { try { const m = JSON.parse(d.slice(1)); if (m.exit != null) { onExit(m.exit); t.write(`\r\n\x1b[2m── exited with code ${m.exit} ──\x1b[0m\r\n`); } } catch {} return; }
          t.write(d);
        };
        s.onclose = e => { if (!closed && e.code !== 4001) setTimeout(connect, 1500); };
      };
      connect();
      const data = t.onData(d => ws.current?.readyState === 1 && ws.current.send(d));
      const ro = new ResizeObserver(() => { try { fit.fit(); sendSize(); } catch {} });
      ro.observe(el.current);
      // Follow night/light switches live.
      const mo = new MutationObserver(() => { t.options.theme = theme(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      t.focus();
      controls.set(name, m => { if ('restart' in m) t.reset(); ws.current?.send('\x00' + JSON.stringify(m)); });
      cleanup = () => { controls.delete(name); ro.disconnect(); mo.disconnect(); data.dispose(); ws.current?.close(); t.dispose(); };
    });
    return () => { closed = true; cleanup(); };
  }, [thread.id, name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) term.current?.focus(); }, [active]);
  // Padding lives on the wrapper, not .xterm: FitAddon sizes the grid to the element it's given, so padding inside it
  // pushed the last row out of view.
  return <div className="h-full px-4 pt-3 pb-2 pointer-coarse:px-3" onClick={() => term.current?.focus()}><div ref={el} className="h-full" /></div>;
}

const label = (id: string, project?: Project) =>
  id.startsWith('script:') ? id.slice(7) : `${(project && baseName(project.path)) || 'shell'}${id === 'shell' ? '' : ` ${id.split('-')[1]}`}`;

export function TerminalPanel({ thread, project }: { thread: Thread; project?: Project }) {
  const scripts = project?.scripts ?? [];
  const [tabs, setTabs] = useState(['shell']);
  const [active, setActive] = useState('shell');
  const [exit, setExit] = useState<Record<string, number | null>>({});
  const controls = useRef(new Map<string, (m: object) => void>()).current;
  const control = (m: object) => controls.get(active)?.(m);
  const open = (id: string) => { setTabs(t => t.includes(id) ? t : [...t, id]); setActive(id); };
  const closeTab = (id: string) => {
    controls.get(id)?.({ close: true }); // the tab's own PTY, not whichever is active
    setTabs(t => t.filter(x => x !== id));
    if (active === id) setActive('shell');
  };
  const isScript = active.startsWith('script:');
  // Shells get a quiet live dot; script tabs show running (the waxing moon), passed, or failed with the exit code.
  const status = (id: string) => !id.startsWith('script:') ? <span className="size-1.5 rounded-full bg-sprout/80 flex-none" />
    : exit[id] == null ? <Moon thread="running" size={9} /> : exit[id] === 0 ? <Check size={11} className="text-sprout" /> : <X size={11} className="text-oxide" />;
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 h-11 px-2 flex-none overflow-x-auto [scrollbar-width:none]">
        <div className="flex items-center gap-0.5 p-0.5 rounded-xl bg-well/70 border border-line/60 flex-none">
          {tabs.map(id => (
            <span key={id} className={`group inline-flex items-center rounded-[9px] transition-colors ${active === id ? 'bg-ridge text-moon shadow-[inset_0_1px_0_var(--surface-hi,transparent)]' : 'text-dust hover:text-moon'}`}>
              <button onClick={() => setActive(id)} data-tip={id.startsWith('script:') ? scripts.find(s => `script:${s.name}` === id)?.command : project?.path}
                className="press inline-flex items-center gap-2 h-7 pl-2.5 pr-2 text-[12px] font-mono whitespace-nowrap">
                {status(id)}{label(id, project)}{id.startsWith('script:') && exit[id] != null && exit[id] !== 0 && <span className="text-oxide/80">{exit[id]}</span>}
              </button>
              {id !== 'shell' && <button onClick={() => closeTab(id)} aria-label={`Close ${label(id, project)}`} data-tip="Close"
                className="press -ml-1 mr-1 size-5 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-crater opacity-0 group-hover:opacity-100 pointer-coarse:opacity-70"><X size={11} /></button>}
            </span>
          ))}
        </div>
        <IconButton label="New shell" onClick={() => open(`shell-${Math.max(1, ...tabs.filter(t => t.startsWith('shell-')).map(t => +t.split('-')[1])) + 1}`)}><Plus size={14} /></IconButton>
        <span className="flex-1" />
        {scripts.map(s => (
          <button key={s.name} onClick={() => open(`script:${s.name}`)} data-tip={`Run ${s.command}`}
            className="press inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-mono text-dust hover:text-moon hover:bg-ridge whitespace-nowrap flex-none"><Play size={10} className="text-sprout" />{s.name}</button>
        ))}
        {isScript && <>
          <IconButton label="Restart" onClick={() => control({ restart: true })}><RotateCcw size={13} /></IconButton>
          {exit[active] == null && <IconButton label="Stop" onClick={() => control({ kill: true })}><Square size={12} /></IconButton>}
        </>}
      </div>
      <div className="flex-1 min-h-0 mx-2 mb-2 rounded-xl bg-well/60 border border-line/50 overflow-hidden shadow-[inset_0_1px_0_var(--surface-hi,transparent)]">
        {tabs.map(id => <div key={id} className={id === active ? 'h-full' : 'hidden'}><Term thread={thread} name={id} active={id === active} controls={controls} onExit={c => setExit(e => ({ ...e, [id]: c }))} /></div>)}
      </div>
    </div>
  );
}
