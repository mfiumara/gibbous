// Shared pieces of the Sessions screen (Sessions.tsx) and the import picker (Welcome.tsx): tool icons, the tool intro,
// app chips, and folder groups whose rows either tick (pick) or open (open).
import { useState } from 'react';
import { Folder, MessageCircle, ChevronDown, SquareTerminal, Monitor, CodeXml, MessagesSquare, Webhook, Asterisk, Hexagon, Box, CircleDashed } from 'lucide-react';
import { Logo, Switch, Check, CheckRow, ago, sourceLabel } from './ui';
import { setSync } from './importer';
import { triState, toggleAll, whenLabel, type Candidate, type Group } from './importSessions';
import { TOOLS, toolInfo, countLabel, type ToolId, type Chip } from './sessionTools';

const ICONS: Record<ToolId, React.ComponentType<{ size?: number; className?: string }>> = {
  gibbous: Logo, cli: SquareTerminal, desktop: Monitor, acp: CodeXml, messaging: MessagesSquare, api: Webhook, other: CircleDashed, claude: Asterisk, codex: Hexagon, opencode: Box,
};
export function ToolIcon({ id, size = 15, className = '' }: { id: ToolId; size?: number; className?: string }) {
  const I = ICONS[id];
  return <span className={`inline-grid place-items-center flex-none ${className}`}><I size={size} /></span>;
}

// Icon, name, count, then the one line saying what opening/importing does for this tool.
export function ToolIntro({ id, n, more, children }: { id: ToolId; n?: number; more?: boolean; children?: React.ReactNode }) {
  const t = toolInfo(id)!;
  return (
    <div className="space-y-1">
      <h2 className="flex items-center gap-2 font-bold text-[15px]"><ToolIcon id={id} className="text-dust" />{t.label}{n != null && <span className="text-[12.5px] font-normal text-ash tabular-nums">{countLabel(n, more)}</span>}</h2>
      <p className="text-[12.5px] text-dust">{t.blurb}</p>
      {children}
    </div>
  );
}

// Sub-app filter within a tool (Discord / Telegram, Codex app / CLI / T3 Code…). `value` '' = all.
export function AppChips({ chips, value, onChange }: { chips: Chip[]; value: string; onChange(v: string): void }) {
  if (chips.length < 2 && !value) return null;
  const total = chips.reduce((a, c) => a + c.n, 0);
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="App">
      {[{ key: '', label: 'All', n: total, raw: [] as string[] }, ...chips].map(c => (
        <button key={c.key} role="radio" aria-checked={value === c.key} onClick={() => onChange(c.key)} data-tip={c.raw.length ? c.raw.join(', ') : undefined}
          className={`press h-7 pointer-coarse:h-9 px-2.5 rounded-md border text-[12.5px] ${value === c.key ? 'border-tide bg-tide/10 text-moon' : 'border-line text-dust hover:text-moon'}`}>
          {c.label} <span className="text-ash tabular-nums">{c.n}</span>
        </button>
      ))}
    </div>
  );
}

const meta = (c: Candidate, withApp: boolean) => [withApp && c.app?.label, c.kind !== 'hermes' && c.cwd?.replace(/^\/Users\/[^/]+/, '~'), c.preview.replace(/\s+/g, ' ').slice(0, 140)].filter(Boolean).join(' · ');

function PickRow({ c, on, done, toggle, enter, withApp }: { c: Candidate; on: boolean; done: boolean; toggle(): void; enter(): void; withApp: boolean }) {
  return (
    <CheckRow checked={on || done} disabled={done} onToggle={toggle} onEnter={enter} label={c.title}>
      <Check state={on || done} />
      <span className="flex-1 min-w-0 py-1.5">
        <span className="block truncate text-[13.5px]">{c.title}{done && <span className="label ml-2 text-tide">in gibbous</span>}</span>
        <span className="block truncate text-[11.5px] text-ash">{meta(c, withApp)}</span>
      </span>
      {c.at > 0 && <span className="text-[11.5px] text-ash tabular-nums flex-none" data-tip={whenLabel(c.at)}>{ago(c.at)}</span>}
    </CheckRow>
  );
}

function OpenRow({ c, done, open, withApp }: { c: Candidate; done: boolean; open(): void; withApp: boolean }) {
  const count = c.messages ? `${c.messages} ${c.kind === 'hermes' ? 'msgs' : 'turns'}` : '';
  return (
    <button data-vim-item onClick={open} className="press w-full text-left flex items-center gap-3 rounded-lg px-2 min-h-11 py-1.5 hover:bg-ridge/50 outline-none focus-visible:bg-ridge focus-visible:shadow-[inset_0_0_0_1px_var(--color-tide)]">
      <span className="flex-1 min-w-0">
        <span className="block truncate text-[13.5px]">{c.title}{done && c.tool !== 'gibbous' && <span className="label ml-2 text-tide">in gibbous</span>}</span>
        <span className="block truncate text-[11.5px] text-ash">{meta(c, withApp)}</span>
      </span>
      <span className="text-[11.5px] text-ash tabular-nums flex-none text-right" data-tip={c.at ? whenLabel(c.at) : undefined}>{[count, c.at ? ago(c.at) : ''].filter(Boolean).join(' · ')}</span>
    </button>
  );
}

