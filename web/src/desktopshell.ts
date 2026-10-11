// Pure helpers for the Windows/Linux app shell (desktop-tauri/, Tauri v2); the DOM side is desktopBridge.ts.
// Importable by node:test.

export type DesktopPlatform = 'windows' | 'linux';

// The shell's platform from window.__gibbousShell. Only the Tauri app sets 'windows'/'linux' (the iPhone app sets
// 'ios', Gibbous.app sets no platform at all), so the Mac/iOS checks and this one can't both match.
export function desktopPlatform(p: unknown): DesktopPlatform | null {
  return p === 'windows' || p === 'linux' ? p : null;
}

// What the server's notify event becomes inside the desktop app: a native notification unless it's about the thread
// on screen (`here`), same rule as the Mac app. The test notification (data.test) always shows: `here` is already false.
export function desktopNotification(data: { title?: string; body?: string; url?: string; tag?: string }, here: boolean) {
  if (here) return null;
  return { title: data.title || 'Gibbous', body: data.body ?? '', url: data.url ?? '', tag: data.tag ?? '' };
}
