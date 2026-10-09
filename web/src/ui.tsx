import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ThreadStatus, TaskStatus } from './api';
import { moonPhase, nextFullMoon, eclipseShade, upcomingEclipses, eclipseLabel } from './moon';

// ── routing (hash-based so the PWA works from any path) ────────────────
export type Route =
  | { name: 'home'; projectId?: string; host?: string } | { name: 'thread'; id: string } | { name: 'board'; projectId: string }
  | { name: 'inbox' } | { name: 'sessions' } | { name: 'search'; q: string } | { name: 'settings'; tab: string } | { name: 'rooms'; id?: string } | { name: 'automations' };

export function parse(h: string): Route {
  const [path, query = ''] = h.replace(/^#/, '').split('?');
  const [, a, b] = path.split('/');
  if (a === 't' && b) return { name: 'thread', id: b };
  if (a === 'board' && b) return { name: 'board', projectId: b };
  if (a === 'new') return { name: 'home', projectId: b, host: new URLSearchParams(query).get('host') ?? undefined };
  if (a === 'search') return { name: 'search', q: new URLSearchParams(query).get('q') ?? '' };
  if (a === 'settings') return { name: 'settings', tab: b ?? '' }; // '' = the section list (phones); desktop shows General
  if (a === 'rooms') return { name: 'rooms', id: b };
  if (a === 'inbox' || a === 'sessions' || a === 'automations') return { name: a };
  return { name: 'home' };
}


// Route changes are instant: the page and the sidebar highlight just switch, nothing slides or morphs.
// Tonight's moonlight as CSS variables, so surfaces are lit like the moon in the background: --ml strength
// (0 = new … 1 = full, dimmed by Earth's shadow) and --blood, how copper-red an eclipse has turned it (0..1).
// Both follow the real eclipse contacts, so the UI warms over the hour before totality and cools after it.
const setMoonlight = () => {
  const { lit } = moonPhase(), { shadow, blood } = eclipseShade(), root = document.documentElement.style;
  root.setProperty('--ml', (lit ** .8 * (1 - shadow * .7)).toFixed(3));
  root.setProperty('--blood', blood.toFixed(3));
};
setMoonlight();
setInterval(setMoonlight, 60_000);

export function useRoute() {
  const [r, setR] = useState(() => parse(location.hash));
  useEffect(() => {
    const f = () => setR(parse(location.hash));
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return r;
}
export const go = (path: string) => { location.hash = path; };

// Unsent text survives reloads, navigation and restarts; an empty draft leaves nothing behind.
export function useDraft(key: string): [string, (v: string | ((t: string) => string)) => void] {
  const k = `gibbous.draft.${key}`;
  const [v, setV] = useState(() => localStorage.getItem(k) ?? '');
  const cur = useRef({ k, v });
  cur.current.k = k;
  useEffect(() => { const n = localStorage.getItem(k) ?? ''; cur.current.v = n; setV(n); }, [k]);
  // Storage is written here, not in a setState updater: after a send navigates away the component is
  // unmounted, React drops queued updaters, and the sent text would linger as a stale draft.
  const set = (x: string | ((t: string) => string)) => {
    const n = typeof x === 'function' ? x(cur.current.v) : x;
    cur.current.v = n;
    n ? localStorage.setItem(cur.current.k, n) : localStorage.removeItem(cur.current.k);
    setV(n);
  };
  return [v, set];
}

// ── preferences: theme + density live on <html> ─────────────────────────
export type Theme = 'night' | 'light' | 'system';
export type Density = 'compact' | 'cozy' | 'roomy';
export function applyPrefs() {
  const theme = (localStorage.getItem('gibbous.theme') as Theme) || 'night';
  const light = theme === 'light' || (theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'night';
  document.documentElement.dataset.density = localStorage.getItem('gibbous.density') || 'cozy';
  document.documentElement.dataset.skymoon = localStorage.getItem('gibbous.skymoon') || 'on';
  dispatchEvent(new Event('gibbous:prefs'));
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', light ? '#f3f4f7' : '#15171c');
}
export function usePref<T extends string>(key: 'theme' | 'density' | 'skymoon', fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => (localStorage.getItem(`gibbous.${key}`) as T) || fallback);
  return [v, (nv: T) => { localStorage.setItem(`gibbous.${key}`, nv); setV(nv); applyPrefs(); }];
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyPrefs);

// ── brand ───────────────────────────────────────────────────────────────
// The real Moon as it is tonight, as a still frame of the loader sprite. Hover: phase, the next full moon and eclipse.
const day = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export function TonightMoon({ size = 17 }: { size?: number }) {
  const { f, lit, name } = moonPhase();
  const tip = useMemo(() => {
    const full = nextFullMoon(), shade = eclipseShade(), next = upcomingEclipses(1)[0];
    return [shade.kind ? `${eclipseLabel(shade.kind)} now` : `${name}, ${Math.round(lit * 100)}% lit`,
      full && `next full moon ${day(full)}`,
      next && !shade.kind && `${next.kind === 'total' ? 'blood moon' : `${next.kind} eclipse`} ${day(next.peak)}${next.altitude == null ? '' : next.visible ? ' (visible here)' : ' (below your horizon)'}`].filter(Boolean).join(' · ');
  }, [name, lit]);
  return <span className="moon-loader moon-still" data-tip={tip} aria-label={tip} role="img" style={{ '--s': `${size}px`, '--tonight': Math.round(f * 36) % 36 } as React.CSSProperties} />;
}

// Loading: one lunation from the real Moon (36 frames, scripts/icon/loader.py). Reduced motion shows tonight's phase.
export function MoonLoader({ size = 32, label = 'Loading', className = '' }: { size?: number; label?: string; className?: string }) {
  const tonight = Math.round(moonPhase().f * 36) % 36;
  return <span role="status" aria-label={label} className={`moon-loader ${className}`} style={{ '--s': `${size}px`, '--tonight': tonight } as React.CSSProperties} />;
}

export function Logo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <radialGradient id="lg" cx=".38" cy=".34" r=".72"><stop offset="0" stopColor="var(--color-moon)" /><stop offset="1" stopColor="color-mix(in srgb, var(--color-moon) 55%, var(--color-ash))" /></radialGradient>
        <mask id="lm"><rect width="32" height="32" fill="#fff" /><circle cx="22.5" cy="13.5" r="10.5" fill="#000" /></mask>
      </defs>
      <circle cx="16" cy="16" r="12" fill="var(--color-ridge)" />
      <circle cx="16" cy="16" r="12" fill="url(#lg)" mask="url(#lm)" />
    </svg>
  );
}

// ── moon phase status glyph ─────────────────────────────────────────────
type Phase = 'new' | 'crescent' | 'running' | 'half' | 'full' | 'eclipse';
const threadPhase: Record<ThreadStatus, Phase> = { idle: 'full', running: 'running', needs_input: 'half', error: 'eclipse', archived: 'new' };
const taskPhase: Record<TaskStatus, Phase> = { backlog: 'new', queued: 'crescent', running: 'running', reviewing: 'running', testing: 'running', review: 'half', done: 'full', failed: 'eclipse' };
const phaseLabel: Record<Phase, string> = { new: 'not started', crescent: 'queued', running: 'working', half: 'needs you', full: 'done', eclipse: 'error' };

export function Moon({ thread, task, size = 10 }: { thread?: ThreadStatus; task?: TaskStatus; size?: number }) {
  const phase: Phase = thread ? threadPhase[thread] : task ? taskPhase[task] : 'new';
  const style: Record<Phase, React.CSSProperties> = {
    new: { boxShadow: 'inset 0 0 0 1.25px var(--color-ash)' },
    crescent: { boxShadow: `inset ${-size * 0.32}px 0 0 0 var(--color-dust), inset 0 0 0 1px var(--color-ash)` },
    running: { background: 'var(--color-tide)' },
    half: { background: 'linear-gradient(90deg, var(--color-halo) 50%, color-mix(in srgb, var(--color-halo) 18%, transparent) 50%)' },
    full: { background: 'radial-gradient(circle at 35% 35%, var(--color-moon), color-mix(in srgb, var(--color-moon) 75%, var(--color-ash)))' },
    eclipse: { boxShadow: 'inset 0 0 0 2px var(--color-oxide)', background: 'color-mix(in srgb, var(--color-oxide) 15%, transparent)' },
  };
  return <span role="img" aria-label={phaseLabel[phase]} data-tip={phaseLabel[phase]}
    className={`moon transition-[background,box-shadow] duration-500 ${phase === 'running' ? 'moon-running' : ''} ${phase === 'half' ? 'moon-needs' : ''}`}
    style={{ width: size, height: size, ...style[phase] }} />;
}

// ── controls ────────────────────────────────────────────────────────────
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' | 'halo'; size?: 'sm' | 'md' | 'lg' };
const tones = {
  primary: 'bg-moon text-basalt shadow-[inset_0_1px_0_rgb(255_255_255/.35),0_1px_2px_rgb(0_0_0/.25)] hover:shadow-[inset_0_1px_0_rgb(255_255_255/.35),0_6px_20px_-6px_color-mix(in_srgb,var(--color-moon)_40%,transparent)]',
  ghost: 'text-moon bg-ridge/70 shadow-[inset_0_1px_0_var(--surface-hi),0_1px_2px_rgb(0_0_0/.18)] hover:bg-ridge',
  danger: 'text-oxide bg-oxide/10 shadow-[inset_0_1px_0_var(--surface-hi)] hover:bg-oxide/16',
  halo: 'bg-halo text-[#1a1408] shadow-[inset_0_1px_0_rgb(255_255_255/.4)] hover:shadow-[inset_0_1px_0_rgb(255_255_255/.4),0_0_0_4px_color-mix(in_srgb,var(--color-halo)_22%,transparent)]',
};
const sizes = { sm: 'h-7 pointer-coarse:h-9 px-2.5 text-[13px] gap-1.5 rounded-md', md: 'h-8.5 pointer-coarse:h-10 px-3.5 text-sm gap-2 rounded-lg', lg: 'h-10 pointer-coarse:h-11 px-4.5 text-[15px] gap-2 rounded-lg' };
export function Button({ tone = 'ghost', size = 'md', className = '', ...p }: BtnProps) {
  return <button {...p} className={`press inline-flex items-center justify-center font-medium select-none whitespace-nowrap disabled:opacity-40 disabled:pointer-events-none ${tones[tone]} ${sizes[size]} ${className}`} />;
}

export function IconButton({ label, kbd, className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; kbd?: string }) {
  return <button aria-label={label} data-tip={label} data-kbd={kbd} {...p}
    className={`press inline-grid flex-none place-items-center size-8 pointer-coarse:size-10 rounded-lg text-dust hover:text-moon hover:bg-ridge disabled:opacity-40 aria-pressed:text-moon aria-pressed:bg-ridge ${className}`} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-grid pointer-coarse:hidden place-items-center min-w-5 h-5 px-1 rounded border border-line bg-crater font-mono text-[10.5px] text-dust shadow-[inset_0_-1px_0_var(--color-line)]">{children}</kbd>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`press relative inline-flex h-5 w-9 flex-none items-center rounded-full border pointer-coarse:before:absolute pointer-coarse:before:-inset-x-2 pointer-coarse:before:-inset-y-3 pointer-coarse:before:content-[''] ${checked ? 'bg-tide border-tide' : 'bg-ridge border-line'}`}>
      <span className={`absolute size-3.5 rounded-full bg-basalt shadow transition-transform duration-200 [transition-timing-function:var(--ease-out)] ${checked ? 'translate-x-[18px] bg-white' : 'translate-x-[2px] bg-dust'}`} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: NoInfer<T>; label: ReactNode; disabled?: boolean; tip?: string }[]; onChange(v: NoInfer<T>): void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="well inline-flex max-w-full h-8 pointer-coarse:h-10 rounded-lg p-0.5">
      {options.map(o => (
        <button key={o.value} role="radio" aria-checked={value === o.value} disabled={o.disabled} data-tip={o.tip} onClick={() => onChange(o.value)}
          className={`press min-w-0 px-2.5 rounded-md text-[12.5px] whitespace-nowrap overflow-hidden text-ellipsis disabled:opacity-40 ${value === o.value ? 'bg-ridge text-moon shadow-[inset_0_1px_0_var(--surface-hi)]' : 'text-dust hover:text-moon'}`}>{o.label}</button>
      ))}
    </div>
  );
}