// One folder (or source) group. `pick`: a tri-state group checkbox and ticking rows; `open`: plain rows that open.
export function GroupBlock({ g, mode, sel, setSel, done, project, setProject, existing, forceOpen, enter, open, page = 6, withApp = false }: {
  g: Group; mode: 'pick' | 'open'; sel: Set<string>; setSel: React.Dispatch<React.SetStateAction<Set<string>>>; done(c: Candidate): boolean;
  project?: boolean; setProject?(v: boolean): void; existing?: string; forceOpen: boolean; enter(): void; open?(c: Candidate): void; page?: number; withApp?: boolean;
}) {
  const [more, setMore] = useState(false);
  const pickable = g.items.filter(c => !done(c));
  const state = pickable.length ? triState(pickable, sel) : 'all';
  const shown = more || forceOpen ? g.items : g.items.slice(0, page);
  const title = <>
    {g.folder ? <Folder size={14} className="text-dust flex-none" /> : <MessageCircle size={14} className="text-dust flex-none" />}
    <span className="min-w-0 flex items-baseline gap-2"><span className="font-bold text-[13.5px] truncate">{g.label}</span>{g.detail && g.detail !== g.label && <span className="hidden sm:block font-mono text-[11px] text-ash truncate">{g.detail}</span>}</span>
    <span className="text-[12px] text-ash tabular-nums flex-none">{g.items.length}</span>
  </>;
  return (
    <section className="space-y-0.5">
      <div className="flex items-center gap-2 pr-1">
        {mode === 'pick'
          ? <CheckRow checked={state} disabled={!pickable.length} onToggle={() => setSel(s => toggleAll(s, pickable))} onEnter={enter} label={`${g.label}: all ${g.items.length}`} className="flex-1 min-w-0"><Check state={state} />{title}</CheckRow>
          : <div className="flex-1 min-w-0 flex items-center gap-3 px-2 min-h-9">{title}</div>}
        {mode === 'pick' && g.canProject && setProject && <label className="flex items-center gap-2 text-[12.5px] text-dust flex-none select-none" data-tip={existing ? `Imported threads go into your ${existing} project` : project ? `Creates a project for ${g.detail} and files these threads under it` : 'Imported threads stay unfiled'}>
          <span className="hidden sm:inline">{existing ? 'In project' : 'Add as project'}</span><span className="sm:hidden">Project</span><Switch label={`Add ${g.label} as a project`} checked={!!project} onChange={setProject} />
        </label>}
      </div>
      <div className="pl-5 sm:pl-6">
        {shown.map(c => mode === 'pick'
          ? <PickRow key={c.key} c={c} on={sel.has(c.key)} done={done(c)} enter={enter} withApp={withApp} toggle={() => setSel(s => { const n = new Set(s); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n; })} />
          : <OpenRow key={c.key} c={c} done={done(c)} open={() => open?.(c)} withApp={withApp} />)}
        {!forceOpen && g.items.length > page && <button onClick={() => setMore(!more)} className="press flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-2 text-[12.5px] text-dust hover:text-moon rounded-lg">
          <ChevronDown size={13} className={more ? 'rotate-180' : ''} />{more ? 'Show fewer' : `Show all ${g.items.length}`}</button>}
      </div>
    </section>
  );
}

// "Keep in sidebar automatically": messaging gets one switch per app, other tools one switch for the whole tool.
export function SyncSwitches({ tool, sources, synced }: { tool: ToolId; sources: string[]; synced: Set<string> }) {
  const label = TOOLS.find(t => t.id === tool)!.label;
  const rows: [string, string[]][] = tool === 'messaging' ? sources.map(s => [sourceLabel(s), [s]]) : [[label, sources]];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
      <span className="text-[12.5px] text-dust">Keep in sidebar automatically</span>
      {rows.map(([name, srcs]) => {
        const on = srcs.every(s => synced.has(s));
        return <label key={name} className="flex items-center gap-2 text-[12.5px] select-none min-h-9" data-tip={on ? `New ${name} sessions appear in the sidebar on their own` : `Add every ${name} session to the sidebar, new ones too`}>
          {tool === 'messaging' && name}<Switch label={`Keep ${name} sessions in the sidebar`} checked={on} onChange={v => setSync(srcs, v, name)} />
        </label>;
      })}
    </div>
  );
}
