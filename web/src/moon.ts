// The Moon as seen from where you are: phase, how it sits in your sky, and lunar eclipses (astronomy-engine,
// arc-minute accurate). Pure functions plus a small cached location; SkyMoon draws, the UI reads.
import { Body, Equator, Illumination, MoonPhase, Observer, SiderealTime, RotationAxis, SearchLunarEclipse, NextLunarEclipse, SearchMoonPhase, Horizon, MakeTime } from 'astronomy-engine';

export interface Loc { lat: number; lon: number; src: 'device' | 'ip'; at: number }
const LOC_KEY = 'gibbous.location';
const rad = Math.PI / 180;

export function savedLoc(): Loc | null {
  try { const l = JSON.parse(localStorage.getItem(LOC_KEY) ?? 'null'); return l && Number.isFinite(l.lat) && Number.isFinite(l.lon) ? l : null; } catch { return null; }
}

// This device's position (asked once; falls back to a city-level IP lookup, e.g. inside Gibbous.app, which has
// no location entitlement). Rounded to ~1 km: the Moon's tilt changes over hundreds of km, not metres.
export async function locate(): Promise<Loc | null> {
  const old = savedLoc();
  if (old && Date.now() - old.at < 3 * 86_400_000) return old;
  const keep = (lat: number, lon: number, src: Loc['src']) => {
    const l: Loc = { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, src, at: Date.now() };
    localStorage.setItem(LOC_KEY, JSON.stringify(l));
    return l;
  };
  const denied = await navigator.permissions?.query({ name: 'geolocation' as PermissionName }).then(p => p.state === 'denied', () => false);
  if (!denied && navigator.geolocation) {
    const pos = await new Promise<GeolocationPosition | null>(res => navigator.geolocation.getCurrentPosition(res, () => res(null), { timeout: 10_000, maximumAge: 86_400_000, enableHighAccuracy: false }));
    if (pos) return keep(pos.coords.latitude, pos.coords.longitude, 'device');
  }
  try {
    const r = await fetch('https://ipapi.co/json/', { referrerPolicy: 'no-referrer' }).then(r => r.json());
    if (Number.isFinite(r.latitude)) return keep(r.latitude, r.longitude, 'ip');
  } catch { /* offline: keep the old one, or draw north-up */ }
  return old;
}

const phaseName = (f: number) => f < .03 || f > .97 ? 'New moon' : f < .22 ? 'Waxing crescent' : f < .28 ? 'First quarter' : f < .47 ? 'Waxing gibbous'
  : f < .53 ? 'Full moon' : f < .72 ? 'Waning gibbous' : f < .78 ? 'Last quarter' : 'Waning crescent';

// Debug/preview: localStorage['gibbous.moonAt'] = an ISO date pins "now" (e.g. a past blood moon).
export const moonNow = () => { const p = globalThis.localStorage?.getItem('gibbous.moonAt'); const t = p ? Date.parse(p) : NaN; return Number.isFinite(t) ? t : Date.now(); };

// 0 new · .25 first quarter · .5 full · .75 last quarter; lit = illuminated fraction.
export function moonPhase(at = moonNow()) {
  const f = MoonPhase(new Date(at)) / 360;
  const lit = Illumination(Body.Moon, new Date(at)).phase_fraction;
  return { f, lit, name: phaseName(f) };
}

// Position angle (east of north) of the direction from point 1 toward point 2 on the sky.
function pa(ra1: number, dec1: number, ra2: number, dec2: number) {
  const d = (ra2 - ra1) * 15 * rad;
  return Math.atan2(Math.cos(dec2 * rad) * Math.sin(d), Math.sin(dec2 * rad) * Math.cos(dec1 * rad) - Math.cos(dec2 * rad) * Math.sin(dec1 * rad) * Math.cos(d));
}

export type EclipseKind = 'penumbral' | 'partial' | 'total';
export interface Eclipse { kind: EclipseKind; peak: Date; start: Date; end: Date; visible: boolean; altitude: number | null }
export const eclipseLabel = (k: EclipseKind) => k === 'total' ? 'Blood moon (total lunar eclipse)' : k === 'partial' ? 'Partial lunar eclipse' : 'Penumbral eclipse (faint darkening)';

