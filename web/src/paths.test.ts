import test from 'node:test';
import assert from 'node:assert/strict';
import { baseName, dirPrefix, tilde, thisMachine } from './paths.ts';

test('paths: POSIX and Windows separators', () => {
  assert.equal(baseName('/Users/ada/Downloads/a b.png'), 'a b.png');
  assert.equal(baseName('C:\\Users\\ada\\Downloads\\a.png'), 'a.png');
  assert.equal(baseName('/Users/ada/repo/'), 'repo');
  assert.equal(baseName('C:\\'), 'C:');
  assert.equal(dirPrefix('src/app/x.ts'), 'src/app/');
  assert.equal(dirPrefix('src\\app\\x.ts'), 'src\\app\\');
  assert.equal(dirPrefix('x.ts'), '');
  assert.equal(tilde('/home/ada/code', '/home/ada'), '~/code');
  assert.equal(tilde('C:\\Users\\ada\\code', 'C:\\Users\\ada'), '~\\code');
  assert.equal(tilde('/home/adam', '/home/ada'), '/home/adam');
  assert.equal(thisMachine(), 'this Mac');
  assert.equal(thisMachine({ machine: 'PC' }), 'this PC');
});
