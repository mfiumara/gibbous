// What the sidebar's bottom-left corner shows, picked in Settings → General and kept per device (a phone may want less).
// Settings is always there; everything taken out stays reachable from ⌘K.
import { useSyncExternalStore } from 'react';

export const CORNER_ITEMS = [
  { key: 'limits', label: 'Account limits', hint: 'Codex and Claude session and weekly use, like CodexBar' },
  { key: 'usage', label: 'Usage', hint: 'Tokens and API-equivalent cost' },
  { key: 'kanban', label: 'Kanban' },
  { key: 'archived', label: 'Archived', hint: 'Show archived threads in the sidebar' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'automations', label: 'Automations' },
  { key: 'rooms', label: 'Rooms' },
] as const;
export type CornerKey = typeof CORNER_ITEMS[number]['key'];
const KEY = 'gibbous.corner', DEFAULT: CornerKey[] = ['limits', 'usage', 'kanban'];
const subs = new Set<() => void>();
let cur: CornerKey[] = (() => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); return Array.isArray(v) ? v : DEFAULT; } catch { return DEFAULT; } })();
export function setCorner(keys: CornerKey[]) { cur = CORNER_ITEMS.map(i => i.key).filter(k => keys.includes(k)); localStorage.setItem(KEY, JSON.stringify(cur)); subs.forEach(f => f()); }
export const useCorner = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => cur);
