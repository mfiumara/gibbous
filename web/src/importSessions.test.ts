import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHermes, fromForeign, groupCandidates, defaultSelection, triState, toggleAll, matches, runImport, folderKey, readOnlyFor, type SessionDirs, type Candidate } from './importSessions.ts';
import type { SessionListRow } from './hermes/contract';

const NOW = Date.UTC(2026, 9, 10);
const DAY = 86_400_000;
const dirs: SessionDirs = {
  home: '/u',
  sessions: { a: { cwd: '/u/repos/app', at: NOW - DAY }, b: { cwd: '/u/repos/app/src', at: NOW - 20 * DAY }, c: { cwd: '/u', at: NOW - 2 * DAY },
    w1: { cwd: '/u/.paseo/worktrees/x1/dead-one', at: NOW - 3 * DAY }, w2: { cwd: '/u/.paseo/worktrees/x1/dead-two', at: NOW - 4 * DAY } },
  folders: { '/u/repos/app': { root: '/u/repos/app', repo: true, exists: true }, '/u/repos/app/src': { root: '/u/repos/app', repo: true, exists: true }, '/u': { root: '/u', repo: false, exists: true },
    '/u/.paseo/worktrees/x1/dead-one': { root: '/u/.paseo/worktrees/x1/dead-one', repo: false, exists: false }, '/u/.paseo/worktrees/x1/dead-two': { root: '/u/.paseo/worktrees/x1/dead-two', repo: false, exists: false } },
};
const row = (id: string, source: string, message_count = 4, extra: Partial<SessionListRow> = {}): SessionListRow => ({ id, source, message_count, title: `T ${id}`, preview: `p ${id}`, started_at: (NOW - 30 * DAY) / 1000, ...extra });
const rows = [row('a', 'desktop'), row('b', 'cli'), row('c', 'cli'), row('w1', 'acp'), row('w2', 'acp'), row('d', 'discord'), row('cr', 'cron'), row('sub', 'subagent'), row('k', 'kanban'), row('empty', 'acp', 0)];

test('noise sources and empty sessions are left out; folders come from state.db', () => {
  const c = fromHermes(rows, dirs);
  assert.deepEqual(c.map(x => x.id).sort(), ['a', 'b', 'c', 'd', 'w1', 'w2']);
  assert.equal(c.find(x => x.id === 'b')!.folder, '/u/repos/app'); // subfolder → repo root
  assert.equal(c.find(x => x.id === 'd')!.folder, undefined);      // messaging chats group by source
  assert.equal(c.find(x => x.id === 'd')!.at, NOW - 30 * DAY);      // no state.db entry → started_at
  assert.equal(c[0].id, 'a');                                       // newest first
});

test('removed worktrees collapse into their parent', () => {
  assert.equal(folderKey('/u/.paseo/worktrees/x1/dead-one', dirs), '/u/.paseo/worktrees/x1');
  assert.equal(folderKey('/u/repos/app/src', dirs), '/u/repos/app');
  // A leftover worktree folder that's no longer a checkout (only node_modules) counts as removed.
  assert.equal(folderKey('/u/.paseo/worktrees/x1/husk', { ...dirs, folders: { '/u/.paseo/worktrees/x1/husk': { root: '/u/.paseo/worktrees/x1/husk', repo: false, exists: true } } }), '/u/.paseo/worktrees/x1');
});

test('grouping: folders (project-able unless home or a dead worktree), then sources; newest group first', () => {
  const g = groupCandidates(fromHermes(rows, dirs), { dirs, label: s => s.toUpperCase() });
  assert.deepEqual(g.map(x => [x.label, x.items.length, x.canProject, x.repo]), [['app', 2, true, true], ['Home folder', 1, false, false], ['Removed worktrees (x1)', 2, false, false], ['DISCORD', 1, false, false]]);
  assert.equal(g[0].detail, '~/repos/app');
  // Without folder info everything groups by source.
  assert.deepEqual(groupCandidates(fromHermes(rows), { label: s => s }).map(x => x.label), ['desktop', 'cli', 'acp', 'discord']);
});

test('default selection: Hermes sessions active in the last 14 days, not already imported, never foreign', () => {
  const c = [...fromHermes(rows, dirs), ...fromForeign([{ id: 'f', source: 'claude', label: 'L', mtime: NOW / 1000 }])];
  assert.deepEqual([...defaultSelection(c, new Set(['c']), NOW)].sort(), ['hermes:a', 'hermes:w1', 'hermes:w2']);
});

test('tri-state group checkbox and search', () => {
  const items = fromHermes(rows, dirs).slice(0, 3);
  assert.equal(triState(items, new Set()), 'none');
  assert.equal(triState(items, new Set([items[0].key])), 'some');
  const all = toggleAll(new Set([items[0].key]), items);
  assert.equal(triState(items, all), 'all');
  assert.equal(triState(items, toggleAll(all, items)), 'none');
  assert.ok(matches(items[0], 'repos/APP'));
  assert.ok(!matches(items[0], 'nope'));
});

test('foreign rows map to claude_code / codex threads', () => {
  const [f] = fromForeign([{ id: 'h1', source: 'codex', label: 'lbl', cwd: '/u/x', mtime: 100, turn_count: 3 }]);
  assert.deepEqual({ key: f.key, source: f.source, title: f.title, at: f.at }, { key: 'codex:h1', source: 'codex', title: 'lbl', at: 100_000 });
});

test('runImport: sequential, dedupes, one project per folder, continues past failures', async () => {
  const c = fromHermes(rows, dirs);
  const [foreign] = fromForeign([{ id: 'f1', source: 'claude', label: 'F', mtime: NOW / 1000 }]);
  const calls: string[] = [], progress: string[] = [];
  let pid = 0;
  const res = await runImport([...c, foreign, { ...c[0] } as Candidate], new Set(['/u/repos/app']), {
    imported: new Set(['c']),
    projectFor: async f => { calls.push(`project ${f}`); return `pr${++pid}`; },
    importForeign: async x => { calls.push(`foreign ${x.id}`); return 'hs_f1'; },
    addThread: async b => { if (b.sessionId === 'w2') throw new Error('boom'); calls.push(`thread ${b.sessionId} ${b.projectId ?? '-'} ${b.readOnly ? 'ro' : 'rw'}`); return { id: `th_${b.sessionId}` }; },
    onProgress: (d, t) => progress.push(`${d}/${t}`),
  });
  assert.deepEqual(calls, ['project /u/repos/app', 'thread a pr1 rw', 'thread w1 - ro', 'thread b pr1 rw', 'thread d - ro', 'foreign f1', 'thread hs_f1 - rw']);
  assert.deepEqual(res.threads, ['th_a', 'th_w1', 'th_b', 'th_d', 'th_hs_f1']);
  assert.equal(res.skipped, 2); // 'c' was already in Gibbous, and the duplicate of 'a'
  assert.deepEqual(res.failed.map(f => [f.c.id, f.error]), [['w2', 'boom']]);
  assert.equal(progress.at(-1), '8/8');
});

test('read-only: gateway, IDE and API sessions; your own CLI/desktop sessions stay live', () => {
  assert.deepEqual(['discord', 'acp', 'api_server', 'cli', 'desktop', 'tui'].map(readOnlyFor), [true, true, true, false, false, false]);
});
