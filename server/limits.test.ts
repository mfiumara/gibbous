import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLimits } from './limits.ts';

test('parseLimits keeps known logins with windows, drops empty or unknown ones, tolerates log lines before the JSON', () => {
  const out = 'some warning\n' + JSON.stringify([
    { provider: 'openai-codex', plan: 'Pro', details: ['2 resets banked'], unavailable: null, windows: [{ label: 'Weekly', usedPercent: 35, resetAt: 1, scope: 'account', detail: null }] },
    { provider: 'anthropic', plan: null, details: [], unavailable: null, windows: [] },
    { provider: 'mystery', plan: null, details: [], unavailable: null, windows: [{ label: 'x', usedPercent: 1 }] },
  ]);
  const r = parseLimits(out, 5);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { provider: 'openai-codex', label: 'Codex', plan: 'Pro', details: ['2 resets banked'], unavailable: null, fetchedAt: 5,
    windows: [{ label: 'Weekly', usedPercent: 35, resetAt: 1, scope: 'account', detail: null }] });
});
