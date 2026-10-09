import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progress, settle, axis } from './drawer.ts';

test('drawer follows the finger and clamps', () => {
  assert.equal(progress(false, 138, 276), 0.5);
  assert.equal(progress(false, -40, 276), 0);
  assert.equal(progress(true, -69, 276), 0.75);
  assert.equal(progress(true, 50, 276), 1);
});

test('release: flicks decide, otherwise the nearer side', () => {
  assert.equal(settle(false, 30, 0.8, 276), true);    // short fast flick opens
  assert.equal(settle(false, 200, -0.8, 276), false); // flicked back closes
  assert.equal(settle(false, 160, 0.1, 276), true);   // past halfway, slow
  assert.equal(settle(false, 100, 0.1, 276), false);  // not far enough
  assert.equal(settle(true, -100, -0.1, 276), true);  // dragged a bit, stays open
  assert.equal(settle(true, -40, -0.9, 276), false);  // flick closed
});

test('axis lock waits for intent and prefers vertical on diagonals', () => {
  assert.equal(axis(4, 3), null);
  assert.equal(axis(20, 4), 'x');
  assert.equal(axis(12, 11), 'y');
  assert.equal(axis(2, 30), 'y');
});