export const inputCls = 'well w-full rounded-lg px-3 py-2 text-sm text-moon placeholder:text-ash transition-[border-color,box-shadow] duration-150 focus:border-tide/60 focus:shadow-[var(--well-shadow),0_0_0_3px_color-mix(in_srgb,var(--color-tide)_16%,transparent)] focus:outline-none';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <label className="block space-y-1.5"><span className="label">{label}</span>{children}{hint && <span className="block text-xs text-dust">{hint}</span>}</label>;
}

// Native <dialog> (focus trap, Escape, backdrop) with enter/exit motion; content stays mounted while it closes.
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    const d = ref.current!;
    if (open) { setMounted(true); if (!d.open) d.showModal(); }
    if (!open && d.open) { d.close(); const t = setTimeout(() => setMounted(false), 220); return () => clearTimeout(t); }
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}
      className={`sheet surface m-auto w-[calc(100%-24px)] ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-2xl text-moon p-0`}>
      {mounted && <div className="p-6 space-y-4">
        <h2 className="text-[17px] font-bold tracking-[-.01em]">{title}</h2>
        {children}
      </div>}
    </dialog>
  );
}

// Density zoom (`zoom` on <html>) makes a fixed element's top/left land at value × zoom on screen in some engines but
// not others, while getBoundingClientRect reports screen pixels. Measure the real ratio once per call instead of guessing.
export function fixedScale() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:100px;width:0;height:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const k = probe.getBoundingClientRect().top / 100;
  probe.remove();
  return k > 0 ? k : 1;
}

