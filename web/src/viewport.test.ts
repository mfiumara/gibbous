import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleBox, keyboardInset } from './viewport.ts';

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

test('visible box follows a panned visual viewport (iOS scrolls the field into view)', () => {
  assert.deepEqual(visibleBox({ ...base, vvHeight: 508, vvOffsetTop: 0 }), { top: 0, height: 508 });
  // Panned all the way: keyboardInset says 0, but the visible area is still only 508px, starting at 336.
  assert.equal(keyboardInset({ ...base, vvHeight: 508, vvOffsetTop: 336 }), 0);
  assert.deepEqual(visibleBox({ ...base, vvHeight: 508, vvOffsetTop: 336 }), { top: 336, height: 508 });
  assert.equal(visibleBox(base), null);
  assert.equal(visibleBox({ ...base, vvHeight: 508, field: false }), null);
});
