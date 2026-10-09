import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileLines, safeJoin, slug, listFiles, currentBranch, changes, addWorktree } from './git.ts';
import { execFileSync } from 'node:child_process';

test('fileLines ignores the final newline', () => {
  assert.deepEqual(fileLines('print("hi")\n'), ['print("hi")']);
  assert.deepEqual(fileLines('a\n\n'), ['a', '']);
  assert.deepEqual(fileLines('no newline'), ['no newline']);
});

test('safeJoin refuses paths outside the workspace', () => {
  assert.equal(safeJoin('/w', 'a/b.txt'), '/w/a/b.txt');
  assert.throws(() => safeJoin('/w', '../etc/passwd'));
  assert.throws(() => safeJoin('/w', '/etc/passwd'));
  assert.throws(() => safeJoin('/w', '../w2/x'));
});

test('slug', () => assert.equal(slug('Add bye.sh that prints "Bye, $1"'), 'add-bye-sh-that-prints-bye-1'));

test('listFiles outside git skips hidden and unreadable folders instead of failing', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gib-ls-'));
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'a.ts'), '');
  fs.mkdirSync(path.join(d, '.hidden')); fs.writeFileSync(path.join(d, '.hidden', 'x'), '');
  fs.mkdirSync(path.join(d, 'locked')); fs.writeFileSync(path.join(d, 'locked', 'y'), ''); fs.chmodSync(path.join(d, 'locked'), 0);
  try { assert.deepEqual(await listFiles(d), ['src/a.ts']); }
  finally { fs.chmodSync(path.join(d, 'locked'), 0o700); fs.rmSync(d, { recursive: true, force: true }); }
});

test('a repository with no commits yet: branch, changes and a clear worktree error', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gib-empty-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
  fs.writeFileSync(path.join(d, 'a.txt'), 'hi\n');
  try {
    assert.equal(await currentBranch(d), 'main');
    assert.deepEqual((await changes(d)).map(c => c.path), ['a.txt']);
    await assert.rejects(addWorktree(d, path.join(d, '..', 'wt'), 'x', 'main'), /no commits yet/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