// Anchored popover menu: closes on outside click / Escape.
// Menus render into <body>, anchored to their parent element: a blurred or overflow-hidden ancestor (the thread
// header) would otherwise clip the panel and trap the click-away backdrop inside itself.
export function Menu({ open, onClose, children, align = 'right', side = 'bottom', className = '' }: { open: boolean; onClose(): void; children: ReactNode; align?: 'left' | 'right'; side?: 'top' | 'bottom'; className?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ style: CSSProperties; origin: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [open, onClose]);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const box = anchor.current?.parentElement?.getBoundingClientRect();
      if (!box) return;
      // Work in the fixed layer's own CSS pixels (see fixedScale).
      const z = fixedScale(), vw = innerWidth / z, vh = innerHeight / z;
      const r = { top: box.top / z, bottom: box.bottom / z, left: box.left / z, right: box.right / z };
      const gap = 6, below = vh - r.bottom - gap - 8, above = r.top - gap - 8;
      const up = side === 'top' ? above > 160 || above > below : below < 200 && above > below;
      const style: CSSProperties = { maxHeight: Math.max(120, up ? above : below) };
      if (up) style.bottom = vh - r.top + gap; else style.top = r.bottom + gap;
      // Keep the whole panel on screen (phones): shift it in from the edge it would overflow.
      const w = panel.current?.offsetWidth ?? 0;
      if (align === 'right') style.right = Math.max(8, Math.min(vw - r.right, vw - 8 - w));
      else style.left = Math.max(8, Math.min(r.left, vw - 8 - w));
      setPos({ style, origin: `${up ? 'bottom' : 'top'}_${align}` });
    };
    // Second pass once the panel exists, so its real width is known.
    const raf = requestAnimationFrame(place);
    place();
    addEventListener('resize', place);
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', place); };
  }, [open, align, side]);
  return <>
    <span ref={anchor} hidden />
    {open && pos && createPortal(<>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div ref={panel} role="menu" style={{ ...pos.style, ['--origin' as string]: pos.origin.replace('_', ' ') }}
        className={`pop fixed z-50 min-w-52 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl p-1 text-[13px] ${className}`}>{children}</div>
    </>, document.body)}
  </>;
}
export function MenuItem({ icon, children, onClick, tone, kbd }: { icon?: ReactNode; children: ReactNode; onClick(): void; tone?: 'danger'; kbd?: string }) {
  return <button role="menuitem" onClick={onClick} className={`press w-full flex items-center gap-2.5 px-2.5 py-1.5 pointer-coarse:py-2.5 rounded-lg text-left hover:bg-ridge ${tone === 'danger' ? 'text-oxide' : ''}`}>
    <span className="text-dust [&>svg]:size-[15px]">{icon}</span><span className="flex-1">{children}</span>{kbd && <span className="font-mono text-[10.5px] text-ash">{kbd}</span>}
  </button>;
}

