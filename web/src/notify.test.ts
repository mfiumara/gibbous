import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showsTarget } from './notify.ts';

test('a reply toast is skipped only on its own thread', () => {
  assert.equal(showsTarget('/#/t/th_1', '#/t/th_1'), true);
  assert.equal(showsTarget('/#/t/th_1', '#/t/th_1?panel=files'), true);
  assert.equal(showsTarget('/#/t/th_1', '#/t/th_12'), false);
  assert.equal(showsTarget('/#/t/th_1', '#/'), false);
  assert.equal(showsTarget('/', '#/'), false);
  assert.equal(showsTarget(undefined, '#/t/th_1'), false);
});
