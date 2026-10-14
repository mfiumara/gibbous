import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLimits } from './limits.ts';

test('parseLimits keeps known logins with windows, drops empty or unknown ones, tolerates log lines before the JSON', () => {
  const out = 'some warning\n' + JSON.stringify([
    { provider: 'openai-codex', plan: 'Pro', details: ['You have 2 resets banked - use /usage reset', 'Other note'], unavailable: null, resets: 2, windows: [{ label: 'Weekly', usedPercent: 35, resetAt: 1, scope: 'account', detail: null, windowSeconds: 604800 }, { label: 'Current session', usedPercent: 5, resetAt: 2 }] },
    { provider: 'anthropic', plan: null, details: [], unavailable: null, windows: [] },
    { provider: 'mystery', plan: null, details: [], unavailable: null, windows: [{ label: 'x', usedPercent: 1 }] },
  ]);
  const r = parseLimits(out, 5);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { provider: 'openai-codex', label: 'Codex', plan: 'Pro', details: ['Other note'], unavailable: null, fetchedAt: 5, resets: 2,
    windows: [{ label: 'Weekly', usedPercent: 35, resetAt: 1, scope: 'account', detail: null, windowSeconds: 604800 }, { label: 'Current session', usedPercent: 5, resetAt: 2, scope: 'account', detail: null, windowSeconds: 18000 }] });
});