export function Skeleton({ className = '' }: { className?: string }) { return <div className={`skeleton ${className}`} />; }

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="h-full grid place-items-center p-8 text-center animate-rise">
      <div className="max-w-sm space-y-4">
        {<div className="flex justify-center gap-2.5 opacity-80" aria-hidden>{(['new', 'crescent', 'half', 'full'] as const).map((p, i) => <span key={p} className="moon" style={{ width: 9, height: 9, opacity: .35 + i * .2, ...({ new: { boxShadow: 'inset 0 0 0 1.25px var(--color-ash)' }, crescent: { boxShadow: 'inset -3px 0 0 0 var(--color-dust), inset 0 0 0 1px var(--color-ash)' }, half: { background: 'linear-gradient(90deg, var(--color-dust) 50%, transparent 50%)', boxShadow: 'inset 0 0 0 1px var(--color-ash)' }, full: { background: 'var(--color-moon)' } } as const)[p] }} />)}</div>}
        <p className="text-moon font-bold text-[15px]">{title}</p>
        <div className="text-dust text-sm space-y-3">{children}</div>
      </div>
    </div>
  );
}

// ── tooltips: one floating bubble for every [data-tip] element ──────────
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; kbd?: string; x: number; y: number; below: boolean; vw: number } | null>(null);
  useEffect(() => {
    let timer: number | undefined, current: Element | null = null;
    const hide = () => { clearTimeout(timer); current = null; setTip(null); };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || !matchMedia('(hover: hover)').matches) return;
      const el = (e.target as Element).closest?.('[data-tip]');
      if (el === current) return;
      hide();
      if (!el || !el.getAttribute('data-tip')) return;
      current = el;
      timer = window.setTimeout(() => {
        const z = fixedScale(), b = el.getBoundingClientRect();
        const r = { top: b.top / z, bottom: b.bottom / z, left: b.left / z, width: b.width / z };
        const below = r.top < 44;
        setTip({ text: el.getAttribute('data-tip')!, kbd: el.getAttribute('data-kbd') ?? undefined, x: r.left + r.width / 2, y: below ? r.bottom + 7 : r.top - 7, below, vw: innerWidth / z });
      }, 380);
    };
    addEventListener('pointerover', over);
    addEventListener('pointerdown', hide, true);
    addEventListener('scroll', hide, true);
    return () => { removeEventListener('pointerover', over); removeEventListener('pointerdown', hide, true); removeEventListener('scroll', hide, true); };
  }, []);
  const el = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(120);
  useLayoutEffect(() => { if (el.current) setW(el.current.offsetWidth); }, [tip]);
  if (!tip) return null;
  // Keep the whole bubble on screen, however wide the text makes it.
  const x = Math.min(Math.max(tip.x, w / 2 + 8), tip.vw - w / 2 - 8);
  return <div ref={el} className="tip" style={{ left: x, top: tip.y, transform: `translate(-50%, ${tip.below ? '0' : '-100%'})` }}>{tip.text}{tip.kbd && <kbd>{tip.kbd}</kbd>}</div>;
}

