// The Windows/Linux app's side of the page (desktop-tauri/, Tauri v2). The app sets window.__gibbousShell
// ({platform:'windows'|'linux', version, build}) at document start and exposes window.gibbousDesktop.post(name, body)
// (→ the Rust `bridge` command; returns a Promise). Every helper is a no-op in browsers, Gibbous.app and the iPhone app.
import { isExternal, openPath } from './iosshell';
import { isRoute } from './macshell';
import { desktopPlatform } from './desktopshell';

type Shell = { platform?: string; version?: string; build?: string };
const shell = () => (typeof window === 'undefined' ? undefined : (window as any).__gibbousShell as Shell | undefined);
export const inDesktopApp = () => !!desktopPlatform(shell()?.platform);

function post<T = unknown>(name: string, body: Record<string, unknown> = {}): Promise<T> | undefined {
  if (!inDesktopApp()) return undefined;
  const b = (window as any).gibbousDesktop;
  if (!b?.post) return undefined;
  try { return Promise.resolve(b.post(name, body)); } catch (e) { return Promise.reject(e); }
}

export const desktopNotify = (n: { title: string; body: string; url: string; tag: string }) => { post('notify', n)?.catch(() => {}); };
export const desktopBadge = (count: number) => { post('badge', { count })?.catch(() => {}); };
export const desktopOpen = (url: string) => post('open', { url });
// Saves into the user's Downloads (the app fetches it with this page's cookies) and resolves to the saved path.
export const desktopDownload = (url: string, filename: string) => post<string>('download', { url, filename });
export const desktopReveal = (path: string) => post('reveal', { path });

export function installDesktopShell(deps: { go(path: string): void; refresh(): void }) {
  const p = desktopPlatform(shell()?.platform);
  if (!p) return;
  // The document-start script may have run before <html> existed: apply what it left on window.
  document.documentElement.dataset.shell = p;

  // Native → page: the window came back from the tray (resync), or a notification was clicked (open its thread).
  (window as any).gibbousNative = (ev: { type?: string; url?: string }) => {
    if (ev?.type === 'resume') deps.refresh();
    else if (ev?.type === 'open') { const to = openPath(ev.url, location.origin); if (to) deps.go(to); }
  };

  // The route reopens on relaunch.
  const route = () => { if (isRoute(location.hash)) post('route', { route: location.hash })?.catch(() => {}); };
  addEventListener('hashchange', route);
  route();

  // Links that leave Gibbous open in the system browser (the app's navigation hook is the second line of defence).
  // Runs after React's handlers (document, bubble phase), so links the app already handles are left alone.
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!a || a.hasAttribute('download') || !isExternal(a.href, location.origin)) return;
    e.preventDefault();
    desktopOpen(a.href)?.catch(() => {});
  });
  const open = window.open.bind(window);
  window.open = ((url?: string | URL, ...rest: any[]) => {
    const href = url == null ? '' : String(url);
    if (href && (isExternal(href, location.origin) || /^[a-z][\w+.-]*:/i.test(href) && !/^(https?|blob|data|about):/i.test(href))) {
      desktopOpen(new URL(href, location.origin).href)?.catch(() => {});
      return null;
    }
    return open(url, ...rest);
  }) as typeof window.open;
}
