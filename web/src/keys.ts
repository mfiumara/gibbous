// Vim-style key sequences, pure: event → token, pending tokens + key → what to do, and the help rows.
// The DOM side (panes, focus, scrolling) lives in vim.ts.

// 'normal' = nothing open; 'overlay' = a menu or dialog is open and owns j/k.
export type Scope = 'normal' | 'overlay';
export type Group = 'Move around' | 'Go to' | 'Do';
export type Binding<C = void> = { keys: string; when?: Scope[]; group: Group; help: string; run: (ctx: C) => void };
export type Match<B> = { kind: 'run'; binding: B } | { kind: 'pending' } | { kind: 'none' };
export type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };

export const TIMEOUT = 1000;
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'Dead', 'Process', 'Unidentified']);

// 'j', 'G', '/', 'Escape', 'Enter', 'Space', 'C-d'. Null for bare modifiers and anything with ⌘ or Alt (those aren't ours).
export function token(e: KeyLike): string | null {
  if (e.metaKey || e.altKey || MODIFIERS.has(e.key)) return null;
  if (e.ctrlKey) return e.key.length === 1 ? `C-${e.key.toLowerCase()}` : null;
  return e.key === ' ' ? 'Space' : e.key;
}

// An exact match runs (even if it also starts a longer sequence; no binding relies on that). A prefix of some
// binding waits for the next key. Anything else is unknown, and the caller drops the pending keys.
export function match<B extends { keys: string; when?: Scope[] }>(pending: string[], key: string, bindings: B[], scope: Scope): Match<B> {
  const seq = [...pending, key].join(' ');
  const live = bindings.filter(b => (b.when ?? ['normal']).includes(scope));
  const exact = live.find(b => b.keys === seq);
  if (exact) return { kind: 'run', binding: exact };
  if (live.some(b => b.keys.startsWith(seq + ' '))) return { kind: 'pending' };
  return { kind: 'none' };
}

// What the keys can do; vim.ts implements these against the DOM.
export type Actions = {
  move(d: 1 | -1): void;           // j/k in the active pane (or menu)
  pane(d: 1 | -1): void;           // focus the pane to the left / right
  edge(end: 'top' | 'bottom'): void;
  half(d: 1 | -1): void;           // half a page
  thread(d: 1 | -1): void;         // next / previous sidebar thread from anywhere
  go(path: string): void;
  board(): void;
  history(d: 1 | -1): void;
  space(d: 1 | -1): void;
  composer(): void;
  find(): void;
  palette(): void;
  help(): void;
  remove(): void;                  // delete the focused or open thread (asks first)
};

const MOVE: Group = 'Move around', GO: Group = 'Go to', DO: Group = 'Do';
export const BINDINGS: Binding<Actions>[] = [
  { keys: 'j', group: MOVE, help: 'Next thread, section or control, or scroll down a little', run: a => a.move(1) },
  { keys: 'k', group: MOVE, help: 'Previous thread, section or control, or scroll up a little (k past the first thread goes home)', run: a => a.move(-1) },
  ...['h', 'C-w h', 'C-h'].map(keys => ({ keys, group: MOVE, help: 'Move to the pane on the left', run: (a: Actions) => a.pane(-1) })),
  ...['l', 'C-w l', 'C-l'].map(keys => ({ keys, group: MOVE, help: 'Move to the pane on the right', run: (a: Actions) => a.pane(1) })),
  { keys: 'g g', group: MOVE, help: 'Jump to the top of the pane', run: a => a.edge('top') },
  { keys: 'G', group: MOVE, help: 'Jump to the bottom of the pane (in a thread, follow new output again)', run: a => a.edge('bottom') },
  { keys: 'C-d', group: MOVE, help: 'Scroll down half a page', run: a => a.half(1) },
  { keys: 'C-u', group: MOVE, help: 'Scroll up half a page', run: a => a.half(-1) },
  { keys: 'g t', group: MOVE, help: 'Open the next thread from anywhere', run: a => a.thread(1) },
  { keys: 'g T', group: MOVE, help: 'Open the previous thread from anywhere', run: a => a.thread(-1) },
  { keys: '[', group: GO, help: 'Previous project space', run: a => a.space(-1) },
  { keys: ']', group: GO, help: 'Next project space', run: a => a.space(1) },
  { keys: 'H', group: MOVE, help: 'Go back', run: a => a.history(-1) },
  { keys: 'L', group: MOVE, help: 'Go forward', run: a => a.history(1) },
  ...['j', 'C-n'].map(keys => ({ keys, when: ['overlay'] as Scope[], group: MOVE, help: 'In an open menu, next item', run: (a: Actions) => a.move(1) })),
  ...['k', 'C-p'].map(keys => ({ keys, when: ['overlay'] as Scope[], group: MOVE, help: 'In an open menu, previous item', run: (a: Actions) => a.move(-1) })),
  { keys: 'g h', group: GO, help: 'Home', run: a => a.go('/') },
  { keys: 'g i', group: GO, help: 'Inbox', run: a => a.go('/inbox') },
  { keys: 'g b', group: GO, help: 'Board of this thread\'s project (or the first project)', run: a => a.board() },
  { keys: 'g r', group: GO, help: 'Rooms', run: a => a.go('/rooms') },
  { keys: 'g a', group: GO, help: 'Automations', run: a => a.go('/automations') },
  { keys: 'g H', group: GO, help: 'Hermes history', run: a => a.go('/sessions') },
  { keys: 'g s', group: GO, help: 'Settings', run: a => a.go('/settings') },
  ...['Enter', 'i', 'a', 'o'].map(keys => ({ keys, group: DO, help: 'Jump into the message box', run: (a: Actions) => a.composer() })),
  { keys: 'd', group: DO, help: 'Delete the selected thread (asks first; Undo in the toast)', run: a => a.remove() },
  { keys: '/', group: DO, help: 'Find in this thread, or search this page', run: a => a.find() },
  { keys: ':', group: DO, help: 'Search or jump anywhere', run: a => a.palette() },
  { keys: '?', group: DO, help: 'Show these shortcuts', run: a => a.help() },
];

// 'g g' → 'gg', 'C-w h' → 'Ctrl W h', 'Escape' → 'Esc'.
export function keyLabel(keys: string): string {
  const parts = keys.split(' ').map(t => t.startsWith('C-') ? `Ctrl ${t.slice(2).toUpperCase()}` : t === 'Escape' ? 'Esc' : t);
  return parts.every(p => p.length === 1) ? parts.join('') : parts.join(' ');
}

// One row per description: bindings that share a description share a row ('h / Ctrl W h / Ctrl H').
export function helpRows<B extends { keys: string; group: Group; help: string }>(bindings: B[]): { group: Group; rows: [string, string][] }[] {
  const groups = new Map<Group, Map<string, string[]>>();
  for (const b of bindings) {
    const g = groups.get(b.group) ?? groups.set(b.group, new Map()).get(b.group)!;
    (g.get(b.help) ?? g.set(b.help, []).get(b.help)!).push(keyLabel(b.keys));
  }
  return [...groups].map(([group, rows]) => ({ group, rows: [...rows].map(([help, keys]) => [keys.join(' / '), help] as [string, string]) }));
}
