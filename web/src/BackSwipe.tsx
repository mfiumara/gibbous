import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useStore } from './store';
import { EDGE, axis, progress, settle } from './drawer';
import { DIM, parentOf, underlay } from './screens';
import { quiet } from './screenTransition';
import { go, parse, routeNow, type Route } from './ui';

// Sideways scrollers (code blocks, tables, the subagent pager, chip rows) keep their own horizontal swipes.
export function inScroller(el: EventTarget | null) {
  for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
  }
  return false;
}

// Phones, inside a thread / board / settings section: a drag from the left edge goes back, iOS style. The screen
// follows the finger and the screen it returns to (rendered for real, inert) trails underneath with a parallax; on
// release a flick or past-halfway finishes the slide and navigates, otherwise it springs back. On top-level screens
// the same edge drag opens the drawer instead (Sidebar.tsx asks parentOf() and stands aside here).
export function BackSwipe({ screen, render }: { screen: RefObject<HTMLDivElement | null>; render(r: Route): ReactNode }) {
  const [under, setUnder] = useState<string | null>(null);
  const uRef = useRef<HTMLDivElement>(null), dimRef = useRef<HTMLDivElement>(null), last = useRef(0);
  const paint = (p: number | null, ms = 0) => {
    const s = screen.current, u = uRef.current;
    if (!s) return;
    const ease = ms ? `${ms}ms cubic-bezier(.32,.72,0,1)` : 'none';
    if (p == null) { s.style.translate = s.style.transition = s.style.boxShadow = ''; return; }
    last.current = p;
    const w = s.offsetWidth, x = Math.round(p * w * 10) / 10;
    s.style.transition = ms ? `translate ${ease}` : 'none';
    s.style.translate = `${x}px 0`; // Tailwind's translate-x-* use `translate`; keep to the same property
    s.style.boxShadow = '-14px 0 32px -12px rgb(0 0 0 / .55)';
    if (u) {
      const o = underlay(p, w);
      u.style.transition = ms ? `translate ${ease}, clip-path ${ease}` : 'none';
      u.style.translate = `${o.x}px 0`; u.style.clipPath = `inset(0 ${o.clipRight}px 0 0)`;
      if (dimRef.current) { dimRef.current.style.transition = ms ? `opacity ${ease}` : 'none'; dimRef.current.style.opacity = String(o.dim); }
    }
  };
  // The underlay mounts a frame into the drag: place it where the finger already is.
  useLayoutEffect(() => { if (under) paint(last.current); }, [under]);

  useEffect(() => {
    let g: { x0: number; y0: number; lock: 'x' | 'y' | null; w: number; lastX: number; lastT: number; vx: number; parent: string } | null = null;
    let busy = false; // the release animation is still running
    const start = (e: TouchEvent) => {
      g = null;
      if (busy || innerWidth >= 1024 || e.touches.length > 1 || useStore.getState().sidebar) return;
      const t = e.touches[0], parent = parentOf(routeNow());
      if (!parent || t.clientX > EDGE || inScroller(e.target) || !screen.current) return;
      g = { x0: t.clientX, y0: t.clientY, lock: null, w: screen.current.offsetWidth || innerWidth, lastX: t.clientX, lastT: e.timeStamp, vx: 0, parent };
    };
    const move = (e: TouchEvent) => {
      if (!g) return;
      const t = e.touches[0], dx = t.clientX - g.x0;
      if (!g.lock) {
        g.lock = axis(dx, t.clientY - g.y0);
        if (g.lock === 'y') { g = null; return; }
        if (!g.lock) return;
        last.current = 0; setUnder(g.parent);
      }
      e.preventDefault(); // ours now: no page scroll, no browser back-swipe
      const dt = e.timeStamp - g.lastT;
      if (dt > 0) g.vx = .7 * ((t.clientX - g.lastX) / dt) + .3 * g.vx;
      g.lastX = t.clientX; g.lastT = e.timeStamp;
      paint(progress(false, dx, g.w));
    };
    const end = (e: TouchEvent) => {
      if (!g) return;
      const was = g; g = null;
      if (was.lock !== 'x') return;
      const dx = (e.changedTouches[0]?.clientX ?? was.lastX) - was.x0;
      const back = settle(false, dx, e.timeStamp - was.lastT > 80 ? 0 : was.vx, was.w);
      const p = progress(false, dx, was.w);
      const still = document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
      // The rest of the way takes the time the remaining distance needs, never a fixed long slide.
      const ms = still ? 0 : Math.round(140 + 220 * (back ? 1 - p : p));
      busy = true;
      const s = screen.current;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true; busy = false; s?.removeEventListener('transitionend', onEnd);
        if (back) {
          // Hide the underlay first so the real parent screen never paints on top of its copy; then swap the route
          // synchronously (quiet = no view transition) and drop the offset in the same frame.
          if (uRef.current) uRef.current.style.visibility = 'hidden';
          quiet(); go(was.parent);
          // The copy was already on screen: the real one's mount animations (rows rising in) would replay. Skip them.
          for (const a of document.getAnimations()) { const t = (a.effect as KeyframeEffect | null)?.target; if (t && s?.contains(t)) a.finish(); }
        }
        paint(null); setUnder(null);
      };
      // Finish on the slide's own end (a janky frame can't make it jump early); the timer is only a fallback.
      const onEnd = (ev: TransitionEvent) => { if (ev.target === s && ev.propertyName === 'translate') finish(); };
      if (!ms) { finish(); return; }
      s?.addEventListener('transitionend', onEnd);
      paint(back ? 1 : 0, ms);
      setTimeout(finish, ms + 150);
    };
    addEventListener('touchstart', start, { passive: true });
    addEventListener('touchmove', move, { passive: false });
    addEventListener('touchend', end, { passive: true }); addEventListener('touchcancel', end, { passive: true });
    return () => { removeEventListener('touchstart', start); removeEventListener('touchmove', move); removeEventListener('touchend', end); removeEventListener('touchcancel', end); };
  }, []);

  if (!under) return null;
  return (
    <div ref={uRef} aria-hidden inert className="absolute inset-0 overflow-hidden pointer-events-none">
      <Suspense fallback={null}>{render(parse(under))}</Suspense>
      <div ref={dimRef} className="absolute inset-0 bg-black" style={{ opacity: DIM }} />
    </div>
  );
}
