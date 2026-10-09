// ⌘F inside a thread. Matches are painted with the CSS Custom Highlight API: no DOM mutation, works with streaming text.
import { useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { IconButton } from '../ui';

const supported = typeof CSS !== 'undefined' && 'highlights' in CSS;

function findRanges(root: HTMLElement, q: string): Range[] {
  const needle = q.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && ranges.length < 2000; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase();
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + needle.length);
      ranges.push(r);
    }
  }
  return ranges;
}

export function FindBar({ root, onClose, version }: { root: React.RefObject<HTMLElement | null>; onClose(): void; version: unknown }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); return () => { if (supported) { CSS.highlights.delete('find'); CSS.highlights.delete('find-current'); } }; }, []);
  useEffect(() => {
    if (!root.current || q.length < 2) { setRanges([]); if (supported) CSS.highlights.delete('find'); return; }
    const r = findRanges(root.current, q);
    setRanges(r);
    setI(c => Math.min(c, Math.max(0, r.length - 1)));
    if (supported) CSS.highlights.set('find', new Highlight(...r));
  }, [q, root, version]);
  useEffect(() => {
    const cur = ranges[i];
    if (!cur) { if (supported) CSS.highlights.delete('find-current'); return; }
    if (supported) CSS.highlights.set('find-current', new Highlight(cur));
    (cur.startContainer.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [i, ranges]);
  const step = (d: number) => ranges.length && setI(c => (c + d + ranges.length) % ranges.length);
  return (
    <div className="pop absolute top-14 right-4 z-30 flex items-center gap-1 rounded-xl pl-3 pr-1 h-10 [--origin:top_right]">
      <input ref={input} value={q} onChange={e => { setQ(e.target.value); setI(0); }} placeholder="Find in thread" aria-label="Find in thread"
        onKeyDown={e => { if (e.key === 'Enter') step(e.shiftKey ? -1 : 1); if (e.key === 'Escape') onClose(); }}
        className="w-48 bg-transparent text-sm placeholder:text-ash focus:outline-none" />
      <span className="font-mono text-[11px] text-ash w-14 text-right">{q.length < 2 ? '' : ranges.length ? `${i + 1}/${ranges.length}` : 'none'}</span>
      <IconButton label="Previous match" onClick={() => step(-1)}><ChevronUp size={15} /></IconButton>
      <IconButton label="Next match" onClick={() => step(1)}><ChevronDown size={15} /></IconButton>
      <IconButton label="Close" onClick={onClose}><X size={14} /></IconButton>
    </div>
  );
}
