import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from './layout.ts';

const t = (id: string, deps: string[] = [], status = 'backlog') => ({ id, deps, status } as any);
test('layers follow the longest dependency chain; critical path skips finished work', () => {
  const tasks = [t('api', [], 'done'), t('impl', ['api']), t('docs', ['api']), t('ship', ['impl', 'docs']), t('extra', ['impl'])];
  const { pos, critical } = layout(tasks);
  assert.equal(pos.get('api')!.x < pos.get('impl')!.x, true);
  assert.equal(pos.get('impl')!.x, pos.get('docs')!.x);
  assert.equal(pos.get('ship')!.x > pos.get('impl')!.x, true);
  assert.ok(critical.has('impl') && critical.has('ship'));
  assert.ok(!critical.has('api'));
});
test('a dependency cycle does not hang', () => {
  const { pos } = layout([t('a', ['b']), t('b', ['a'])]);
  assert.equal(pos.size, 2);
});
