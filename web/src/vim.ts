// The vim layer's DOM side: panes ([data-pane] = nav | items | doc), focus and scrolling. Keys and help live in keys.ts.
import { BINDINGS, TIMEOUT, match, token, type Actions, type Scope } from './keys';
import { cycleSpace } from '../../server/spaces';
import { go, parse } from './ui';
import { useStore, deleteWithUndo } from './store';

type Kind = 'nav' | 'items' | 'doc';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const COMPOSER = 'textarea[aria-label=Message], textarea[aria-label="First message"]';
const LINES = 72; // j/k in a transcript: about three lines

export const typing = (e: Event) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/.test((t as HTMLInputElement).type);
};

const kindOf = (p: Element) => p.getAttribute('data-pane') as Kind;
const sized = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const reachable = (el: HTMLElement) => el.tabIndex >= 0 && !el.closest('[inert], [aria-hidden="true"]') && sized(el);
const focusEl = (el: HTMLElement | undefined) => { if (!el) return; el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); };

// A pane counts when it's on screen and not covered (a closed drawer sits off screen; an open phone drawer covers main).
function paneShown(p: HTMLElement) {
  if (p.closest('[inert], [aria-hidden="true"]')) return false;
  const r = p.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.left >= innerWidth) return false;
  // Covered = the middle of it is under a fixed layer it isn't part of (an open drawer, its backdrop, a phone panel).
  let hit = document.elementFromPoint((Math.max(0, r.left) + Math.min(r.right, innerWidth)) / 2, r.top + r.height / 2);
  if (!hit || p.contains(hit) || hit.contains(p) || hit.closest('[aria-live]')) return true;
  while (hit && getComputedStyle(hit).position !== 'fixed') hit = hit.parentElement;
  return !hit || hit.contains(p);
}

// Innermost visible panes, left to right.
function panes(): HTMLElement[] {
  const all = [...document.querySelectorAll<HTMLElement>('[data-pane]')].filter(paneShown);
  const left = (p: HTMLElement) => p.getBoundingClientRect().left;
  return all.filter(p => !all.some(o => o !== p && p.contains(o))).sort((a, b) => left(a) - left(b));
}

const sidebarNav = () => document.querySelector<HTMLElement>('nav[aria-label=Threads]');
const settingsNav = () => document.querySelector<HTMLElement>('nav[aria-label="Settings sections"]');

// Remembered per pane: the control you were last on, so coming back (or j after Esc out of a field) continues there.
const last = new WeakMap<Element, HTMLElement>();
// After Esc out of a text field the field is blurred, but you're still in its pane.
let sticky: HTMLElement | null = null;
addEventListener('focusin', e => { const t = e.target as HTMLElement; const p = t.closest?.('[data-pane]'); if (p) last.set(p, t); sticky = null; });
addEventListener('pointerdown', () => { sticky = null; }, true);
addEventListener('hashchange', () => { sticky = null; });

// Focus decides the pane; with nothing focused it's the route's list (Settings sections, else the sidebar threads).
function activePane(): HTMLElement | null {
  const a = document.activeElement;
  const p = a && a !== document.body ? a.closest<HTMLElement>('[data-pane]') : null;
  if (p) return p;
  if (sticky?.isConnected) return sticky;
  return (parse(location.hash).name === 'settings' && settingsNav()) || sidebarNav();
}

const overlay = () => [...document.querySelectorAll<HTMLElement>('[role=menu]')].at(-1)
  ?? document.querySelector<HTMLElement>('dialog[open]') ?? document.querySelector<HTMLElement>('[role=dialog]');

function focusables(root: HTMLElement, sel = FOCUSABLE) { return [...root.querySelectorAll<HTMLElement>(sel)].filter(reachable); }

function step(root: HTMLElement, d: 1 | -1, sel?: string) {
  const list = focusables(root, sel);
  let i = list.indexOf(document.activeElement as HTMLElement);
  if (i < 0) i = list.indexOf(last.get(root)!);
  focusEl(i < 0 ? (d > 0 ? list[0] : list.at(-1)) : list[Math.max(0, Math.min(list.length - 1, i + d))]);
}

// The nav panes keep their original select-and-open behaviour; focus follows when it's already in the list.
const navLinks = (p: HTMLElement) => p === settingsNav()
  ? [...p.querySelectorAll<HTMLAnchorElement>('a[href^="#/settings/"]')]
  : [...p.querySelectorAll<HTMLAnchorElement>('a[href^="#/t/"]')].filter(a => !a.closest('[inert]'));
