// Phone drawer gesture maths (pure, tested in drawer.test.ts). The DOM side lives in Sidebar.tsx.

export const EDGE = 28;       // px from the left edge where a swipe can open the drawer
export const LOCK = 10;       // px of travel before we decide horizontal vs vertical
export const FLING = 0.45;    // px/ms: a quick flick decides on its own, however short

// Where the drawer sits (0 = closed, 1 = open) for a finger that started with it `open` and moved `dx`.
export function progress(open: boolean, dx: number, width: number) {
  const p = (open ? width + dx : dx) / width;
  return Math.min(1, Math.max(0, p));
}

// On release: a flick wins; otherwise it snaps to whichever side is nearer.
export function settle(open: boolean, dx: number, vx: number, width: number) {
  if (vx > FLING) return true;
  if (vx < -FLING) return false;
  return progress(open, dx, width) > 0.5;
}

// The first few pixels decide the axis. Vertical (or a mostly vertical diagonal) leaves the page scrolling.
export function axis(dx: number, dy: number): 'x' | 'y' | null {
  if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
}
