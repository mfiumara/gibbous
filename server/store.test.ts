import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from './store.ts';

test('old task-board state migrates without losing projects, threads or other keys', () => {
  const old = {
    projects: [{ id: 'pr_1', name: 'demo', path: '/tmp/demo', playbookId: 'pb_x', createdAt: 1 }],
    threads: [
      { id: 'th_1', title: 'lead', role: 'coordinator', sessionId: 's1', cwd: '/tmp/demo', status: 'idle', createdAt: 1, updatedAt: 1 },
      { id: 'th_2', title: 'worker', role: 'worker', taskId: 'tk_1', parentId: 'th_1', planId: 'pl_1', planned: true, sessionId: 's2', cwd: '/tmp/demo', status: 'archived', createdAt: 1, updatedAt: 1 },
    ],
    tasks: [{ id: 'tk_1' }], plans: [], playbooks: [], schedules: [], hosts: [{ id: 'host_1' }],
    settings: { model: 'm', maxConcurrent: 3, autoReview: true, maxReviewRounds: 2, notify: { input: false, task: true, plan: false } },
    push: { subs: [{ endpoint: 'x' }] }, budgetAlerted: '2026-01',
  };
  const s: any = migrate(old);
  for (const k of ['tasks', 'plans', 'playbooks', 'schedules']) assert.ok(!(k in s), k);
  assert.deepEqual(s.threads.map((t: any) => [t.id, t.role, t.status]), [['th_1', 'chat', 'idle'], ['th_2', 'chat', 'archived']]);
  assert.ok(!('taskId' in s.threads[1]) && !('parentId' in s.threads[1]) && !('planId' in s.threads[1]));
  assert.equal(s.projects[0].name, 'demo');
  assert.ok(!('playbookId' in s.projects[0]));
  assert.equal(s.settings.model, 'm');
  assert.ok(!('maxConcurrent' in s.settings) && !('autoReview' in s.settings));
  assert.deepEqual(s.settings.notify, { input: false, done: true, failure: true });
  assert.equal(s.push.subs.length, 1);
  assert.equal(s.hosts.length, 1);
  assert.equal(s.budgetAlerted, '2026-01');
});

test('a fresh install gets defaults', () => {
  const s = migrate({});
  assert.deepEqual([s.projects, s.threads, s.hosts], [[], [], []]);
  assert.equal(s.settings.notify.done, true);
});
