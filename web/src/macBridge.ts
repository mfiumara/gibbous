// Gibbous.app's side of the page (desktop/Gibbous.swift). The app injects data-shell="mac" + --titlebar before any
// script runs; this wires the rest: header drags, menu commands, theme and route reporting. A no-op in browsers.
import { useStore } from './store';
import { go } from './ui';
import { INTERACTIVE, dragRegion, isRoute, combo, alreadyHandled } from './macshell';

const post = (m: Record<string, unknown>) => (window as any).webkit?.messageHandlers?.gibbousWindow?.postMessage(m);
const wide = () => matchMedia('(min-width: 64rem)').matches; // Tailwind lg: the sidebar is a column, not a drawer

function toggleSidebar() {
  if (!wide()) { useStore.setState({ sidebar: !useStore.getState().sidebar }); return; }
  const d = document.documentElement, off = d.dataset.sidebar !== 'off';
  off ? (d.dataset.sidebar = 'off') : delete d.dataset.sidebar;
  localStorage.setItem('gibbous.macSidebar', off ? 'off' : 'on');
}

// The app leaves its shell values on window (desktop/Gibbous.swift shellScript): apply them before the first render, in
// case its document-start script ran before <html> existed.
function applyShellValues() {
  const s = (window as any).__gibbousShell as { titlebar: number; fullscreen: boolean } | undefined, d = document.documentElement;
  if (!s) return;
  d.dataset.shell = 'mac'; d.style.setProperty('--titlebar', `${s.titlebar}px`);
  if (s.fullscreen) d.dataset.fullscreen = ''; else delete d.dataset.fullscreen;
}

export function installMacShell() {
  applyShellValues();
  if (document.documentElement.dataset.shell !== 'mac' || !(window as any).webkit?.messageHandlers?.gibbousWindow) return;
  if (localStorage.getItem('gibbous.macSidebar') === 'off') document.documentElement.dataset.sidebar = 'off';

  // Empty header space moves the window, like a title bar. WKWebView has no -webkit-app-region: the app starts the
  // drag (or the double-click zoom) from this mouse-down. preventDefault: no text selection or focus change either.
  addEventListener('mousedown', e => {
    const el = e.target as HTMLElement;
    if (e.button !== 0 || !(el instanceof Element)) return;
    const region = el.closest<HTMLElement>('[data-drag-window]');
    if (!region) return;
    const control = el.closest(INTERACTIVE);
    if (!dragRegion(region.dataset.dragWindow, el === region, !!control && region.contains(control))) return;
    e.preventDefault();
    post({ drag: true });
  }, true);

  // Remember the last ⌘-key the page took, so the menu item for the same key doesn't run it again.
  let last: { combo: string; at: number } | undefined;
  addEventListener('keydown', e => {
    if (!e.metaKey && !e.ctrlKey) return;
    setTimeout(() => { if (e.defaultPrevented) last = { combo: combo(e), at: Date.now() }; }); // after every listener ran
  }, true);

  const thread = (name: string) => () => dispatchEvent(new CustomEvent(`gibbous:${name}`));
  const commands: Record<string, () => void> = {
    new: () => go('/new'), settings: () => go('/settings'), inbox: () => go('/inbox'),
    palette: () => useStore.setState({ palette: true }), sidebar: toggleSidebar,
    find: thread('find'), panel: thread('panel'), stop: thread('stop'), approve: thread('approve'),
    help: () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })),
  };
  (window as any).gibbousMenu = (cmd: string) => { if (!alreadyHandled(cmd, last, Date.now())) commands[cmd]?.(); };

  // The window's appearance (title bar, sidebar glass) follows the page theme; the route reopens on relaunch.
  const theme = () => post({ theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'night' });
  new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  theme();
  const route = () => { if (isRoute(location.hash)) post({ route: location.hash }); };
  addEventListener('hashchange', route);
  route();
}
