import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdOf } from './build.ts';

test('build id is the hashed entry script of index.html', () => {
  assert.equal(buildIdOf('<link rel="modulepreload" href="/assets/x.js"><script type="module" crossorigin src="/assets/index-CHcb-rKK.js"></script>'), '/assets/index-CHcb-rKK.js');
  assert.equal(buildIdOf('<script type="module" src="/src/main.tsx"></script>'), null); // vite dev: no build to compare
  assert.equal(buildIdOf(''), null);
});
