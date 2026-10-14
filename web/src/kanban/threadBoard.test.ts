import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chains } from './board.ts';

const task = (id: string, status: any, next: [string, any][] = []) => ({ id, status, title: id, next: next.map(([n, s]) => ({ id: n, title: n, status: s })), fromChat: false } as any);
test('chains: a waiting active task sits under the one it waits on; others show one queued next step', () => {
  const g = chains([task('B', 'blocked', [['Q1', 'todo']]), task('M', 'running', [['B', 'blocked'], ['Q2', 'todo'], ['Q3', 'todo']]), task('P', 'running', [['R', 'todo'], ['R2', 'todo']]), task('X', 'running')]);
  assert.deepEqual(g.map(c => c.map(s => s.kind === 'task' ? s.id : `>${s.title}`)), [['M', 'B', '>Q1'], ['P', '>R'], ['X']]);
});
test('chains: a cycle still shows every task once', () => {
  const g = chains([task('A', 'running', [['B', 'running']]), task('B', 'running', [['A', 'running']])]);
  assert.equal(g.flat().filter(s => s.kind === 'task').length, 2);
});
