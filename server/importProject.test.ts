import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectForDirs } from './importProject.ts';

test('an imported session in a linked worktree files under its main repo project; home never matches', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  try {
    const repo = path.join(home, 'repos', 'biss'), wt = path.join(home, '.paseo', 'worktrees', 'x', 'toad');
    fs.mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    git('init', '-q'); git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i');
    fs.mkdirSync(path.dirname(wt), { recursive: true }); git('worktree', 'add', '-q', wt);
    const projects = [{ id: 'p1', name: 'biss', path: repo }, { id: 'p2', name: 'other', path: path.join(home, 'other') }] as any;
    assert.equal(projectForDirs([wt, null], projects, home)?.id, 'p1');
    assert.equal(projectForDirs([path.join(repo, 'web')], projects, home)?.id, 'p1');
    assert.equal(projectForDirs([null, repo], projects, home)?.id, 'p1');       // git_repo_root only
    assert.equal(projectForDirs([home], projects, home), undefined);
    assert.equal(projectForDirs([], projects, home), undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
