import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle } from './titles.ts';

test('cleanTitle accepts short names and normalizes them', () => {
  assert.equal(cleanTitle('Subscription model picker'), 'Subscription model picker');
  assert.equal(cleanTitle('"disk cleanup."'), 'Disk cleanup');
  assert.equal(cleanTitle('Title: Fix mobile layout'), 'Fix mobile layout');
  assert.equal(cleanTitle('{"title": "Explain weird PCB colors"}'), 'Explain weird PCB colors');
  assert.equal(cleanTitle('```\nGrok model setup\n```'), 'Grok model setup');
});

test('cleanTitle rejects answers and empty output', () => {
  assert.equal(cleanTitle(''), undefined);
  assert.equal(cleanTitle('Sure! I would be happy to help you clean up your disk today'), undefined);
});
