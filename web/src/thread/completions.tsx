// Completion popup shared by Home's first-message box and the thread composer:
// ;snippet, /command or skill (works before a session exists), @path (needs a session).
import { useEffect, useState, type RefObject } from 'react';
import { useRpc } from '../rpc';
import type { CompletionItem } from '../hermes/contract';
import { useStore } from '../store';

export function useCompletions(text: string, setText: (v: string) => void, ta: RefObject<HTMLTextAreaElement | null>, sid?: string) {
  const rpc = useRpc();
  const snippets = useStore(s => s.settings?.snippets);
  const [items, setItems] = useState<CompletionItem[]>([]);
  const [sel, setSel] = useState(0);
  const [replaceFrom, setReplaceFrom] = useState(0);

  useEffect(() => {
    const caret = ta.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    // ;name inserts a saved prompt (Settings → General → Snippets).
    const snip = /(^|\s)(;[\w-]*)$/.exec(before)?.[2];
    if (snip) {
      const n = snip.slice(1).toLowerCase();
      setItems((snippets ?? []).filter(x => x.name.toLowerCase().includes(n)).slice(0, 12).map(x => ({ text: x.text, display: `;${x.name}`, meta: x.text.split('\n')[0].slice(0, 60) })));
      setReplaceFrom(caret - snip.length); setSel(0);
      return;
    }
    const word = sid ? /(^|\s)(@\S*)$/.exec(before)?.[2] : undefined;
    const slash = /^\/\S*(\s\S*)?$/.test(before) && !before.includes('\n');
    if (!word && !slash) { setItems([]); return; }
    const h = setTimeout(async () => {
      try {
        if (slash) {
          const r = await rpc.call('complete.slash', { text: before, session_id: sid });
          setItems((r.items ?? []).slice(0, 12)); setReplaceFrom(r.replace_from ?? 0);
        } else if (word) {
          const r = await rpc.call('complete.path', { word, session_id: sid });
          setItems((r.items ?? []).slice(0, 12)); setReplaceFrom(caret - word.length);
        }
        setSel(0);
      } catch { setItems([]); }
    }, 100);
    return () => clearTimeout(h);
  }, [text, sid, snippets]);

  const accept = (it: CompletionItem) => {
    const caret = ta.current?.selectionStart ?? text.length;
    const next = text.slice(0, replaceFrom) + it.text + text.slice(caret);
    setText(next.endsWith('/') ? next : next + (it.text.endsWith('/') ? '' : ' '));
    setItems([]);
    ta.current?.focus();
  };

  // Returns true when the key belonged to the popup.
  const onKey = (e: React.KeyboardEvent) => {
    if (!items.length) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => (s + 1) % items.length); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => (s - 1 + items.length) % items.length); return true; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) { e.preventDefault(); accept(items[sel]); return true; }
    if (e.key === 'Escape') { setItems([]); return true; }
    return false;
  };

  const list = (className = 'bottom-full mb-2 [--origin:bottom]') => items.length > 0 && (
    <ul role="listbox" className={`pop absolute left-0 right-0 max-h-72 overflow-y-auto rounded-xl p-1 z-20 ${className}`}>
      {items.map((it, i) => (
        <li key={it.text + i} role="option" aria-selected={i === sel}>
          <button onMouseDown={e => { e.preventDefault(); accept(it); }} onMouseEnter={() => setSel(i)}
            className={`w-full flex gap-3 px-2.5 py-1.5 rounded-lg text-left text-[13px] transition-colors duration-100 ${i === sel ? 'bg-ridge' : ''}`}>
            <span className="font-mono text-moon flex-none">{it.display || it.text}</span>
            {/* Hermes tags skill commands with a ⚡ prefix meant for its terminal UI. */}
            {it.meta && <span className="text-dust truncate">{it.meta.replace(/^⚡\s*/, '')}</span>}
          </button>
        </li>
      ))}
    </ul>
  );

  return { open: items.length > 0, onKey, list, clear: () => setItems([]) };
}
