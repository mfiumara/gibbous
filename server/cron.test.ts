import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun, describeCron } from './cron.ts';

const at = (s: string) => new Date(s);
test('weekday mornings', () => {
  const m = parseCron('0 9 * * 1-5');
  assert.equal(m(at('2026-10-09T09:00:00')), true);   // Friday
  assert.equal(m(at('2026-10-10T09:00:00')), false);  // Saturday
  assert.equal(m(at('2026-10-09T09:01:00')), false);
});
test('steps, lists and friendly forms', () => {
  assert.equal(parseCron('*/15 * * * *')(at('2026-10-09T10:45:00')), true);
  assert.equal(parseCron('*/15 * * * *')(at('2026-10-09T10:46:00')), false);
  assert.equal(parseCron('0 8,20 * * *')(at('2026-10-09T20:00:00')), true);
  assert.equal(parseCron('every 2h')(at('2026-10-09T14:00:00')), true);
  assert.equal(parseCron('every 2h')(at('2026-10-09T15:00:00')), false);
  assert.equal(parseCron('0 0 * * 7')(at('2026-10-11T00:00:00')), true); // 7 = Sunday
});
test('nextRun and validation', () => {
  assert.equal(new Date(nextRun('30 6 * * *', at('2026-10-09T07:00:00'))!).toISOString(), at('2026-10-10T06:30:00').toISOString());
  assert.throws(() => parseCron('61 * * * *'));
  assert.throws(() => parseCron('* * *'));
});

test('cron in plain words', () => {
  assert.equal(describeCron('30 9 * * *'), 'Every day at 09:30');
  assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00');
  assert.equal(describeCron('0 18 * * 5'), 'Fridays at 18:00');
  assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(describeCron('0 */6 * * *'), 'Every 6 hours');
  assert.equal(describeCron('55 23 1 * *'), 'Monthly on day 1 at 23:55');
  assert.equal(describeCron('every 15m'), 'Every 15m');
  assert.equal(describeCron('5 4 * 2 1'), '5 4 * 2 1');   // unusual: shown as is
});
