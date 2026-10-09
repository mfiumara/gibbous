import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileLines, safeJoin, slug, listFiles, currentBranch, changes, addWorktree, ciState, prBadge } from './git.ts';
import { liveBranch, prTargets } from './prs.ts';
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

test('ciState rolls GitHub checks up to one result', () => {
  const run = (status: string, conclusion = '') => ({ __typename: 'CheckRun', status, conclusion });
  assert.equal(ciState([]), null);
  assert.equal(ciState([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), run('COMPLETED', 'NEUTRAL')]), 'pass');
  assert.equal(ciState([run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS')]), 'pending');
  assert.equal(ciState([run('QUEUED'), run('COMPLETED', 'FAILURE')]), 'fail');           // a failure wins over running jobs
  assert.equal(ciState([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending');  // commit statuses have no `status`
  assert.equal(ciState([{ __typename: 'StatusContext', state: 'ERROR' }]), 'fail');
  assert.equal(ciState([run('COMPLETED', 'CANCELLED')]), 'fail');
});

test('prBadge maps gh pr list rows', () => {
  const row = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, additions: 379, deletions: 75, statusCheckRollup: [] };
  assert.deepEqual(prBadge(row), { number: 7, url: row.url, state: 'open', ci: null, additions: 379, deletions: 75 });
  assert.equal(prBadge({ ...row, isDraft: true }).state, 'draft');
  assert.equal(prBadge({ ...row, state: 'MERGED' }).state, 'merged');
  assert.equal(prBadge({ ...row, state: 'CLOSED', isDraft: true }).state, 'closed');
});

test('prTargets groups local worktree threads, archived included, by project checkout', () => {
  const t = (id: string, extra: object) => ({ id, cwd: `/wt/${id}`, status: 'idle', worktree: { path: `/wt/${id}`, branch: `b-${id}`, base: 'main' }, ...extra }) as any;
  const got = prTargets([
    t('a', { projectId: 'p' }), t('b', { projectId: 'p' }), t('c', {}),
    t('archived', { projectId: 'p', status: 'archived' }), t('remote', { projectId: 'p', host: 'h' }),
    { id: 'plain', cwd: '/x', status: 'idle', projectId: 'p' } as any,
  ], [{ id: 'p', path: '/repo' }] as any);
  const row = (id: string) => ({ id, branch: `b-${id}`, path: `/wt/${id}` });
  assert.deepEqual([...got], [['/repo', [row('a'), row('b'), row('archived')]], ['/wt/c', [row('c')]]]);
});

test('liveBranch follows a renamed worktree branch, falls back when detached or gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gib-live-'));
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  sh('init', '-q', '-b', 'gibbous/orig'); sh('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  sh('branch', '-m', 'feature/renamed');
  assert.equal(await liveBranch(dir, 'gibbous/orig'), 'feature/renamed');
  sh('checkout', '-q', '--detach');
  assert.equal(await liveBranch(dir, 'gibbous/orig'), 'gibbous/orig');
  assert.equal(await liveBranch(path.join(dir, 'missing'), 'gibbous/orig'), 'gibbous/orig');
  fs.rmSync(dir, { recursive: true, force: true });
});
