import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { usedMethods, contractMethods } from './smoke.ts';

test('every Hermes method Gibbous calls is in the synced contract', () => {
  const used = usedMethods();
  assert.ok(used.includes('session.resume') && used.includes('groups.send'), 'scanner finds server and web calls');
  const have = contractMethods(path.resolve(import.meta.dirname, '../web/src/hermes/contract.ts'));
  assert.deepEqual(used.filter(m => !have.has(m)), []);
});
