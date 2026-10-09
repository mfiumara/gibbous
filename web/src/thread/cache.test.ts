import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCached, putCached, clearCache, cachedIds, onCached, reconcile, revive, fromResume, MAX_THREADS, MAX_ITEMS } from './cache.ts';
import type { Item, Timeline } from './timeline.ts';

const tl = (n: number, running = false): Timeline => ({ items: Array.from({ length: n }, (_, i) => ({ kind: 'user', id: `r${i}`, text: `m${i}` }) as Item), running });

beforeEach(clearCache);

test('LRU keeps the most recently used threads', () => {
  for (let i = 0; i < MAX_THREADS; i++) putCached(`t${i}`, { tl: tl(1) });
  getCached('t0');                       // touch: t0 is now the newest
  putCached('extra', { tl: tl(1) });     // evicts the oldest untouched one
  assert.equal(cachedIds().length, MAX_THREADS);
  assert.ok(getCached('t0'));
  assert.equal(getCached('t1'), undefined);
});

test('caps items per thread to the newest ones', () => {
  putCached('a', { tl: tl(MAX_ITEMS + 50) });
  const c = getCached('a')!;
  assert.equal(c.tl.items.length, MAX_ITEMS);
  assert.equal(c.tl.items[0].id, 'r50');
  assert.equal(c.tl.items.at(-1)!.id, `r${MAX_ITEMS + 49}`);
});

test('putting again replaces, never duplicates', () => {
  putCached('a', { tl: tl(2) });
  putCached('a', { tl: tl(3) });
  assert.deepEqual(cachedIds(), ['a']);
  assert.equal(getCached('a')!.tl.items.length, 3);
});

test('subscribers hear only notifying puts', () => {
  const heard: string[] = [];
  const off = onCached(id => heard.push(id));
  putCached('a', { tl: tl(1) });
  putCached('b', { tl: tl(1) }, true);
  off();
  putCached('c', { tl: tl(1) }, true);
  assert.deepEqual(heard, ['b']);
});

test('reconcile keeps ids and objects of unchanged rows, adds new ones', () => {
  const prev: Item[] = [
    { kind: 'user', id: 'r1', text: 'hi' },
    { kind: 'reasoning', id: 'rs-1', text: 'think' },
    { kind: 'assistant', id: 'r2', text: 'hello' },
    { kind: 'turn', id: 'tn-2', ms: 1000 },
  ];
  // fromHistory mints new ids for reasoning/turn rows on every call
  const next: Item[] = [
    { kind: 'user', id: 'r1', text: 'hi' },
    { kind: 'reasoning', id: 'rs-9', text: 'think' },
    { kind: 'assistant', id: 'r2', text: 'hello' },
    { kind: 'turn', id: 'tn-10', ms: 1000 },
    { kind: 'user', id: 'r3', text: 'more' },
    { kind: 'assistant', id: 'r4', text: 'sure' },
  ];
  const out = reconcile(prev, next);
  assert.deepEqual(out.map(i => i.id), ['r1', 'rs-1', 'r2', 'tn-2', 'r3', 'r4']);
  for (let i = 0; i < 4; i++) assert.equal(out[i], prev[i]);   // same object: memoized rows skip rendering
  assert.equal(out[4], next[4]);
});

test('reconcile: changed rows take the fresh copy; repeated content matches in order', () => {
  const prev: Item[] = [
    { kind: 'turn', id: 'a', ms: 5 }, { kind: 'turn', id: 'b', ms: 5 },
    { kind: 'assistant', id: 'inflight-a', text: 'par', streaming: true },
  ];
  const next: Item[] = [
    { kind: 'turn', id: 'x', ms: 5 }, { kind: 'turn', id: 'y', ms: 5 }, { kind: 'turn', id: 'z', ms: 5 },
    { kind: 'assistant', id: 'r7', text: 'partial reply done' },
  ];
  assert.deepEqual(reconcile(prev, next).map(i => i.id), ['a', 'b', 'z', 'r7']);
});

test('reconcile never produces duplicate keys', () => {
  const prev: Item[] = [{ kind: 'turn', id: 'r5', ms: 1 }];
  const next: Item[] = [{ kind: 'turn', id: 'q', ms: 1 }, { kind: 'user', id: 'r5', text: 'x' }];
  const ids = reconcile(prev, next).map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(reconcile([], next), next);
});

test('revive drops a stale running state but keeps a live one', () => {
  const c = { tl: { ...tl(1, true), status: 'Waxing…', turnStartedAt: 1 }, at: 0 };
  assert.equal(revive(c, true), c.tl);
  const r = revive(c, false);
  assert.equal(r.running, false); assert.equal(r.status, undefined); assert.equal(r.turnStartedAt, undefined);
  assert.equal(r.items, c.tl.items);
});

test('fromResume builds the timeline ThreadView renders', () => {
  const r = fromResume({ messages: [{ role: 'user', text: 'q', row_id: 1, timestamp: 10 } as any, { role: 'assistant', text: 'a', row_id: 2, timestamp: 12 } as any], running: false });
  assert.deepEqual(r.items.map(i => i.kind), ['user', 'assistant', 'turn']);
  assert.equal(r.running, false);
  const live = fromResume({ messages: [{ role: 'user', text: 'q', row_id: 1, timestamp: 10 } as any], running: true, inflight: { assistant: 'par', streaming: true } });
  assert.equal(live.turnStartedAt, 10_000);
  assert.equal(live.items.at(-1)!.id, 'inflight-a');
});
