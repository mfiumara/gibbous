import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glance as parts, fmtCount, fmtPct, buckets, niceMax, seriesOf, type UsageReport, type UsageDay } from './usage.ts';

const glance = (r: UsageReport | null) => { const g = parts(r); return g && [g.tokens, g.model, g.cost].filter(Boolean).join(' · '); };

test('fmtCount keeps three significant digits', () => {
  assert.equal(fmtCount(950), '950');
  assert.equal(fmtCount(4_200_000), '4.2M');
  assert.equal(fmtCount(12_340), '12.3k');
  assert.equal(fmtCount(282_421_478), '282M');
  assert.equal(fmtCount(1_250_000_000), '1.25B');
  assert.equal(fmtCount(3_000_000), '3M');
  assert.equal(fmtPct(0.958), '96%');
  assert.equal(fmtPct(0.001), '<1%');
});

const day = (d: string, byModel: Record<string, number>, cost: number | null = null): UsageDay =>
  ({ day: d, tokens: Object.values(byModel).reduce((a, b) => a + b, 0), costUsd: cost, sessions: 1, byModel });

test('buckets fold small models into other and long ranges into weeks', () => {
  const b = buckets([day('2030-01-01', { a: 5, b: 2, c: 1 }, 0.5)], ['a', 'b'])[0];
  assert.deepEqual(b.parts, { a: 5, b: 2, other: 1 });
  assert.equal(b.costUsd, 0.5);
  const many = Array.from({ length: 140 }, (_, i) => day(`d${String(i).padStart(3, '0')}`, { a: 1 }));
  const w = buckets(many, ['a']);
  assert.equal(w.length, 20);
  assert.equal(w[0].tokens, 7);
  assert.equal(w[0].end, 'd006');
});

test('niceMax rounds the axis up', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(7_300_000), 10_000_000);
  assert.equal(niceMax(2_100), 2_500);
  assert.equal(niceMax(180), 200);
});

test('glance names the top model and the API-equivalent cost, or hides', () => {
  const r = (tokens: number, top: number, cost: number | null) => ({ totals: { tokens, costUsd: cost }, models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', tokens: top }] }) as unknown as UsageReport;
  assert.equal(glance(r(4_200_000, 3_000_000, 38.2)), 'This week: 4.2M tokens · mostly Opus 5.5 · ~$38.20 API-equivalent');
  assert.equal(glance(r(4_200_000, 1_000_000, null)), 'This week: 4.2M tokens · led by Opus 5.5');
  assert.equal(glance(r(0, 0, null)), null);
  assert.equal(glance(null), null);
  assert.deepEqual(seriesOf([{ id: 'a', tokens: 3 }, { id: 'b', tokens: 0 }]), ['a']);
});
