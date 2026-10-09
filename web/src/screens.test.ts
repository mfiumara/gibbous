import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depth, parentOf, transitionFor, underlay } from './screens.ts';
import { progress, settle } from './drawer.ts';
import type { Route } from './ui';

const home: Route = { name: 'home' }, inbox: Route = { name: 'inbox' };
const t1: Route = { name: 'thread', id: 'a' }, t2: Route = { name: 'thread', id: 'b' };
const board: Route = { name: 'board', projectId: 'p' };
const list: Route = { name: 'settings', tab: '' }, general: Route = { name: 'settings', tab: 'general' };

test('depth: lists are 0, things opened from them are 1', () => {
  assert.deepEqual([home, inbox, list, { name: 'rooms' } as Route, { name: 'home', projectId: 'p' } as Route].map(depth), [0, 0, 0, 0, 0]);
  assert.deepEqual([t1, board, general, { name: 'rooms', id: 'r' } as Route].map(depth), [1, 1, 1, 1]);
});

test('back goes to the parent list; top-level screens have none (the edge opens the drawer there)', () => {
  assert.equal(parentOf(t1), '/');
  assert.equal(parentOf(board), '/');
  assert.equal(parentOf(general), '/settings');
  assert.equal(parentOf({ name: 'rooms', id: 'r' }), '/rooms');
  assert.equal(parentOf(home), null);
  assert.equal(parentOf(inbox), null);
  assert.equal(parentOf(list), null);
});

test('phones push deeper and pop back; wide layouts fade; same-kind switches are instant', () => {
  assert.equal(transitionFor(home, t1, true), 'push');
  assert.equal(transitionFor(t1, home, true), 'pop');
  assert.equal(transitionFor(list, general, true), 'push');
  assert.equal(transitionFor(general, list, true), 'pop');
  assert.equal(transitionFor(home, t1, false), 'fade');
  assert.equal(transitionFor(t1, t2, false), null);   // j/k on the Mac
  assert.equal(transitionFor(t1, t2, true), null);
  assert.equal(transitionFor(t1, board, true), 'fade');
  assert.equal(transitionFor(home, inbox, false), 'fade');
  assert.equal(transitionFor(home, { name: 'home' }, true), null);
});

test('back-swipe underlay trails the screen and never overlaps it', () => {
  const w = 390;
  assert.deepEqual(underlay(0, w), { x: -117, clipRight: 273, dim: 0.25 });
  const end = underlay(1, w);
  assert.ok(end.x === 0 && end.clipRight === 0); assert.equal(end.dim, 0);
  for (const p of [0.1, 0.37, 0.5, 0.9]) {
    const u = underlay(p, w);
    // The underlay's visible right edge (its offset + unclipped width) is exactly the moving screen's left edge.
    assert.ok(Math.abs(u.x + (w - u.clipRight) - p * w) < 1e-9);
  }
});

test('back-swipe release reuses the drawer settle: halfway or a flick goes back', () => {
  const w = 390;
  assert.equal(progress(false, 195, w), 0.5);
  assert.equal(settle(false, 250, 0.1, w), true);
  assert.equal(settle(false, 120, 0.1, w), false);   // springs back
  assert.equal(settle(false, 40, 0.9, w), true);     // short flick
  assert.equal(settle(false, 300, -0.9, w), false);  // flicked back
});
