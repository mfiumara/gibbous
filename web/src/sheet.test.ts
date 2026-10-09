import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offset, dismiss, decide } from './sheet.ts';

test('sheet follows the finger down and resists upward', () => {
  assert.equal(offset(120), 120);
  assert.equal(offset(0), 0);
  assert.equal(offset(-40), -10);
  assert.equal(offset(-400), -24);
});

test('release: flicks decide, otherwise 30% of the height', () => {
  assert.equal(dismiss(20, 0.9, 400), true);    // short fast flick down closes
  assert.equal(dismiss(200, -0.9, 400), false); // flicked back up stays
  assert.equal(dismiss(130, 0.1, 400), true);   // past 30%, slow
  assert.equal(dismiss(100, 0.1, 400), false);  // not far enough: springs back
  assert.equal(dismiss(100, 0.1, 0), false);
});

test('only a downward move from the list top drags the sheet', () => {
  assert.equal(decide(2, 3, true), null);
  assert.equal(decide(1, 20, true), 'drag');
  assert.equal(decide(1, 20, false), 'scroll');  // list scrolled: scroll it back first
  assert.equal(decide(0, -20, true), 'scroll');  // upward scrolls the list
  assert.equal(decide(30, 12, true), 'scroll');  // sideways
});
