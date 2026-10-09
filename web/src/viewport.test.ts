import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardInset } from './viewport.ts';

const base = { innerHeight: 844, vvHeight: 844, vvOffsetTop: 0, scale: 1, field: true };

test('no keyboard, no inset', () => {
  assert.equal(keyboardInset(base), 0);
});

test('keyboard covering the bottom of the layout viewport', () => {
  assert.equal(keyboardInset({ ...base, vvHeight: 508 }), 336);
  // iOS also scrolled the layout viewport up: the covered part below the visual viewport shrinks by that much.
  assert.equal(keyboardInset({ ...base, vvHeight: 508, vvOffsetTop: 120 }), 216);
  assert.equal(keyboardInset({ ...base, vvHeight: 508.4 }), 336);
});

test('pinch-zoom or no focused field never counts as a keyboard', () => {
  assert.equal(keyboardInset({ ...base, vvHeight: 400, scale: 2 }), 0);
  assert.equal(keyboardInset({ ...base, vvHeight: 508, field: false }), 0);
  assert.equal(keyboardInset({ ...base, vvHeight: 843.5 }), 0); // sub-pixel rounding
});
