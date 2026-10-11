// The phone apps' side of the page: the iPhone app (ios/) and the Android app (android/); contract in each shell's
// README. Both inject window.__gibbousShell ({platform:'ios'|'android', version, build}) at document start and
// data-shell="<platform>" once <html> exists. iOS listens on webkit.messageHandlers.gibbous*, Android on one
// window.gibbousAndroid object that takes {name, body} as JSON; names and bodies are the same. This wires the page to
// them. Every helper is a no-op in browsers, Gibbous.app and the Windows/Linux app.
import { api, ApiError } from './api';
import { androidMessage, hapticDue, hapticStyle, isExternal, openPath, pushRegistration, pushResult, shellPlatform, type HapticKind, type MobilePlatform, type PushStatus } from './mobileshell';
import { isRoute } from './macshell';

type Shell = { platform?: string; version?: string; build?: string };
const shell = () => (typeof window === 'undefined' ? undefined : (window as any).__gibbousShell as Shell | undefined);
export const mobilePlatform = (): MobilePlatform | undefined =>
  typeof document === 'undefined' ? undefined : shellPlatform(shell(), document.documentElement.dataset.shell);
export const inMobileApp = () => mobilePlatform() !== undefined;
export const inIosApp = () => mobilePlatform() === 'ios';
export const inAndroidApp = () => mobilePlatform() === 'android';

// The one transport: false when the shell isn't there (or too old to know the message).
const post = (name: string, body: Record<string, unknown>) => {
  const p = mobilePlatform();
  try {
    if (p === 'ios') {
      const h = (window as any).webkit?.messageHandlers?.[name];
      if (!h) return false;
      h.postMessage(body); return true;
    }
    if (p === 'android') {
      const a = (window as any).gibbousAndroid;
      if (!a?.postMessage) return false;
      a.postMessage(androidMessage(name, body)); return true;
    }
  } catch { /* the shell went away */ }
  return false;
};

// ── helpers the app calls ───────────────────────────────────────────────
let lastHaptic = 0;
export function haptic(kind: HapticKind) {
  if (!inMobileApp()) return;
  const style = hapticStyle(kind), now = Date.now();
  if (!style || !hapticDue(lastHaptic, now)) return;
  lastHaptic = now;
  post('gibbousHaptic', { style });
}
// Share sheet: Save to Files / Photos / AirDrop (Android: the system share sheet). A same-origin url
// (/api/media?path=…) is downloaded natively with the web view's cookies, saved as `filename`.
export const shareNative = (p: { url?: string; text?: string; title?: string; filename?: string }) => post('gibbousShare', p);
export const openExternal = (url: string) => post('gibbousOpen', { url });
export const requestPush = () => { setPush({ state: 'asking' }); if (!post('gibbousPush', {})) setPush({ state: 'error', message: "This version of the app can't turn on notifications" }); };
export const changeServer = () => post('gibbousServer', {});
// Native banners while the app is open too: every Android build, iPhone builds 2+ (earlier ones only in the background).
export const nativeBanners = () => inAndroidApp() || (inIosApp() && Number(shell()?.build) >= 2);
export const appBadge = (count: number) => post('gibbousBadge', { count });
// A native notification (the shell decides whether to show it; Android skips it when FCM delivers the same one).
export const appNotify = (n: { title: string; body?: string; url?: string; tag?: string }) => post('gibbousNotify', n);
export const shellVersion = () => { const s = shell(); return s?.version ? `${s.version}${s.build ? ` (${s.build})` : ''}` : undefined; };

// ── push registration (Settings → Notifications reads this) ──────────────
// The keys keep their iOS-era names so iPhones that already turned push on keep re-registering (and aren't asked
// again); Android uses the same ones.
const PUSH_KEY = 'gibbous.iosPush', PUSH_ASKED = 'gibbous.iosPushAsked';
let push: PushStatus = { state: typeof localStorage !== 'undefined' && localStorage.getItem(PUSH_KEY) === 'on' ? 'on' : 'off' };
const pushSubs = new Set<() => void>();
function setPush(s: PushStatus) { push = s; pushSubs.forEach(f => f()); }
export const pushStatus = () => push;
export const onPushStatus = (f: () => void) => { pushSubs.add(f); return () => { pushSubs.delete(f); }; };

async function registerToken(platform: MobilePlatform, token: string, env?: string) {
  const { path, body } = pushRegistration(platform, token, env);
  try {
    await api.post<{ ok: boolean; configured?: boolean }>(path, body).then(r => setPush(pushResult(200, r, platform)));
  } catch (e) {
    setPush(e instanceof ApiError ? pushResult(e.status, { error: e.message }, platform) : { state: 'error', message: String((e as Error)?.message ?? e) });
  }
  // Remember the wish, not the outcome: a server that gets its push key later picks the token up on next launch.
  localStorage.setItem(PUSH_KEY, 'on');
}

// ── install ─────────────────────────────────────────────────────────────
export function installMobileShell(deps: { go(path: string): void; refresh(): void; reconnect(): void }) {
  // The document-start script may have run before <html> existed: apply what it left on window.
  const own = shellPlatform(shell());
  if (own) document.documentElement.dataset.shell = own;
  const platform = mobilePlatform();
  if (!platform) return;

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); });
  (window as any).gibbousNative = (ev: { type?: string; url?: string; token?: string; env?: string; message?: string }) => {
    switch (ev?.type) {
      case 'resume': {
        // Away long enough for the OS to have frozen the socket: reconnect now (views re-resume on ready), else just resync.
        if (!hiddenAt || Date.now() - hiddenAt > 10_000) deps.reconnect(); else deps.refresh();
        break;
      }
      case 'open': { const p = openPath(ev.url, location.origin); if (p) deps.go(p); break; }
      case 'pushToken': if (ev.token) registerToken(platform, ev.token, ev.env); break;
      case 'pushError': setPush({ state: 'error', message: ev.message || "Couldn't turn on notifications" }); break;
    }
  };

  // The route reopens on cold launch.
  const route = () => { if (isRoute(location.hash)) post('gibbousRoute', { route: location.hash }); };
  addEventListener('hashchange', route);
  route();

  // Links that leave Gibbous open in Safari / a Custom Tab (the app would otherwise navigate itself away). Runs after
  // React's handlers (document, bubble phase), so links the app already handles (media viewer) are left alone.
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
  // First signed-in launch: ask right away (iOS, and Android 13+, show their "Allow notifications?" prompt once; after
  // that the answer sticks and Settings → Notifications can retry). Waits a beat so the prompt lands on the app.
  else if (!localStorage.getItem(PUSH_ASKED) && !location.pathname.startsWith('/login')) {
    setTimeout(() => { localStorage.setItem(PUSH_ASKED, '1'); requestPush(); }, 1500);
  }
}
