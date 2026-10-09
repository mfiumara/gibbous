// iOS home-screen apps: once the keyboard has opened, WebKit can leave the viewport short by ~50px after it closes
// (WebKit 254868): every fixed layer, #root included, ends that far above the screen bottom, leaving a dead band
// under the composer until the app is force-quit. Toggling display on a full-viewport element makes WebKit
// re-measure; we do that only when the viewport is actually short, after a field loses focus.
const standalone = (navigator as { standalone?: boolean }).standalone === true;
let tallest = innerHeight, heals = 0;
addEventListener('resize', () => { tallest = Math.max(tallest, innerHeight); });

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
  const isField = (el: Element | null) => !!el && (el.matches('input, textarea, select') || (el as HTMLElement).isContentEditable);
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
