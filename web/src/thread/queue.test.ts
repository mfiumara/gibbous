import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterTurn, nextToFeed, syncQueue, promote, type Queued } from './queue.ts';

const m = (id: string, o: Partial<Queued> = {}): Queued => ({ id, shown: id, message: id, images: false, ...o });
const ids = (q: Queued[]) => q.map(x => x.id);

test('only one message is with Hermes at a time, so its queue never merges them', () => {
  assert.equal(nextToFeed([m('a'), m('b')])?.id, 'a');
  assert.equal(nextToFeed([m('a', { inHermes: true }), m('b')]), undefined);
  assert.equal(nextToFeed([m('h', { held: true }), m('b')])?.id, 'b');
});

test('a finished turn releases the one Hermes had; the rest wait', () => {
  const r = afterTurn([m('a', { inHermes: true }), m('b'), m('c')], 'complete');
  assert.equal(r.sent?.id, 'a');
  assert.deepEqual(ids(r.q), ['b', 'c']);
  assert.equal(nextToFeed(r.q)?.id, 'b');
});

test('a finished turn with nothing handed over releases nothing', () => {
  assert.equal(afterTurn([m('a')], 'complete').sent, undefined);
});

test('a stopped turn holds everything (Hermes dropped its queue)', () => {
  const r = afterTurn([m('a', { inHermes: true }), m('b')], 'interrupted');
  assert.equal(r.sent, undefined);
  assert.ok(r.q.every(x => x.held && !x.inHermes));
  assert.equal(nextToFeed(r.q), undefined);
});

test('sync: no head means what Hermes had already ran', () => {
  assert.deepEqual(ids(syncQueue([m('a', { inHermes: true }), m('b')], null)), ['b']);
  assert.deepEqual(ids(syncQueue([m('b')], undefined)), ['b']);
});

test('sync: a head we know is marked as handed over; an unknown one is shown first', () => {
  assert.ok(syncQueue([m('a'), m('b')], 'a')[0].inHermes);
  const q = syncQueue([m('x', { held: true })], 'from elsewhere');
  assert.equal(q[0].shown, 'from elsewhere'); assert.ok(q[0].inHermes); assert.equal(q.length, 2);
});

test('send now puts the message first, unheld, and nothing stays with Hermes', () => {
  const q = promote([m('a', { inHermes: true }), m('b'), m('c', { held: true })], 'c');
  assert.deepEqual(ids(q), ['c', 'a', 'b']);
  assert.ok(q.every(x => !x.inHermes) && !q[0].held);
});
