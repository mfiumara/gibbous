import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPlanJson, reviewPrompt } from './playbooks.ts';

test('plan JSON survives code fences and braces inside prompts', () => {
  const reply = 'Summary.\n\n```json\n{"tasks":[{"key":"a","title":"t","prompt":"calc.py:\\n\\n```python\\ndef f(): return {\\"x\\": 1}\\n```\\nAdd mul.","deps":[]}]}\n```\nDone.';
  const j = extractPlanJson(reply) as any;
  assert.equal(j.tasks.length, 1);
  assert.match(j.tasks[0].prompt, /```python/);
});
test('plan JSON errors are explicit', () => {
  assert.throws(() => extractPlanJson('no plan here'), /no task list/);
  assert.throws(() => extractPlanJson('```json\n{"tasks":[{"key":"a"'), /incomplete/);
});
test('review prompt lists the playbook checks', () => {
  const p = reviewPrompt({ title: 'T', prompt: 'P' } as any, 'main', { reviewPasses: ['security', 'tests'] } as any);
  assert.match(p, /Security:/); assert.match(p, /Tests:/); assert.doesNotMatch(p, /Correctness:/); assert.match(p, /git diff main/);
});
