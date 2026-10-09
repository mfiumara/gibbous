import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ChevronRight, FileText, FilePen, Terminal, Search, Globe, Bot, Wrench, Brain, ListTodo, Pencil, Image, Code2, Copy, Check, History, Paperclip, Volume2, Download } from 'lucide-react';
import { canSpeak, speak } from '../voice';
import { parseUserText, type Item } from './timeline';
import { DiffView } from '../panels/DiffView';
import { Moon } from '../ui';

// Local file paths (attachments, generated images) load through the authenticated image route.
export const imageSrc = (src: string) => /^(https?:|data:|blob:)/.test(src) ? src : `/api/image?path=${encodeURIComponent(src.replace(/^file:\/\//, ''))}`;

function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button aria-label="Copy" data-tip={done ? 'Copied' : 'Copy'} onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); }}
      className={`press size-7 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-ridge ${className}`}>
      {done ? <Check size={13} className="text-sprout animate-pop" /> : <Copy size={13} />}
    </button>
  );
}

const nodeText = (n: any): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(nodeText).join('') : n?.props ? nodeText(n.props.children) : '';

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="prose-moon"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
    components={{
      a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
      img: ({ node: _n, src, alt }) => <img src={imageSrc(String(src ?? ''))} alt={alt ?? ''} loading="lazy" />,
      pre: ({ node: _n, children, ...p }) => (
        <div className="group/code relative">
          <pre {...p}>{children}</pre>
          <CopyButton text={nodeText(children)} className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 focus:opacity-100 bg-well/95" />
        </div>
      ),
    }}>{text}</ReactMarkdown></div>;
});

