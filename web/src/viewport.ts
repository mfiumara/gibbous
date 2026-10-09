// iOS home-screen apps: once the keyboard has opened, WebKit can leave the viewport short by ~50px after it closes
// (WebKit 254868): every fixed layer, #root included, ends that far above the screen bottom, leaving a dead band
// under the composer until the app is force-quit. Toggling display on a full-viewport element makes WebKit
// re-measure; we do that only when the viewport is actually short, after a field loses focus.
// (Guarded so the pure helpers below can be imported by node:test.)
const browser = typeof window !== 'undefined';
const standalone = browser && (navigator as { standalone?: boolean }).standalone === true;
let tallest = browser ? innerHeight : 0, heals = 0;
if (browser) addEventListener('resize', () => { tallest = Math.max(tallest, innerHeight); });

// ── on-screen keyboard ─────────────────────────────────────────────────
// iOS (Safari ignores interactive-widget=resizes-content) doesn't shrink the layout viewport for the keyboard: it
// slides the keyboard over the page and scrolls the whole document to reveal the field, so the fixed #root jumped
// up and the composer floated mid-screen or hid behind the keys. Instead we read how much of the layout viewport
// the keyboard covers and end #root right above it (--kb, styles.css), with the document pinned at scroll 0.
export interface ViewportSample { innerHeight: number; vvHeight: number; vvOffsetTop: number; scale: number; field: boolean }
export function keyboardInset({ innerHeight, vvHeight, vvOffsetTop, scale, field }: ViewportSample) {
  // Pinch-zoom shrinks the visual viewport too; only a focused field means a keyboard.
  if (!field || scale > 1.01) return 0;
  const kb = Math.round(innerHeight - vvHeight - vvOffsetTop);
  return kb > 1 ? kb : 0;
}

const isField = (el: Element | null) => !!el && (el.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=file]), textarea, select') || (el as HTMLElement).isContentEditable);

// CSS px of a fixed element per screen px under the density zoom (same probe as fixedScale in ui.tsx).
const zoomScale = () => {
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;left:0;top:100px;width:0;height:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(p);
  const k = p.getBoundingClientRect().top / 100;
  p.remove();
  return k > 0 ? k : 1;
};

export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let last = -1;
  const update = () => {
    const field = isField(document.activeElement);
    // iOS scrolled the document to show the field: undo it, #root already ends above the keyboard.
    if (field && (scrollY !== 0 || document.scrollingElement?.scrollTop)) scrollTo(0, 0);
    const kb = keyboardInset({ innerHeight, vvHeight: vv.height, vvOffsetTop: vv.offsetTop, scale: vv.scale, field });
    if (kb === last) return;
    last = kb;
    if (kb) { root.style.setProperty('--kb', `${kb / zoomScale()}px`); root.dataset.kb = ''; }
    else { root.style.removeProperty('--kb'); delete root.dataset.kb; }
    // A field inside a scroller (Home's first-message box) may now sit under the keyboard's old edge.
    if (kb && field) (document.activeElement as HTMLElement).scrollIntoView?.({ block: 'nearest' });
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  addEventListener('scroll', update, { passive: true });
  addEventListener('focusin', update);
  // The keyboard animates for ~250ms; the visualViewport events cover it, focusout just drops --kb promptly.
  addEventListener('focusout', () => setTimeout(update, 0));
}

// For the debug bundle: how this device's viewport actually measures (layout bugs on phones are device-specific).
export function viewportReport() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe), root = document.getElementById('root')?.getBoundingClientRect();
  const r = { standalone, innerHeight, tallestInnerHeight: tallest, screen: `${screen.width}x${screen.height}`, visualViewport: visualViewport && `${Math.round(visualViewport.width)}x${Math.round(visualViewport.height)}+${Math.round(visualViewport.offsetTop)}`,
    rootBottom: root && Math.round(root.bottom), safeTop: cs.paddingTop, safeBottom: cs.paddingBottom, dpr: devicePixelRatio, heals, density: document.documentElement.dataset.density };
  probe.remove();
  return r;
}

export function healViewportOnBlur() {
  if (!standalone) return;
  // The tallest the viewport has been in this orientation (screen.height isn't reliable: some iOS versions never reach it).
  let full = innerHeight, landscape = innerWidth > innerHeight;
  addEventListener('resize', () => {
    const l = innerWidth > innerHeight;
    if (l !== landscape) { landscape = l; full = innerHeight; } else if (!isField(document.activeElement)) full = Math.max(full, innerHeight);
  });
  const short = () => full - innerHeight > 4;

  const heal = () => {
    if (!short() || isField(document.activeElement)) return;
    // A full-height probe first: it re-measures without touching the app, so nothing loses its scroll position.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    void probe.offsetHeight; probe.style.display = 'none'; void probe.offsetHeight; probe.remove();
    if (!short()) return;
    // Still short: flip the app root itself, keeping every scroller where it was.
    const root = document.getElementById('root');
    if (!root) return;
    const scrolled = [...root.querySelectorAll<HTMLElement>('*')].filter(el => el.scrollTop > 0).map(el => [el, el.scrollTop] as const);
    heals++;
    root.style.display = 'none'; void root.offsetHeight; root.style.display = '';
    for (const [el, top] of scrolled) el.scrollTop = top;
  };

  // The keyboard animates out for ~250ms; check after it settles, and once more in case iOS resized late.
  addEventListener('focusout', () => { setTimeout(heal, 300); setTimeout(heal, 900); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(heal, 300); });
}
