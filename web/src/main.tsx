import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { rpc } from './rpc';
import { useStore } from './store';
import { applyPrefs } from './ui';
import { healViewportOnBlur, trackKeyboard } from './viewport';
import { installMacShell } from './macBridge';

applyPrefs();
healViewportOnBlur();
trackKeyboard();
installMacShell();
// A newer build was deployed while this tab was open and one of its chunks is gone: reload once onto the new build.
const reloadOnce = () => {
  if (Date.now() - Number(sessionStorage.getItem('gibbous.reloadedAt') ?? 0) < 30_000) return false;
  sessionStorage.setItem('gibbous.reloadedAt', String(Date.now())); location.reload(); return true;
};
addEventListener('vite:preloadError', e => { if (reloadOnce()) e.preventDefault(); });
(window as any).gibbousReloadOnce = reloadOnce;
document.documentElement.dataset.motion = localStorage.getItem('gibbous.motion') ?? 'on';
nativeFeel();

// The parts of "an app, not a page" CSS can't do (the rest is the Native feel block in styles.css).
function nativeFeel() {
  // No Reload/Back/Inspect menu on chrome. It stays where it does something: fields, a selection you right-clicked,
  // links and images in messages, the terminal. App menus (sidebar rows) preventDefault themselves first.
  document.addEventListener('contextmenu', e => {
    const t = e.target instanceof Element ? e.target : null;
    if (e.defaultPrevented || !t) return;
    if (t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, .prose-moon a[href], img, video')) return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.containsNode(t, true)) return;
    e.preventDefault();
  });
  // iOS: pinching chrome zooms the whole app and strands it zoomed. Media (the viewer, images) still pinches, and once
  // zoomed any pinch works so you can always get back out. Not user-scalable=no: that also kills accessibility zoom.
  const zoomable = (t: EventTarget | null) => (visualViewport?.scale ?? 1) > 1.01
    || (t instanceof Element && !!t.closest('[aria-modal="true"], img, video'));
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, e => { if (!zoomable(e.target)) e.preventDefault(); }, { passive: false });
  // iOS only applies :active (the .press feedback) when the page listens for touches.
  document.addEventListener('touchstart', () => {}, { passive: true });
}

useStore.getState().load().then(() => { if (useStore.getState().authed) rpc.connect(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Clicking a push notification while the app is open routes in-place.
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.url) location.hash = String(e.data.url).replace(/^\/#/, ''); });

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
