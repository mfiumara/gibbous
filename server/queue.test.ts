import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, edit, remove, toFront, reorder, onTurnEnd, MAX_QUEUE, type QueueItem } from './queue.ts';

const m = (id: string): QueueItem => ({ id, text: `${id} text`, shown: id, at: 0 });
const ids = (q: QueueItem[]) => q.map(x => x.id);

test('add appends and caps the line', () => {
  assert.deepEqual(ids(add(undefined, m('a'))), ['a']);
  assert.deepEqual(ids(add([m('a')], m('b'))), ['a', 'b']);
  assert.throws(() => add(Array.from({ length: MAX_QUEUE }, (_, i) => m(`x${i}`)), m('y')));
});

test('edit replaces the text; shown follows it unless given', () => {
  assert.deepEqual(edit([m('a'), m('b')], 'b', 'new')[1], { id: 'b', text: 'new', shown: 'new', at: 0 });
  assert.equal(edit([m('a')], 'a', '@f new', 'new')[0].shown, 'new');
  assert.deepEqual(edit([m('a')], 'zz', 'x'), [m('a')]);
});

test('remove, move to front and reorder keep everything else in place', () => {
  assert.deepEqual(ids(remove([m('a'), m('b'), m('c')], 'b')), ['a', 'c']);
  assert.deepEqual(ids(toFront([m('a'), m('b'), m('c')], 'c')), ['c', 'a', 'b']);
  assert.deepEqual(ids(toFront([m('a')], 'zz')), ['a']);
  assert.deepEqual(ids(reorder([m('a'), m('b'), m('c')], ['c', 'a'])), ['c', 'a', 'b']);
  assert.deepEqual(ids(reorder([m('a'), m('b')], ['zz', 'b'])), ['b', 'a']);
});

test('a finished or failed turn sends the head; a Stop pauses; send now overrides the pause', () => {
  const q = [m('a')];
  assert.equal(onTurnEnd({ queue: q }, 'complete'), 'send');
  assert.equal(onTurnEnd({ queue: q }, 'error'), 'send');
  assert.equal(onTurnEnd({ queue: q, paused: true }, 'complete'), 'none');
  assert.equal(onTurnEnd({ queue: [] }, 'complete'), 'none');
  assert.equal(onTurnEnd({ queue: q }, 'interrupted'), 'pause');
  assert.equal(onTurnEnd({ queue: q, paused: true }, 'interrupted'), 'none');
  assert.equal(onTurnEnd({ queue: [] }, 'interrupted'), 'none');
  assert.equal(onTurnEnd({ queue: q, sendNow: true }, 'interrupted'), 'send');
  assert.equal(onTurnEnd({ queue: q, paused: true, sendNow: true }, 'interrupted'), 'send');
});
