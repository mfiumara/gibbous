// Unified diff renderer: splits by file, numbers lines, colours +/-. Optionally lets you comment on lines.
import { Fragment, useMemo, useState } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';
import { parseDiff } from './diff';

export interface LineComment { id: string; file: string; line: number; code: string; text: string }

// Big files (lockfiles, generated code) render their first CAP lines until asked: thousands of table rows made the
// panel scroll and typing a comment stutter.
const CAP = 600;

const rowCls = { '+': 'bg-sprout/10 text-moon', '-': 'bg-oxide/10 text-moon', ' ': 'text-dust', '@': 'text-tide/70 bg-tide/5' };

export function DiffView({ diff, compact, comments, onComment, onRemoveComment }: {
  diff: string; compact?: boolean; comments?: LineComment[]; onComment?(c: Omit<LineComment, 'id'>): void; onRemoveComment?(id: string): void;
}) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [full, setFull] = useState<Set<string>>(new Set());
  if (!files.length) return <p className="text-sm text-ash">No changes.</p>;
  return (
    <div className="space-y-2">
      {files.map((f, i) => {
        const lines = compact ? f.lines.filter(l => l.t !== '@').slice(0, 10) : full.has(f.name) ? f.lines : f.lines.slice(0, CAP);
        const add = f.lines.filter(l => l.t === '+').length, del = f.lines.filter(l => l.t === '-').length;
        return (
          <div key={i} className="rounded-lg border border-line overflow-hidden bg-well">
            {f.name && <div className="flex items-center gap-2 px-2.5 py-1 border-b border-line font-mono text-[11.5px] text-dust">
              <span className="truncate">{f.name}</span>
              <span className="ml-auto text-sprout">+{add}</span><span className="text-oxide">−{del}</span>
            </div>}
            <div className="overflow-x-auto">
              <table className="font-mono text-[12px] leading-[1.6] w-full border-collapse">
                <tbody>
                  {lines.map((l, j) => {
                    const key = `${f.name}:${j}`;
                    const lineNo = l.b ?? l.a ?? 0;
                    const here = comments?.filter(c => c.file === f.name && c.line === lineNo && l.t !== '@') ?? [];
                    return (
                      <Fragment key={j}>
                        <tr className={`group/l ${rowCls[l.t]}`} onClick={onComment && l.t !== '@' && editing !== key && matchMedia('(pointer: coarse)').matches ? () => { setEditing(key); setDraft(''); } : undefined}>
                          {!compact && <td className="relative select-none text-right pr-2 pl-2 text-ash/70 w-10 align-top">
                            {onComment && l.t !== '@' && <button onClick={() => { setEditing(key); setDraft(''); }} aria-label={`Comment on line ${lineNo}`}
                              className="absolute left-0.5 top-0.5 size-4 grid place-items-center rounded bg-tide text-basalt opacity-0 group-hover/l:opacity-100 focus:opacity-100 transition-opacity pointer-coarse:hidden"><MessageSquarePlus size={10} /></button>}
                            {l.t === '@' ? '' : l.a ?? ''}
                          </td>}
                          {!compact && <td className="select-none text-right pr-2 text-ash/70 w-10 align-top">{l.t === '@' ? '' : l.b ?? ''}</td>}
                          <td className="select-none w-4 pl-1.5 text-ash align-top">{l.t === '@' || l.t === ' ' ? '' : l.t}</td>
                          <td className="whitespace-pre pr-3">{l.text || ' '}</td>
                        </tr>
                        {here.map(c => (
                          <tr key={c.id}><td colSpan={4} className="px-3 py-1.5 bg-tide/[0.06] border-y border-tide/20">
                            <div className="flex gap-2 font-sans text-[12.5px] text-moon"><MessageSquarePlus size={12} className="text-tide mt-0.5 flex-none" /><span className="flex-1 whitespace-pre-wrap">{c.text}</span>
                              <button onClick={() => onRemoveComment?.(c.id)} aria-label="Remove comment" className="text-ash hover:text-moon"><X size={12} /></button></div>
                          </td></tr>
                        ))}
                        {editing === key && (
                          <tr><td colSpan={4} className="p-2 bg-crater border-y border-line">
                            <form className="flex flex-col gap-1.5 font-sans" onSubmit={e => { e.preventDefault(); if (draft.trim()) { onComment!({ file: f.name, line: lineNo, code: l.text, text: draft.trim() }); setEditing(null); } }}>
                              <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} rows={2} placeholder="What should change here?"
                                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); if (e.key === 'Escape') setEditing(null); }}
                                className="w-full rounded-md bg-basalt border border-line px-2.5 py-1.5 text-[13px] focus:outline-none focus:border-tide/60 resize-none" />
                              <div className="flex justify-end gap-1.5">
                                <button type="button" onClick={() => setEditing(null)} className="press h-7 px-2.5 rounded-md text-[12.5px] text-dust hover:text-moon">Cancel</button>
                                <button className="press h-7 px-2.5 rounded-md text-[12.5px] bg-moon text-basalt font-medium">Add comment</button>
                              </div>
                            </form>
                          </td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!compact && f.lines.length > lines.length && <button onClick={() => setFull(s => new Set(s).add(f.name))} className="press w-full px-2.5 py-1 text-left text-[11.5px] text-tide hover:bg-ridge/50 border-t border-line">Show the other {f.lines.length - lines.length} lines</button>}
            {compact && f.lines.length > lines.length && <div className="px-2.5 py-0.5 text-[11px] text-ash border-t border-line">… {f.lines.length - lines.length} more lines</div>}
          </div>
        );
      })}
    </div>
  );
}
