import test from 'node:test';
import assert from 'node:assert/strict';
import { setupStep, needsSetup, appendLog, moreKeyProviders, pickModel, KEYS } from './onboarding.ts';

test('setupStep walks install → starting → model → done', () => {
  assert.equal(setupStep(undefined, false), 'starting');
  assert.equal(setupStep({ installed: false }, false), 'install');
  assert.equal(setupStep({ installed: true }, false), 'starting');
  assert.equal(setupStep({ installed: true, error: 'serve died' }, false), 'starting');
  assert.equal(setupStep({ installed: true, configured: false }, true), 'model');
  assert.equal(setupStep({ installed: true, configured: null }, true), 'done'); // unknown: never block
  assert.equal(setupStep({ installed: true, configured: true }, true), 'done');
  assert.equal(setupStep({ installed: false }, true), 'done'); // a backend answers even though no binary was found
});

test('needsSetup only when something definitely needs doing', () => {
  assert.equal(needsSetup(undefined, false), false);
  assert.equal(needsSetup({ installed: false }, false), true);
  assert.equal(needsSetup({ installed: true }, false), false); // restarting: the banner, not setup
  assert.equal(needsSetup({ installed: true, configured: false }, true), true);
  assert.equal(needsSetup({ installed: true, configured: null }, true), false);
  assert.equal(needsSetup({ installed: true, configured: true, freeTier: true }, true), false);
});

test('appendLog keeps the newest lines', () => {
  let l: string[] = [];
  for (let i = 0; i < 7; i++) l = appendLog(l, `l${i}`, false, 5);
  assert.deepEqual(l, ['l2', 'l3', 'l4', 'l5', 'l6']);
  assert.deepEqual(appendLog(['a', '10%'], '60%', true), ['a', '60%']);
});

test('moreKeyProviders: API-key providers not already featured, A–Z, once each', () => {
  const r = moreKeyProviders([
    { slug: 'zai', name: 'Z.AI / GLM', auth_type: 'api_key', key_env: 'GLM_API_KEY' },
    { slug: 'anthropic', name: 'Anthropic', auth_type: 'api_key', key_env: 'ANTHROPIC_API_KEY' },
    { slug: 'deepseek', name: 'DeepSeek', auth_type: 'api_key', key_env: 'DEEPSEEK_API_KEY' },
    { slug: 'deepseek', name: 'DeepSeek', auth_type: 'api_key', key_env: 'DEEPSEEK_API_KEY' },
    { slug: 'nous', name: 'Nous Portal', auth_type: 'oauth_device_code', key_env: '' },
    { slug: 'custom', name: 'custom', auth_type: 'api_key', key_env: '' },
  ]);
  assert.deepEqual(r.map(c => c.id), ['deepseek', 'zai']);
  assert.ok(KEYS.every(k => k.kind === 'key' && /_API_KEY$/.test(k.envKey)));
});

test('pickModel prefers the recommendation, then the current model', () => {
  assert.equal(pickModel(['a', 'b'], 'b', 'a'), 'b');
  assert.equal(pickModel(['a', 'b'], 'x', 'b'), 'b');
  assert.equal(pickModel(['a', 'b']), 'a');
  assert.equal(pickModel([], 'x'), 'x');
  assert.equal(pickModel([]), '');
});