// ── formatting ──────────────────────────────────────────────────────────
const SOURCES: Record<string, string> = {
  discord: 'Discord', telegram: 'Telegram', slack: 'Slack', whatsapp: 'WhatsApp', signal: 'Signal', matrix: 'Matrix',
  mattermost: 'Mattermost', email: 'Email', sms: 'SMS', cron: 'Scheduled', acp: 'IDE / Paseo', cli: 'CLI', tui: 'Terminal',
  desktop: 'Desktop', api_server: 'API', webhook: 'Webhook', claude_code: 'Claude Code', codex: 'Codex',
};
export const sourceLabel = (s?: string) => (s && SOURCES[s]) || (s ? s[0].toUpperCase() + s.slice(1) : 'Hermes');

export const ago = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
// A live "1:23" since a moment; re-renders itself once a second, nothing else does.
export function Elapsed({ since, className = '' }: { since: number; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const h = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(h); }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <span className={`tabular-nums ${className}`}>{s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}` : Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}
export const fmtTokens = (n?: number | null) => n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
export const fmtUsd = (n?: number | null) => n == null ? '—' : n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
export const fmtDuration = (ms?: number) => {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000), m = Math.floor(s / 60);
  return s < 60 ? `${s}s` : m < 10 ? `${m}m ${s % 60}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
