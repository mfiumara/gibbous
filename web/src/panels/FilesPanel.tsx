import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, AtSign, Pencil, Save, X, SquareArrowOutUpRight } from 'lucide-react';
import { api, type Thread } from '../api';
import { toastError, useStore } from '../store';
import { IconButton, Button, inputCls } from '../ui';
import { Markdown } from '../thread/Items';
import { baseName, dirPrefix } from '../paths';

const LANG: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', py: 'python', rs: 'rust', go: 'go', md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', sh: 'bash', zsh: 'bash', css: 'css', html: 'xml', c: 'c', h: 'c', cpp: 'cpp', toml: 'ini', sql: 'sql', swift: 'swift', kt: 'kotlin', java: 'java', rb: 'ruby' };

// Desktop editors' URL schemes; the choice is remembered per device.
export const EDITORS: Record<string, (p: string) => string> = {
  'VS Code': p => `vscode://file${p}`, Cursor: p => `cursor://file${p}`, Zed: p => `zed://file${p}`, Windsurf: p => `windsurf://file${p}`,
};
// Inside Gibbous.app a location change to vscode:// failed as a navigation and the app reloaded itself; window.open
// goes through the app's new-window hook, which hands any URL to macOS.
export const openInEditor = (absPath: string) => { const u = editorUrl(absPath); if ((window as any).webkit?.messageHandlers?.gibbousNotify) window.open(u); else location.href = u; };
export const editorUrl = (absPath: string) => (EDITORS[localStorage.getItem('gibbous.editor') ?? 'VS Code'] ?? EDITORS['VS Code'])(absPath);

export function FilesPanel({ thread, onMention }: { thread: Thread; onMention(path: string): void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<{ path: string; abs?: string; content?: string; tooLarge?: boolean } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const toast = useStore(s => s.toast);

  useEffect(() => { api.get<{ files: string[] }>(`/api/threads/${thread.id}/files`).then(r => setFiles(r.files)).catch(toastError); }, [thread.id]);
  const shown = useMemo(() => {
    const needle = q.toLowerCase();
    return (needle ? files.filter(f => f.toLowerCase().includes(needle)) : files).slice(0, 500);
  }, [files, q]);

  const view = (path: string) => api.get<{ path: string; content?: string; tooLarge?: boolean }>(`/api/threads/${thread.id}/file?path=${encodeURIComponent(path)}`)
    .then(r => { setOpen({ path, abs: r.path, content: r.content, tooLarge: r.tooLarge }); setEditing(null); }).catch(toastError);
  const save = async () => {
    if (!open || editing == null) return;
    try { await api.post(`/api/threads/${thread.id}/file`, { path: open.path, content: editing }); setOpen({ ...open, content: editing }); setEditing(null); toast({ title: `Saved ${open.path.split('/').pop()}` }); }
    catch (e) { toastError(e); }
  };

  if (open) {
    const ext = open.path.split('.').pop() ?? '';
    const body = open.tooLarge ? '_File is too large to preview._' : ext === 'md' ? open.content ?? '' : '```' + (LANG[ext] ?? '') + '\n' + (open.content ?? '') + '\n```';
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line">
          <IconButton label="Back to files" onClick={() => setOpen(null)}><ArrowLeft size={15} /></IconButton>
          <span className="font-mono text-[12px] truncate flex-1">{open.path}</span>
          {editing == null ? <>
            {!open.tooLarge && <IconButton label="Edit" onClick={() => setEditing(open.content ?? '')}><Pencil size={14} /></IconButton>}
            {open.abs && <IconButton label={`Open in ${localStorage.getItem('gibbous.editor') ?? 'VS Code'}`} onClick={() => openInEditor(open.abs!)}><SquareArrowOutUpRight size={14} /></IconButton>}
            <IconButton label="Mention in message" onClick={() => onMention(open.path)}><AtSign size={14} /></IconButton>
          </> : <>
            <Button size="sm" onClick={() => setEditing(null)}><X size={12} />Cancel</Button>
            <Button size="sm" tone="primary" onClick={save}><Save size={12} />Save</Button>
          </>}
        </div>
        {editing != null
          ? <textarea value={editing} onChange={e => setEditing(e.target.value)} spellCheck={false} aria-label={`Edit ${open.path}`}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } }}
              className="flex-1 min-h-0 resize-none bg-well p-3 font-mono text-[12.5px] leading-relaxed focus:outline-none" />
          : <div className="flex-1 min-h-0 overflow-auto p-3 text-[13px]"><Markdown text={body} /></div>}
      </div>
    );
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2.5 border-b border-line"><input className={inputCls} placeholder={`Filter ${files.length} files`} value={q} onChange={e => setQ(e.target.value)} /></div>
      <ul className="flex-1 min-h-0 overflow-y-auto p-1">
        {shown.map(f => (
          <li key={f}><button onClick={() => view(f)} className="press w-full text-left px-2.5 py-0.5 pointer-coarse:py-2 rounded-md font-mono text-[12.5px] text-dust hover:text-moon hover:bg-ridge/60 truncate">
            <span className="text-ash">{dirPrefix(f)}</span>{baseName(f)}
          </button></li>
        ))}
        {files.length > shown.length && !q && <li className="px-3 py-2 text-xs text-ash">Showing 500 of {files.length}. Filter to find more.</li>}
      </ul>
    </div>
  );
}