function toEclipse(e: ReturnType<typeof SearchLunarEclipse>, loc: Loc | null): Eclipse {
  const peak = e.peak.date, alt = loc ? (() => { const o = new Observer(loc.lat, loc.lon, 0), q = Equator(Body.Moon, peak, o, true, true); return Horizon(peak, o, q.ra, q.dec, 'normal').altitude; })() : null;
  return { kind: e.kind as EclipseKind, peak, start: new Date(+peak - e.sd_penum * 60_000), end: new Date(+peak + e.sd_penum * 60_000), visible: alt == null || alt > 0, altitude: alt };
}

export function upcomingEclipses(n = 4, loc = savedLoc(), at = moonNow()): Eclipse[] {
  const out: Eclipse[] = [];
  let e = SearchLunarEclipse(new Date(at - 6 * 3_600_000));
  while (out.length < n) {
    if (+e.peak.date + e.sd_penum * 60_000 > at) out.push(toEclipse(e, loc));
    e = NextLunarEclipse(e.peak);
  }
  return out;
}

// How dark and how red the Moon is right now (0..1 each), from the eclipse contacts. Uniform over the disc:
// ponytail: the umbra's moving bite isn't drawn, only its overall effect.
export function eclipseShade(at = moonNow()) {
  const e = SearchLunarEclipse(new Date(at - 6 * 3_600_000));
  const t = Math.abs(at - +e.peak.date) / 60_000;
  if (t >= e.sd_penum) return { shadow: 0, blood: 0, kind: null as EclipseKind | null };
  if (t < e.sd_total) return { shadow: .7, blood: 1, kind: e.kind as EclipseKind };
  if (t < e.sd_partial) { const p = 1 - (t - e.sd_total) / (e.sd_partial - e.sd_total); return { shadow: .7 * p * e.obscuration, blood: p * e.obscuration, kind: e.kind as EclipseKind }; }
  return { shadow: .25 * (1 - (t - e.sd_partial) / (e.sd_penum - e.sd_partial)), blood: 0, kind: e.kind as EclipseKind };
}

// How the Moon sits in your sky. `rot`: lunar north's angle on screen, counter-clockwise from straight up
// (your zenith; celestial north without a location). `sun`: sunlight direction in the Moon's own frame
// (x right, y lunar north, z toward you), so the phase is lit from the right side whatever the tilt.
export function moonSky(at = moonNow(), loc = savedLoc()) {
  const date = new Date(at), o = new Observer(loc?.lat ?? 0, loc?.lon ?? 0, 0);
  const m = Equator(Body.Moon, date, o, true, true), s = Equator(Body.Sun, date, o, true, true), ax = RotationAxis(Body.Moon, date);
  const chi = pa(m.ra, m.dec, s.ra, s.dec);          // bright limb, toward the Sun
  const P = pa(m.ra, m.dec, ax.ra, ax.dec);          // lunar north pole
  let q = 0;                                         // parallactic angle: where your zenith is, east of north
  if (loc) {
    const H = ((SiderealTime(date) + loc.lon / 15 - m.ra) * 15) * rad, phi = loc.lat * rad, d = m.dec * rad;
    q = Math.atan2(Math.sin(H), Math.tan(phi) * Math.cos(d) - Math.sin(d) * Math.cos(H));
  }
  const i = Illumination(Body.Moon, date).phase_angle * rad, a = chi - P;
  // East is on the left when you face the sky, so position angles turn counter-clockwise on screen.
  return { rot: P - q, sun: [-Math.sin(a) * Math.sin(i), Math.cos(a) * Math.sin(i), Math.cos(i)] as [number, number, number], ...eclipseShade(at), ...moonPhase(at) };
}

export function nextFullMoon(at = moonNow()) { return SearchMoonPhase(180, MakeTime(new Date(at)), 40)?.date ?? null; }