function openLink(nav: HTMLElement, a: HTMLAnchorElement) {
  if (a.getAttribute('href') !== location.hash) location.hash = a.getAttribute('href')!;
  if (nav.contains(document.activeElement)) a.focus({ preventScroll: true });
  a.scrollIntoView({ block: 'nearest' });
}

// In Settings, j/k walk the section list (clamped at both ends). On desktop the bare #/settings already shows the
// first section as current; on phones it's the list itself, so j opens the first section.
function walkSettings(nav: HTMLElement, d: 1 | -1) {
  const links = navLinks(nav);
  let here = links.findIndex(a => a.getAttribute('href') === location.hash);
  if (here < 0 && matchMedia('(min-width: 768px)').matches) here = links.findIndex(a => a.getAttribute('aria-current') === 'page');
  const next = links[here < 0 ? (d > 0 ? 0 : -1) : here + d];
  if (next) openLink(nav, next);
}

// Walk the sidebar in DOM order, skipping rows inside collapsed sections ([inert]). If the open thread is itself
// in a collapsed section, step from its position to the nearest visible row. Home sits above the first thread:
// j from Home opens the first thread, k past the first thread comes back Home.
function walkThreads(d: 1 | -1) {
  const nav = sidebarNav();
  if (!nav) return;
  const all = [...nav.querySelectorAll<HTMLAnchorElement>('a[href^="#/t/"]')];
  const open = (a: HTMLAnchorElement) => !a.closest('[inert]');
  const here = all.findIndex(a => a.getAttribute('href') === location.hash);
  const home = parse(location.hash).name === 'home';
  let next: HTMLAnchorElement | undefined;
  if (here < 0) next = home && d < 0 ? undefined : (d > 0 ? all : [...all].reverse()).find(open);
  else for (let i = here + d; i >= 0 && i < all.length && !next; i += d) if (open(all[i])) next = all[i];
  if (!next && here >= 0 && d < 0) { go('/'); nav.querySelector('.overflow-y-auto')?.scrollTo({ top: 0 }); return; }
  if (next) openLink(nav, next);
}

function scrollerOf(p: HTMLElement): HTMLElement | null {
  const can = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY);
  if (can(p)) return p;
  for (const el of p.querySelectorAll<HTMLElement>('*')) if (can(el) && sized(el)) return el;
  for (let el = p.parentElement; el; el = el.parentElement) if (can(el)) return el;
  return null;
}

function enter(p: HTMLElement) {
  sticky = null;
  const kind = kindOf(p);
  if (kind === 'doc') { p.focus({ preventScroll: true }); return; }
  if (kind === 'nav') {
    const links = navLinks(p);
    focusEl(links.find(a => a.getAttribute('href') === location.hash) ?? links.find(a => a.getAttribute('aria-current') === 'page') ?? links[0]);
    return;
  }
  const list = focusables(p), prev = last.get(p);
  if (list.length) focusEl(prev && list.includes(prev) ? prev : list[0]);
  else { (document.activeElement as HTMLElement | null)?.blur?.(); sticky = p; }
}

export function focusComposer() {
  const box = document.querySelector<HTMLTextAreaElement>(COMPOSER);
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
}

// Jumping to another page starts from that page's list, not from wherever focus was left.
const leave = () => { (document.activeElement as HTMLElement | null)?.blur?.(); sticky = null; };

