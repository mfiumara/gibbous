import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragRegion, isRoute, combo, alreadyHandled } from './macshell.ts';

test('drag regions: controls never drag, "self" regions only on the element itself', () => {
  assert.equal(dragRegion('', false, false), true);       // header title text
  assert.equal(dragRegion('', false, true), false);       // a button in the header
  assert.equal(dragRegion('self', true, false), true);    // main's title-bar padding
  assert.equal(dragRegion('self', false, false), false);  // text deep inside main
});

test('routes saved for relaunch match what /login?next= accepts', () => {
  assert.equal(isRoute('#/t/abc-123'), true);
  assert.equal(isRoute('#/search?q=a%20b&x=1'), true);
  assert.equal(isRoute('#/'), true);
  assert.equal(isRoute(''), false);
  assert.equal(isRoute('#/t/<script>'), false);
  assert.equal(isRoute('https://example.com'), false);
});

test('a menu command is dropped when the page just handled its key', () => {
  const last = { combo: combo({ key: 'N', shiftKey: false }), at: 1000 };
  assert.equal(alreadyHandled('new', last, 1200), true);
  assert.equal(alreadyHandled('new', last, 1800), false);   // a later menu click still works
  assert.equal(alreadyHandled('palette', last, 1200), false);
  assert.equal(alreadyHandled('approve', { combo: combo({ key: 'A', shiftKey: true }), at: 0 }, 10), true);
  assert.equal(alreadyHandled('settings', last, 1200), false); // no in-page key: always runs
  assert.equal(alreadyHandled('new', undefined, 0), false);
});
