// Phone bottom-sheet drag maths (pure, tested in sheet.test.ts). The DOM side lives in Menu (ui.tsx).

export const SHEET_QUERY = '(pointer: coarse) and (max-width: 640px)';
export const LOCK = 8;        // px of travel before a touch counts as a drag (or a scroll)
export const FLING = 0.5;     // px/ms: a quick flick decides on its own, however short
export const DISMISS = 0.3;   // dragged past this share of its height, a slow release closes the sheet

// How far the sheet sits below its resting place for a finger that moved `dy`. Pulling up past the top
// resists (a quarter of the travel, at most 24px) instead of detaching the sheet from the bottom edge.
export function offset(dy: number) {
  return dy >= 0 ? dy : -Math.min(24, -dy / 4);
}

// On release: a flick wins (down closes, up keeps), otherwise past DISMISS of the height closes.
export function dismiss(dy: number, vy: number, height: number) {
  if (vy > FLING) return true;
  if (vy < -FLING) return false;
  return height > 0 && dy > height * DISMISS;
}

// The first pixels decide: a downward, mostly vertical move drags the sheet, but only when the list under the
// finger is already scrolled to its top (otherwise the finger scrolls the list back up, like iOS).
export function decide(dx: number, dy: number, atTop: boolean): 'drag' | 'scroll' | null {
  if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return null;
  return dy > 0 && atTop && dy > Math.abs(dx) ? 'drag' : 'scroll';
}
