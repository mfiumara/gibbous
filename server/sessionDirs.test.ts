import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderOf } from './sessionDirs.ts';

test('folders map to their repository, worktrees to the main checkout', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dirs-'))); // native: long names, not Windows 8.3 (RUNNER~1)
  const repo = path.join(home, 'repo'), wt = path.join(home, 'wt'), sub = path.join(repo, 'src', 'deep'), plain = path.join(home, 'plain');
  fs.mkdirSync(repo); fs.mkdirSync(plain);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('-c', 'user.email=e@e', '-c', 'user.name=e', 'commit', '-q', '--allow-empty', '-m', 'init'); git('worktree', 'add', '-q', '-b', 'x', wt);
  fs.mkdirSync(sub, { recursive: true });
  assert.deepEqual(folderOf(repo, home), { root: repo, repo: true, exists: true });
  assert.deepEqual(folderOf(sub, home), { root: repo, repo: true, exists: true });
  assert.deepEqual(folderOf(wt, home), { root: repo, repo: true, exists: true });
  assert.deepEqual(folderOf(plain, home), { root: plain, repo: false, exists: true });
  assert.deepEqual(folderOf(home, home), { root: home, repo: false, exists: true });
  assert.deepEqual(folderOf(path.join(home, 'repo-worktrees', 'old'), home), { root: repo, repo: true, exists: true });
  assert.deepEqual(folderOf(path.join(repo, '.worktrees', 'old'), home), { root: repo, repo: true, exists: true });
  assert.deepEqual(folderOf(path.join(home, 'gone'), home), { root: path.join(home, 'gone'), repo: false, exists: false });
  fs.rmSync(home, { recursive: true, force: true });
});
