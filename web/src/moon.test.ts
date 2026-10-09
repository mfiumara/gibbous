// Moon geometry against known sky events: `node --test web/src/moon.test.ts`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moonSky, upcomingEclipses, eclipseShade, type Loc } from './moon.ts';

const ams: Loc = { lat: 52.37, lon: 4.9, src: 'device', at: 0 };
const deg = (r: number) => ((r * 180 / Math.PI) % 360 + 540) % 360 - 180;
// Screen direction (CCW from up) of the lit limb.
const litAngle = (m: ReturnType<typeof moonSky>) => deg(m.rot + Math.atan2(-m.sun[0], m.sun[1]));

test('evening crescent in Amsterdam is lit low on the right, toward the set Sun', () => {
  const m = moonSky(Date.parse('2026-02-20T18:30:00Z'), ams);   // ~3-day-old Moon, west after sunset
  assert.ok(m.f > .05 && m.f < .2, `phase ${m.f}`);
  const a = litAngle(m);
  assert.ok(a < -90 && a > -170, `lit limb at ${a}° (want lower right)`);
});

test('the same Moon seen from Sydney is flipped, lit on the left', () => {
  const m = moonSky(Date.parse('2026-02-20T09:00:00Z'), { lat: -33.87, lon: 151.21, src: 'device', at: 0 });
  assert.ok(litAngle(m) > 0, `lit limb at ${litAngle(m)}°`);
});

test('total lunar eclipse of 2026-03-03: a blood moon at peak, listed beforehand', () => {
  const next = upcomingEclipses(2, ams, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(next[0].kind, 'total');
  assert.equal(next[0].peak.toISOString().slice(0, 10), '2026-03-03');
  assert.equal(next[0].visible, false);                         // peak ~11:33 UTC: daytime in Amsterdam
  const s = eclipseShade(+next[0].peak);
  assert.equal(s.kind, 'total'); assert.equal(s.blood, 1);
  assert.equal(eclipseShade(+next[0].peak + 6 * 3_600_000).blood, 0);
});
