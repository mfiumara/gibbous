import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { rpc } from './rpc';
import { useStore } from './store';
import { applyPrefs } from './ui';
import { healViewportOnBlur } from './viewport';
import { installMacShell } from './macBridge';

applyPrefs();
healViewportOnBlur();
installMacShell();
// A newer build was deployed while this tab was open and one of its chunks is gone: reload once onto the new build.
const reloadOnce = () => {
  if (Date.now() - Number(sessionStorage.getItem('gibbous.reloadedAt') ?? 0) < 30_000) return false;
  sessionStorage.setItem('gibbous.reloadedAt', String(Date.now())); location.reload(); return true;
};
addEventListener('vite:preloadError', e => { if (reloadOnce()) e.preventDefault(); });
(window as any).gibbousReloadOnce = reloadOnce;
document.documentElement.dataset.motion = localStorage.getItem('gibbous.motion') ?? 'on';

useStore.getState().load().then(() => { if (useStore.getState().authed) rpc.connect(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Clicking a push notification while the app is open routes in-place.
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.url) location.hash = String(e.data.url).replace(/^\/#/, ''); });

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
