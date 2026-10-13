import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleColumns, stepColumn, filterColumns, eventGist, agoS } from './board.ts';
import type { KanbanCard, KanbanColumn, KanbanStatus } from '../api';

const card = (id: string, o: Partial<KanbanCard> = {}): KanbanCard => ({
  id, title: `Task ${id}`, status: 'todo', assignee: null, priority: 0, createdAt: 0, startedAt: null, completedAt: null, runStartedAt: null,
  parents: 0, children: 0, progress: null, comments: 0, summary: null, warnings: 0, blockKind: null, branch: null, model: null, effort: null, ...o,
});
const col = (name: KanbanStatus, n: number): KanbanColumn => ({ name, tasks: Array.from({ length: n }, (_, i) => card(`${name}${i}`, { status: name })) });
const cols = [col('triage', 0), col('todo', 0), col('scheduled', 0), col('ready', 1), col('running', 0), col('blocked', 2), col('review', 0), col('done', 3), col('archived', 4)];

test('empty columns fold away except todo/running/done; archived only on request', () => {
  assert.deepEqual(visibleColumns(cols, false).map(c => c.name), ['todo', 'ready', 'running', 'blocked', 'done']);
  assert.deepEqual(visibleColumns(cols, true).map(c => c.name), ['todo', 'ready', 'running', 'blocked', 'done', 'archived']);
});

test('h/l steps to the next column that has cards', () => {
  const v = visibleColumns(cols, false); // todo(0) ready(1) running(0) blocked(2) done(3)
  assert.equal(stepColumn(v, 1, 1), 3);
  assert.equal(stepColumn(v, 3, -1), 1);
  assert.equal(stepColumn(v, 1, -1), null);
  assert.equal(stepColumn(v, 4, 1), null);
});

test('filter matches title, id and assignee', () => {
  const c = [{ name: 'todo' as const, tasks: [card('t_1', { title: 'Fix parser' }), card('t_2', { assignee: 'eng' })] }];
  assert.deepEqual(filterColumns(c, 'parser')[0].tasks.map(t => t.id), ['t_1']);
  assert.deepEqual(filterColumns(c, 'ENG')[0].tasks.map(t => t.id), ['t_2']);
  assert.deepEqual(filterColumns(c, 't_2')[0].tasks.map(t => t.id), ['t_2']);
  assert.equal(filterColumns(c, ' ')[0].tasks.length, 2);
});

test('event gists read JSON payloads, plain text and nothing', () => {
  assert.equal(eventGist('blocked', '{"reason":"needs a key"}'), 'blocked: needs a key');
  assert.equal(eventGist('assigned', { assignee: 'eng' }), 'assigned: eng');
  assert.equal(eventGist('spawn_failed', 'boom'), 'spawn failed: boom');
  assert.equal(eventGist('created', null), 'created');
  assert.equal(eventGist('claimed', { lock: { a: 1 } }), 'claimed');
});

test('agoS formats unix seconds', () => {
  assert.equal(agoS(1000, 1030), 'now');
  assert.equal(agoS(1000, 1000 + 600), '10m');
  assert.equal(agoS(1000, 1000 + 7200), '2h');
  assert.equal(agoS(1000, 1000 + 3 * 86400), '3d');
  assert.equal(agoS(null), '');
});
