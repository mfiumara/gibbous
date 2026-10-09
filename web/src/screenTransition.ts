// Route changes as native screen transitions (same-document View Transitions, Safari 18 / Chrome). Only the screen
// area has a view-transition-name (.vt-screen, styles.css), so the sidebar, the sky moon and overlays stay live.
// Which animation a change gets is decided in screens.ts; this file only drives the browser API.
import type { Route } from './ui';
import { transitionFor } from './screens';

let quietUntil = 0, last = 0;
let running: { skipTransition(): void; finished: Promise<void> } | null = null;

// The next route change happens without an animation and is painted synchronously: the drawer slides itself away,
// and a finished back-swipe has already moved the screen where the new one goes.
export const quiet = (ms = 600) => { quietUntil = performance.now() + ms; };

// `commit(sync)` swaps in the new route; sync = it must be rendered before this call returns (flushSync).
export function screenChange(from: Route, to: Route, commit: (sync: boolean) => void) {
  const now = performance.now(), hush = now < quietUntil;
  // Keys held down or tapped in a burst (j j j) never queue animations: every step after the first is instant.
  const rapid = now - last < 350;
  last = now; if (hush) quietUntil = 0;
  const root = document.documentElement;
  const still = root.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = (document as Document & { startViewTransition?(cb: () => void): typeof running }).startViewTransition;
  const kind = !start || hush || rapid || still || document.hidden ? null : transitionFor(from, to, innerWidth < 1024);
  if (!kind) { running?.skipTransition(); commit(hush); return; }
  root.dataset.vt = kind; // picks the keyframes in styles.css
  const vt = running = start.call(document, () => commit(true))!;
  vt.finished.catch(() => {}).finally(() => { if (running === vt) { running = null; delete root.dataset.vt; } });
}