function actions(help: () => void): Actions {
  return {
    move(d) {
      const o = overlay();
      if (o) return step(o, d, o.getAttribute('role') === 'menu' ? '[role=menuitem]' : undefined);
      const p = activePane();
      if (!p) return;
      const kind = kindOf(p);
      if (kind === 'nav') p === settingsNav() ? walkSettings(p, d) : walkThreads(d);
      else if (kind === 'doc') p.scrollTop += d * LINES;
      else step(p, d);
    },
    pane(d) {
      const list = panes(), cur = activePane();
      let i = cur ? list.indexOf(cur) : -1, next: HTMLElement | undefined;
      if (i >= 0) next = list[i + d];
      else {
        const x = cur?.getBoundingClientRect().left ?? -Infinity, left = (p: HTMLElement) => p.getBoundingClientRect().left;
        next = d > 0 ? list.find(p => left(p) > x) : list.findLast(p => left(p) < x);
      }
      if (next) enter(next);
    },
    edge(end) {
      const p = activePane();
      if (!p) return;
      const kind = kindOf(p);
      if (kind === 'doc') { p.scrollTop = end === 'top' ? 0 : p.scrollHeight; return; }
      if (kind === 'nav') { const links = navLinks(p), a = end === 'top' ? links[0] : links.at(-1); if (a) openLink(p, a); return; }
      const list = focusables(p);
      focusEl(end === 'top' ? list[0] : list.at(-1));
    },
    half(d) {
      const p = activePane();
      if (!p) return;
      const el = kindOf(p) === 'doc' ? p : scrollerOf(p);
      if (!el) return;
      el.scrollTop += d * Math.round(el.clientHeight / 2);
      if (kindOf(p) !== 'items') return;
      // Keep the focused control on screen, like vim keeps the cursor in the window.
      const box = el.getBoundingClientRect();
      const inView = (x: HTMLElement) => { const r = x.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; };
      const a = document.activeElement as HTMLElement | null;
      if (!(a && p.contains(a) && inView(a))) { const f = focusables(p).find(inView); if (f) f.focus({ preventScroll: true }); }
    },
    thread: walkThreads,
    go: path => { leave(); go(path); },
    board() {
      const { threads, projects } = useStore.getState(), r = parse(location.hash);
      const id = (r.name === 'thread' ? threads.find(t => t.id === r.id)?.projectId : r.name === 'board' ? r.projectId : undefined) ?? projects[0]?.id;
      if (id) { leave(); go(`/board/${id}`); }
    },
    space(d) { const s = useStore.getState(); s.setActiveSpace(cycleSpace(s.activeSpace, s.settings?.spaces ?? [], d)); },
    history: d => { leave(); history.go(d); },
    composer: focusComposer,
    find() {
      if (parse(location.hash).name === 'thread') { dispatchEvent(new CustomEvent('gibbous:find')); return; }
      const box = [...document.querySelectorAll<HTMLInputElement>('main input')].find(i => sized(i) && /search|filter|find/i.test(`${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`));
      if (box) { box.focus(); box.select(); } else useStore.setState({ palette: true });
    },
    palette: () => useStore.setState({ palette: true }),
    pullRequests: () => dispatchEvent(new Event('gibbous:pullRequests')),
    help,
    remove() {
      // The thread row with focus in the sidebar, else the open thread.
      const nav = sidebarNav(), a = document.activeElement;
      const focused = a instanceof HTMLAnchorElement && nav?.contains(a) && a.getAttribute('href')?.startsWith('#/t/') ? a.getAttribute('href')!.slice(4) : null;
      const r = parse(location.hash), id = focused ?? (r.name === 'thread' ? r.id : null);
      const t = id && useStore.getState().threads.find(x => x.id === id);
      if (!t || !confirm(`Delete “${t.title.slice(0, 60)}”?`)) return;
      // Deleting the open thread lands on its neighbour (next, else previous, else Home) so d/j/k keep flowing.
      const open = location.hash === `#/t/${t.id}`;
      const links = nav ? navLinks(nav) : [], i = links.findIndex(l => l.getAttribute('href') === `#/t/${t.id}`);
      const near = i < 0 ? undefined : links[i + 1] ?? links[i - 1];
      deleteWithUndo(t);
      if (open && near && nav) openLink(nav, near);
    },
  };
}

// Enter on a control does the control's thing; on a link it follows it, unless it's the page you're already on.
const nativeEnter = (t: HTMLElement) => !!t.closest('button, input, select, summary, [role=menuitem], [role=option]')
  || (!!t.closest('a[href]') && t.closest('a')!.getAttribute('href') !== location.hash);

let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

// Returns true when the key was ours (consumed, or part of a pending sequence).
export function vimKey(e: KeyboardEvent, help: () => void): boolean {
  if (e.isComposing || typing(e)) return false;
  const t = token(e);
  if (!t) return false;
  if (t === 'Enter' && !pending.length && e.target instanceof HTMLElement && nativeEnter(e.target)) return false;
  const scope: Scope = overlay() ? 'overlay' : 'normal';
  const r = match(pending, t, BINDINGS, scope);
  clearTimeout(timer);
  if (r.kind === 'pending') { pending.push(t); timer = setTimeout(() => { pending = []; }, TIMEOUT); e.preventDefault(); return true; }
  const had = pending.length > 0;
  pending = [];
  if (r.kind === 'none') { if (had) e.preventDefault(); return had; }
  e.preventDefault();
  r.binding.run(actions(help));
  return true;
}

// Esc backs out one level: out of a text field (staying in its pane), then out of the pane to the route's list.
// Menus and dialogs close themselves; call before anything else preventDefaults the event.
export function vimEscape(e: KeyboardEvent) {
  pending = [];
  if (document.querySelector('[role=menu], [role=dialog]')) return;
  const t = e.target as HTMLElement;
  if (typing(e)) {
    if (e.defaultPrevented || t.matches(COMPOSER)) return;
    const p = t.closest<HTMLElement>('[data-pane]');
    if (p && panes().includes(p)) { t.blur(); sticky = p; last.set(p, t); }
    return;
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  sticky = null;
}
