// The iPhone app's side of the page (ios/, contract in the shell's README): the app injects window.__gibbousShell
// ({platform:'ios'}) at document start and data-shell="ios" once <html> exists, and listens on
// webkit.messageHandlers.gibbous*. This wires the page to it. Every helper is a no-op in browsers and Gibbous.app.
import { api, ApiError } from './api';
import { hapticDue, hapticStyle, isExternal, openPath, pushResult, type HapticKind, type PushStatus } from './iosshell';
import { isRoute } from './macshell';

type Shell = { platform?: string; version?: string; build?: string };
const shell = () => (typeof window === 'undefined' ? undefined : (window as any).__gibbousShell as Shell | undefined);
export const inIosApp = () => typeof document !== 'undefined' && (shell()?.platform === 'ios' || document.documentElement.dataset.shell === 'ios');
const post = (name: string, body: Record<string, unknown>) => {
  if (!inIosApp()) return false;
  const h = (window as any).webkit?.messageHandlers?.[name];
  if (!h) return false;
  try { h.postMessage(body); return true; } catch { return false; }
};

// ── helpers the app calls ───────────────────────────────────────────────
let lastHaptic = 0;
export function haptic(kind: HapticKind) {
  if (!inIosApp()) return;
  const style = hapticStyle(kind), now = Date.now();
  if (!style || !hapticDue(lastHaptic, now)) return;
  lastHaptic = now;
  post('gibbousHaptic', { style });
}
// Share sheet: Save to Files / Photos / AirDrop. A same-origin url (/api/media?path=…) is downloaded natively with
// the web view's cookies, saved as `filename`.
export const shareNative = (p: { url?: string; text?: string; title?: string; filename?: string }) => post('gibbousShare', p);
export const openExternal = (url: string) => post('gibbousOpen', { url });
export const requestPush = () => { setPush({ state: 'asking' }); if (!post('gibbousPush', {})) setPush({ state: 'error', message: "This version of the app can't turn on notifications" }); };
export const changeServer = () => post('gibbousServer', {});
export const iosBadge = (count: number) => post('gibbousBadge', { count });
// Local notification while the app is in the background (the app itself also checks it is).
export const iosNotify = (n: { title: string; body?: string; url?: string; tag?: string }) => post('gibbousNotify', n);
export const shellVersion = () => { const s = shell(); return s?.version ? `${s.version}${s.build ? ` (${s.build})` : ''}` : undefined; };

// ── push registration (Settings → Notifications reads this) ──────────────
const PUSH_KEY = 'gibbous.iosPush';
let push: PushStatus = { state: typeof localStorage !== 'undefined' && localStorage.getItem(PUSH_KEY) === 'on' ? 'on' : 'off' };
const pushSubs = new Set<() => void>();
function setPush(s: PushStatus) { push = s; pushSubs.forEach(f => f()); }
export const pushStatus = () => push;
export const onPushStatus = (f: () => void) => { pushSubs.add(f); return () => { pushSubs.delete(f); }; };

async function registerToken(token: string, env: string) {
  try {
    await api.post<{ ok: boolean; configured?: boolean }>('/api/push/apns', { token, env }).then(r => setPush(pushResult(200, r)));
  } catch (e) {
    setPush(e instanceof ApiError ? pushResult(e.status, { error: e.message }) : { state: 'error', message: String((e as Error)?.message ?? e) });
  }
  // Remember the wish, not the outcome: a server that gets its APNs key later picks the token up on next launch.
  localStorage.setItem(PUSH_KEY, 'on');
}

// ── install ─────────────────────────────────────────────────────────────
export function installIosShell(deps: { go(path: string): void; refresh(): void; reconnect(): void }) {
  // The document-start script may have run before <html> existed: apply what it left on window.
  if (shell()?.platform === 'ios') document.documentElement.dataset.shell = 'ios';
  if (!inIosApp()) return;

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); });
  (window as any).gibbousNative = (ev: { type?: string; url?: string; token?: string; env?: string; message?: string }) => {
    switch (ev?.type) {
      case 'resume': {
        // Away long enough for iOS to have frozen the socket: reconnect now (views re-resume on ready), else just resync.
        if (!hiddenAt || Date.now() - hiddenAt > 10_000) deps.reconnect(); else deps.refresh();
        break;
      }
      case 'open': { const p = openPath(ev.url, location.origin); if (p) deps.go(p); break; }
      case 'pushToken': if (ev.token) registerToken(ev.token, ev.env === 'production' ? 'production' : 'sandbox'); break;
      case 'pushError': setPush({ state: 'error', message: ev.message || "Couldn't turn on notifications" }); break;
    }
  };

  // The route reopens on cold launch.
  const route = () => { if (isRoute(location.hash)) post('gibbousRoute', { route: location.hash }); };
  addEventListener('hashchange', route);
  route();

  // Links that leave Gibbous open in Safari (the app would otherwise navigate itself away). Runs after React's
  // handlers (document, bubble phase), so links the app already handles (media viewer) are left alone.
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!a || a.hasAttribute('download') || !isExternal(a.href, location.origin)) return;
    e.preventDefault();
    openExternal(a.href);
  });
  const open = window.open.bind(window);
  window.open = ((url?: string | URL, ...rest: any[]) => {
    const href = url == null ? '' : String(url);
    if (href && isExternal(href, location.origin)) { openExternal(new URL(href, location.origin).href); return null; }
    return open(url, ...rest);
  }) as typeof window.open;

  // Tokens can change (restore, reinstall): once turned on, re-register on every launch. No prompt once granted.
  if (localStorage.getItem(PUSH_KEY) === 'on') post('gibbousPush', {});
}