// Files an agent hands you arrive as `MEDIA:/path` lines: shown as the thing itself, not as a path.
const mediaUrl = (p: string, download = false) => `/api/media?path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`;
export function MediaCard({ path: p }: { path: string }) {
  const name = p.split('/').pop() ?? p, ext = name.split('.').pop()?.toLowerCase() ?? '';
  const download = <a href={mediaUrl(p, true)} download={name} aria-label={`Download ${name}`} data-tip="Download" className="press size-8 grid place-items-center rounded-lg text-dust hover:text-moon hover:bg-ridge flex-none"><Download size={15} /></a>;
  if (/^(png|jpe?g|gif|webp)$/.test(ext)) return <a href={mediaUrl(p)} target="_blank" rel="noreferrer" className="block w-fit"><img src={mediaUrl(p)} alt={name} loading="lazy" className="max-h-80 rounded-xl border border-line object-contain" /></a>;
  if (/^(mp4|mov|m4v|webm)$/.test(ext)) return <div className="space-y-1"><video src={mediaUrl(p)} controls playsInline preload="metadata" className="max-h-96 w-full max-w-xl rounded-xl border border-line bg-well" /><p className="flex items-center gap-1 text-[12px] text-ash font-mono"><span className="truncate">{name}</span>{download}</p></div>;
  if (/^(mp3|m4a|wav|ogg)$/.test(ext)) return <div className="flex items-center gap-2"><audio src={mediaUrl(p)} controls className="w-full max-w-md" />{download}</div>;
  return (
    <div className="flex items-center gap-3 w-fit max-w-full tile rounded-xl pl-3 pr-1 py-1.5">
      <FileText size={16} className="text-dust flex-none" />
      <a href={mediaUrl(p)} target="_blank" rel="noreferrer" className="min-w-0 hover:underline"><span className="block truncate text-[13.5px] text-moon">{name}</span><span className="block truncate text-[11.5px] text-ash font-mono">{p.replace(/^\/Users\/[^/]+/, '~')}</span></a>
      {download}
    </div>
  );
}
const splitMedia = (text: string) => {
  const media: string[] = [];
  const rest = text.replace(/^[ \t]*MEDIA:[ \t]*(\S.*?)[ \t]*$/gm, (_, p) => { media.push(p.replace(/^["'`]|["'`]$/g, '')); return ''; }).replace(/\n{3,}/g, '\n\n').trim();
  return { media, rest };
};

export function AssistantMessage({ item }: { item: Extract<Item, { kind: 'assistant' }> }) {
  const { media, rest } = item.streaming ? { media: [], rest: item.text } : splitMedia(item.text);
  return (
    <div className={`group/msg relative ${item.streaming ? 'caret' : ''}`}>
      <Markdown text={rest} />
      {media.length > 0 && <div className="mt-3 space-y-2">{media.map(m => <MediaCard key={m} path={m} />)}</div>}
      {!item.streaming && <div className="absolute -bottom-1 -left-1 translate-y-full flex opacity-0 group-hover/msg:opacity-100 transition-opacity z-10"><CopyButton text={item.text} />
        {canSpeak && <button aria-label="Read aloud" data-tip="Read aloud" onClick={() => speak(item.text)} className="press size-7 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-ridge"><Volume2 size={13} /></button>}</div>}
    </div>
  );
}

const toolIcon = (name: string) => {
  if (/terminal|shell|process|exec/.test(name)) return Terminal;
  if (/write|patch|edit/.test(name)) return FilePen;
  if (/read_file|file/.test(name)) return FileText;
  if (/search/.test(name)) return Search;
  if (/web|browser/.test(name)) return Globe;
  if (/delegate|agent/.test(name)) return Bot;
  if (/todo/.test(name)) return ListTodo;
  if (/image|vision/.test(name)) return Image;
  if (/code/.test(name)) return Code2;
  return Wrench;
};

function fmtResult(r: unknown): string {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  const o = r as Record<string, unknown>;
  if (typeof o.output === 'string') return o.output + (o.error ? `\n${o.error}` : '');
  if (typeof o.content === 'string') return o.content;
  return JSON.stringify(r, null, 2);
}

// Generated or captured images in a tool result (image_generate, screenshots, vision).
function resultImages(r: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') { for (const m of v.matchAll(/(?:^|[\s"'(])((?:\/|https?:\/\/)[^\s"')]+\.(?:png|jpe?g|webp|gif))/gi)) found.add(m[1]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(r);
  return [...found].slice(0, 6);
}

export function ToolRow({ item, cwd }: { item: Extract<Item, { kind: 'tool' }>; cwd?: string }) {
  const [open, setOpen] = useState(false);
  // Hermes' lazy-loading `tool_call` wraps the real calls: show what it actually ran.
  const inner = item.name === 'tool_call' && Array.isArray(item.args?.calls) ? item.args.calls as { name?: string; arguments?: Record<string, unknown> }[] : undefined;
  // MCP tools arrive as mcp__<server>__<tool> (also inside tool_call): show the tool, badge the server.
  const raw = inner ? inner.map(c => c.name ?? '?') : [item.name];
  const mcp = raw.map(n => /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(n)).find(Boolean);
  const name = raw.map(n => n.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')).join(', ');
  const args = inner?.length === 1 ? inner[0].arguments : item.args;
  const Icon = toolIcon(name);
  const cmd = typeof args?.command === 'string' ? args.command : undefined;
  const result = fmtResult(item.result) || item.resultText || '';
  const rel = (s: string) => cwd ? s.split(cwd + '/').join('').split(cwd).join('.') : s;
  const path = typeof args?.path === 'string' ? args.path : undefined;
  const detail = rel(cmd ?? path ?? item.context ?? '');
  const images = item.status === 'done' && /image|screenshot|vision|browser|computer/.test(name) ? resultImages(item.result) : [];
  return (
    <div className="group">
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="press w-[calc(100%+0.75rem)] flex items-center gap-2 py-1 px-1.5 -mx-1.5 text-left text-[13px] text-dust hover:text-moon hover:bg-crater/70 rounded-md">
        <ChevronRight size={13} className={`flex-none text-ash transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        <Icon size={14} className={`flex-none ${item.status === 'running' ? 'text-tide animate-pulse' : item.status === 'error' ? 'text-oxide' : ''}`} />
        <span className="font-mono text-moon/90 flex-none">{name}</span>
        {mcp && <span className="label text-[9px] text-ash flex-none">{mcp[1]}</span>}
        <span className="font-mono truncate min-w-0 text-ash group-hover:text-dust transition-colors">{detail}</span>
        {item.status === 'running' && <span className="ml-auto pl-2 flex-none flex items-center"><Moon thread="running" size={9} /></span>}
        {item.duration != null && <span className="ml-auto pl-2 font-mono text-[11px] text-ash flex-none">{item.duration < 1 ? `${Math.round(item.duration * 1000)}ms` : `${item.duration.toFixed(1)}s`}</span>}
      </button>
      {!open && item.diff && <div className="ml-6 my-1 animate-fade"><DiffView diff={item.diff} compact /></div>}
      {images.length > 0 && <div className="ml-6 my-1.5 flex flex-wrap gap-2">{images.map(src => <a key={src} href={imageSrc(src)} target="_blank" rel="noreferrer"><img src={imageSrc(src)} alt="" loading="lazy" className="h-40 rounded-lg border border-line object-cover hover:border-ash transition-colors" /></a>)}</div>}
      {open && (
        <div className="ml-6 my-1.5 space-y-2 animate-rise">
          {item.diff && <DiffView diff={item.diff} />}
          {args && !cmd && <pre className="font-mono text-[12px] bg-well border border-line rounded-lg p-2.5 overflow-x-auto max-h-64 text-dust">{JSON.stringify(args, null, 2)}</pre>}
          {cmd && <div className="group/code relative"><pre className="font-mono text-[12px] bg-well border border-line rounded-lg p-2.5 overflow-x-auto text-moon"><span className="text-ash select-none">$ </span>{cmd}</pre><CopyButton text={cmd} className="absolute top-1 right-1 opacity-0 group-hover/code:opacity-100" /></div>}
          {result && <pre className="font-mono text-[12px] bg-well border border-line rounded-lg p-2.5 overflow-auto max-h-80 text-dust whitespace-pre-wrap">{result.slice(0, 20000)}</pre>}
          {item.summary && <p className="text-xs text-dust">{item.summary}</p>}
        </div>
      )}
    </div>
  );
}

export function ReasoningBlock({ item }: { item: Extract<Item, { kind: 'reasoning' }> }) {
  const [open, setOpen] = useState(false);
  const first = item.text.trim().split('\n')[0];
  return (
    <div>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="press flex items-center gap-2 py-1 text-[13px] text-ash hover:text-dust max-w-full rounded-md">
        <Brain size={14} className={`flex-none ${item.streaming ? 'text-tide animate-pulse' : ''}`} />
        <span className="italic truncate">{open ? 'Reasoning' : first || 'Reasoning'}</span>
      </button>
      {open && <div className="ml-6 text-[13px] text-dust italic whitespace-pre-wrap border-l border-line pl-3 animate-rise">{item.text}</div>}
    </div>
  );
}

export function SideCard({ item }: { item: Extract<Item, { kind: 'side' }> }) {
  return (
    <div className="rounded-xl border border-tide/25 bg-tide/[0.04] p-3.5 space-y-1.5">
      <p className="label text-tide">{item.mode === 'btw' ? 'Side question' : 'Background task'}{item.text == null ? ' · working…' : ''}</p>
      <p className="text-[13px] text-dust">{item.question}</p>
      {item.text != null ? <div className="text-sm"><Markdown text={item.text} /></div> : <div className="space-y-1.5 pt-1"><div className="skeleton h-3 w-3/4" /><div className="skeleton h-3 w-1/2" /></div>}
    </div>
  );
}

// User text with attachments: `@image:/path` lines become thumbnails, `@file:` references become chips.
function UserBody({ text }: { text: string }) {
  const { images, files, body } = parseUserText(text);
  return <>
    {images.length > 0 && <div className="flex flex-wrap justify-end gap-1.5 mb-1.5">{images.map(src => <a key={src} href={imageSrc(src)} target="_blank" rel="noreferrer"><img src={imageSrc(src)} alt="Attached image" loading="lazy" className="h-28 rounded-xl border border-line object-cover" /></a>)}</div>}
    {body && <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</div>}
    {files.length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{files.map(f => <span key={f} className="inline-flex items-center gap-1 rounded-md bg-basalt/50 px-1.5 py-0.5 font-mono text-[11.5px] text-dust"><Paperclip size={11} />{f.split('/').pop()}</span>)}</div>}
  </>;
}

export function UserMessage({ item, onEdit, onRevert }: { item: Extract<Item, { kind: 'user' }>; onEdit?: () => void; onRevert?: () => void }) {
  const action = (label: string, icon: ReactNode, fn: () => void) => (
    <button onClick={fn} aria-label={label} data-tip={label} className="press size-7 grid place-items-center rounded-md text-ash hover:text-moon hover:bg-ridge">{icon}</button>
  );
  return (
    <div className="group flex justify-end gap-1 items-start">
      <div className="mt-1 flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {onRevert && action('Revert files to before this turn', <History size={13} />, onRevert)}
        {onEdit && action('Edit and rerun from here', <Pencil size={13} />, onEdit)}
      </div>
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ridge px-3.5 py-2 shadow-[inset_0_1px_0_var(--surface-hi)]"><UserBody text={item.text} /></div>
    </div>
  );
}
