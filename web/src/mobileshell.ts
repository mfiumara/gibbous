// Pure helpers for the phone app shells: the iPhone app (ios/, webkit.messageHandlers.gibbous*) and the Android app
// (android/, window.gibbousAndroid.postMessage(JSON)). Both set window.__gibbousShell {platform, version, build}; the
// contract is in each shell's README. The DOM side is mobileBridge.ts. Importable by node:test.
import { isRoute } from './macshell.ts';

export type MobilePlatform = 'ios' | 'android';
// Which phone shell this page runs in, from window.__gibbousShell or the data-shell the shell set on <html>. Never from
// handler presence: Gibbous.app also has webkit.messageHandlers.
export function shellPlatform(shell: { platform?: unknown } | undefined | null, dataShell?: string): MobilePlatform | undefined {
  const p = shell?.platform ?? dataShell;
  return p === 'ios' || p === 'android' ? p : undefined;
}

// The Android shell's one message channel carries {name, body} as a JSON string (WebMessageListener only takes strings).
export const androidMessage = (name: string, body: Record<string, unknown>) => JSON.stringify({ name, body });

// Where each shell's push token is registered, and with what body. Android's env is always 'fcm'.
export function pushRegistration(platform: MobilePlatform, token: string, env?: string): { path: string; body: Record<string, string> } {
  if (platform === 'android' || env === 'fcm') return { path: '/api/push/fcm', body: { token } };
  return { path: '/api/push/apns', body: { token, env: env === 'production' ? 'production' : 'sandbox' } };
}

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' | 'selection' | 'success' | 'warning' | 'error';
const STYLES = new Set<string>(['light', 'medium', 'heavy', 'soft', 'rigid', 'selection', 'success', 'warning', 'error']);

// What the app does → how it feels. Sparing on purpose: only moments where a real iOS app would tick.
export const HAPTICS = {
  send: 'light',        // composer / first message sent
  menu: 'selection',    // a bottom sheet rises
  allow: 'success',     // approval allowed
  deny: 'warning',      // approval denied
  done: 'soft',         // the open thread's turn finished
  snap: 'light',        // drawer snapped open, back-swipe completed
  longPress: 'medium',  // long-press opened a row's menu
} as const satisfies Record<string, HapticStyle>;
export type HapticKind = keyof typeof HAPTICS | HapticStyle;

export function hapticStyle(kind: string): HapticStyle | null {
  if (Object.hasOwn(HAPTICS, kind)) return HAPTICS[kind as keyof typeof HAPTICS];
  return STYLES.has(kind) ? kind as HapticStyle : null;
}

// Two ticks closer than this read as one buzz (a long-press opening a sheet): keep the first.
export const HAPTIC_GAP = 150;
export const hapticDue = (last: number, now: number) => now - last >= HAPTIC_GAP;

// A notification/'open' url (`#/t/x`, `/#/t/x`, or the same server's absolute url) → the path for go(), else null.
export function openPath(url: unknown, origin: string): string | null {
  if (typeof url !== 'string' || !url) return null;
  let hash: string;
  if (url.startsWith('#')) hash = url;
  else if (url.startsWith('/#')) hash = url.slice(1);
  else {
    try { const u = new URL(url, origin); if (u.origin !== origin || (u.pathname !== '/' && u.pathname !== '')) return null; hash = u.hash; } catch { return null; }
  }
  return isRoute(hash) ? hash.slice(1) : null;
}

// Links that leave Gibbous go to Safari / a Custom Tab (gibbousOpen): another origin's http(s), or a mailto:/tel:/sms: link.
export function isExternal(href: string, origin: string): boolean {
  try {
    const u = new URL(href, origin);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin !== origin;
    return ['mailto:', 'tel:', 'sms:', 'facetime:', 'maps:'].includes(u.protocol);
  } catch { return false; }
}

// The server's answer to POST /api/push/apns (iPhone) or /api/push/fcm (Android) → what Settings shows.
export type PushStatus = { state: 'off' | 'asking' | 'on' | 'unconfigured' | 'outdated' | 'error'; message?: string };
export function pushResult(status: number, body: { ok?: boolean; configured?: boolean; error?: string } | undefined, platform: MobilePlatform = 'ios'): PushStatus {
  if (status === 404) return { state: 'outdated', message: 'Update the Gibbous server to enable push' };
  if (status >= 400 || !body?.ok) return { state: 'error', message: body?.error || `The server answered ${status}` };
  if (body.configured !== false) return { state: 'on' };
  return { state: 'unconfigured', message: platform === 'android' ? 'Push needs a Firebase service account on the server' : 'Push needs an APNs key on the server' };
}
