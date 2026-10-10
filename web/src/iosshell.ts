// Pure helpers for the iPhone app shell (ios/, contract: window.__gibbousShell + webkit.messageHandlers.gibbous*);
// the DOM side is iosBridge.ts. Importable by node:test.
import { isRoute } from './macshell.ts';

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

// Links that leave Gibbous go to Safari (gibbousOpen): another origin's http(s), or a mailto:/tel:/sms: link.
export function isExternal(href: string, origin: string): boolean {
  try {
    const u = new URL(href, origin);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin !== origin;
    return ['mailto:', 'tel:', 'sms:', 'facetime:', 'maps:'].includes(u.protocol);
  } catch { return false; }
}

// The server's answer to POST /api/push/apns → what Settings shows.
export type PushStatus = { state: 'off' | 'asking' | 'on' | 'unconfigured' | 'outdated' | 'error'; message?: string };
export function pushResult(status: number, body: { ok?: boolean; configured?: boolean; error?: string } | undefined): PushStatus {
  if (status === 404) return { state: 'outdated', message: 'Update the Gibbous server to enable push' };
  if (status >= 400 || !body?.ok) return { state: 'error', message: body?.error || `The server answered ${status}` };
  return body.configured === false ? { state: 'unconfigured', message: 'Push needs an APNs key on the server' } : { state: 'on' };
}
