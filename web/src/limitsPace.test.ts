import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pace } from './limitsPace.ts';

const H = 3600_000, WEEK = 7 * 24 * 3600;
test('pace: under the clock is reserve, over it is deficit with a run-out time', () => {
  const now = 1e12;
  // half the week gone, 35% used → 15% in reserve, lasts to the reset
  assert.deepEqual(pace(35, now + 3.5 * 24 * H, WEEK, now), { delta: 15, runsOutIn: null });
  // a quarter gone, 50% used → 25% in deficit, runs out in another 1.75 days
  const p = pace(50, now + 5.25 * 24 * H, WEEK, now)!;
  assert.equal(Math.round(p.delta), -25); assert.equal(Math.round(p.runsOutIn! / H), 42);
  assert.equal(pace(10, now + WEEK * 1000, WEEK, now), null, 'just started');
  assert.equal(pace(null, now, WEEK, now), null);
});
