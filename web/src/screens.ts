// Screen stack maths (pure, tested in screens.test.ts): how deep a route sits, where "back" goes, which transition a
// route change gets, and where the back-swipe underlay sits. The DOM sides are screenTransition.ts and BackSwipe.tsx.
import type { Route } from './ui';

// 0 = a top-level list (home, inbox, settings list, the kanban index…), 1 = something opened from one (a thread, a board, a section).
export function depth(r: Route): number {
  if (r.name === 'thread' || r.name === 'board') return 1;
  if (r.name === 'kanban') return r.slug ? 1 : 0;
  if (r.name === 'settings') return r.tab ? 1 : 0;
  if (r.name === 'rooms') return r.id ? 1 : 0;
  return 0;
}

// The screen a back gesture returns to (a hash path), or null on a top-level screen (there the edge opens the drawer).
export function parentOf(r: Route): string | null {
  if (r.name === 'settings') return r.tab ? '/settings' : null;
  if (r.name === 'rooms') return r.id ? '/rooms' : null;
  if (r.name === 'kanban') return r.slug ? '/kanban' : null;
  return depth(r) ? '/' : null;
}

export type Transition = 'push' | 'pop' | 'fade' | null;

// Phones (the drawer layout, one screen at a time) push deeper screens in from the right and pop them back out.
// Wide layouts only cross-fade between different kinds of screen; thread → thread (j/k) is always instant.
export function transitionFor(from: Route, to: Route, phone: boolean): Transition {
  if (JSON.stringify(from) === JSON.stringify(to)) return null;
  const a = depth(from), b = depth(to);
  if (a !== b) return phone ? (b > a ? 'push' : 'pop') : 'fade';
  return from.name === to.name ? null : 'fade';
}

// Back-swipe at progress p (0 = untouched, 1 = gone): the screen below starts 30% to the left and catches up, iOS
// style. It's clipped to the strip left of the moving screen's edge, because both screens are transparent over the sky.
export const PARALLAX = 0.3, DIM = 0.25;
export function underlay(p: number, width: number) {
  const q = 1 - Math.min(1, Math.max(0, p));
  return { x: -PARALLAX * width * q, clipRight: (1 - PARALLAX) * width * q, dim: DIM * q };
}
