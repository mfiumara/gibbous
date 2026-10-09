import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from './diff.ts';

test('git diff with a removed line that looks like a header', () => {
  const d = ['diff --git a/x.md b/x.md', 'index 1..2 100644', '--- a/x.md', '+++ b/x.md', '@@ -1,3 +1,3 @@', ' keep', '--- old rule', '+++ new rule', ' end'].join('\n');
  const [f] = parseDiff(d);
  assert.equal(f.name, 'x.md');
  assert.deepEqual(f.lines.map(l => l.t), ['@', ' ', '-', '+', ' ']);
  assert.equal(f.lines[2].text, '-- old rule');
  assert.equal(f.lines[3].b, 2);
});

test('hermes inline diff after ANSI stripping, and multiple files', () => {
  const d = '  ┊ review diff\na//tmp/a.txt → b//tmp/a.txt\n@@ -1 +1 @@\n-hello\n+hello world';
  const [f] = parseDiff(d);
  assert.equal(f.name, '/tmp/a.txt');
  assert.deepEqual(f.lines.map(l => l.t), ['@', '-', '+']);
  const two = parseDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\nnew file mode 100644\n--- /dev/null\n+++ b/b\n@@ -0,0 +1 @@\n+z');
  assert.deepEqual(two.map(f => f.name), ['a', 'b']);
});
