// Pure helpers for the macOS app shell (desktop/Gibbous.swift); the DOM side is macShellBridge.ts.

// Presses on these never move the window: they're controls, even inside a drag region.
export const INTERACTIVE = 'button, a, input, textarea, select, label, summary, [role=button], [role=menuitem], [role=option], [role=tab], [contenteditable=""], [contenteditable=true], [data-no-drag]';

// A drag region is [data-drag-window]: the whole element and its non-interactive content, or with ="self" only
// presses on the element itself (main's and the sidebar's title-bar padding, not everything inside them).
export function dragRegion(mode: string | undefined, onSelf: boolean, onControl: boolean) {
  return !onControl && (mode !== 'self' || onSelf);
}

// Same rule as the server's /login?next= (server/main.ts), so a saved route is one launch can reopen.
export const isRoute = (h: string) => /^#\/[\w/?=&%.~-]*$/.test(h);

// Menu commands whose shortcut the page handles itself (App.tsx onKey). WebKit already gives the page the key first;
// this is the belt to that: if the page just took the same key, the menu's copy is dropped.
export const MENU_KEYS: Record<string, string> = { new: 'n', palette: 'k', panel: '\\', stop: '.', approve: 'shift+a', find: 'f' };
export const combo = (e: { key: string; shiftKey: boolean }) => `${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`;
export function alreadyHandled(cmd: string, last: { combo: string; at: number } | undefined, now: number) {
  return !!last && MENU_KEYS[cmd] === last.combo && now - last.at < 500;
}
