import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateSpaces, spaceName, assignSpace, inSpace, activeSpace, cycleSpace, threadInSpace } from './spaces.ts';

const spaces = [{ id: 'private', name: 'Private' }, { id: 'work', name: 'Work' }];
test('spaces are opt-in, validated and ordered; corrupt entries do not survive migration', () => {
  assert.deepEqual(migrateSpaces(undefined), []);
  assert.deepEqual(migrateSpaces([...spaces, { id: 'work', name: 'Duplicate' }, { id: 'x', name: ' work ' }, { id: '../bad', name: 'Bad' }, { id: 'empty', name: ' ' }, null]), spaces);
});
test('names are free text, trimmed and unique without case, and renames preserve identity', () => {
  assert.equal(spaceName('  Personal moon shots  ', spaces), 'Personal moon shots');
  assert.equal(spaceName('Work', spaces, 'work'), 'Work');
  assert.throws(() => spaceName(' work ', spaces), /already exists/);
  assert.throws(() => spaceName('', spaces), /1 and 40/);
  assert.throws(() => spaceName('x'.repeat(41), spaces), /1 and 40/);
});
test('assignment is one space, rejects unknown IDs atomically, and None removes it', () => {
  const project: { space?: string } = {};
  assignSpace(project, 'private', spaces); assert.equal(project.space, 'private');
  assignSpace(project, 'work', spaces); assert.equal(project.space, 'work');
  assert.throws(() => assignSpace(project, 'missing', spaces), /not found/);
  assert.equal(project.space, 'work');
  assignSpace(project, null, spaces); assert.ok(!('space' in project));
});
test('All includes unassigned projects and loose chats; a space includes only its projects', () => {
  const projects = [{ id: 'p1', space: 'private' }, { id: 'p2', space: 'work' }, { id: 'p3' }];
  assert.deepEqual(projects.filter(p => inSpace(p, '')).map(p => p.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(projects.filter(p => inSpace(p, 'work')).map(p => p.id), ['p2']);
  assert.equal(inSpace(undefined, ''), true);
  assert.equal(inSpace(undefined, 'work'), false);
});
test('switching wraps in creation order and deleted spaces fall back to All', () => {
  assert.equal(cycleSpace('', spaces, 1), 'private');
  assert.equal(cycleSpace('work', spaces, 1), '');
  assert.equal(cycleSpace('', spaces, -1), 'work');
  assert.equal(activeSpace('deleted', spaces), '');
  assert.equal(cycleSpace('deleted', [], 1), '');
});

test('a projectless chat sits in its own space; a project chat follows its project', () => {
  const projects = [{ id: 'p', space: 'work' }];
  assert.equal(threadInSpace({ space: 'home' }, projects, 'home'), true);
  assert.equal(threadInSpace({ space: 'home' }, projects, 'work'), false);
  assert.equal(threadInSpace({ projectId: 'p', space: 'home' }, projects, 'work'), true);
  assert.equal(threadInSpace({}, projects, 'work'), false);
  assert.equal(threadInSpace({}, projects, ''), true);
});
