import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCached, putCached, clearCache, cachedIds, onCached, reconcile, revive, fromResume, mergeTail, prependOlder, MAX_THREADS, MAX_ITEMS, MAX_PAGED_ITEMS } from './cache.ts';
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

test('paged entries keep loaded pages and their cursor; only past the higher cap are they trimmed and lose it', () => {
  putCached('a', { tl: tl(MAX_ITEMS + 1), page: { next: 9, more: true, first: 3 } });
  assert.equal(getCached('a')!.tl.items.length, MAX_ITEMS + 1);
  assert.deepEqual(getCached('a')!.page, { next: 9, more: true, first: 3 });
  putCached('b', { tl: tl(MAX_PAGED_ITEMS + 1), page: { next: 9, more: true, first: 3 } });
  assert.equal(getCached('b')!.tl.items.length, MAX_PAGED_ITEMS);
  assert.equal(getCached('b')!.page, undefined);
});

const u = (n: number): Item => ({ kind: 'user', id: `r${n}`, text: `q${n}` });
const a = (n: number, text = `a${n}`): Item => ({ kind: 'assistant', id: `r${n}`, text });
const ft = (id: string): Item => ({ kind: 'turn', id, ms: 1 });

test('mergeTail keeps older rows in front of the fresh newest page', () => {
  const prev = [u(1), a(2), ft('t1'), u(3), a(4), ft('t2')];
  const next = [u(3), a(4), ft('t9'), u(5), a(6)]; // fresh page starts at turn 3, with a new turn
  const { items, kept } = mergeTail(prev, next);
  assert.equal(kept, true);
  assert.deepEqual(items.map(i => i.id), ['r1', 'r2', 't1', 'r3', 'r4', 't2', 'r5', 'r6']);
  for (let i = 0; i < 6; i++) assert.equal(items[i], prev[i]); // unchanged rows keep their objects
});

test('mergeTail: rows the fresh page no longer has (a rewind) are gone; no overlap means the page wins', () => {
  const prev = [u(1), a(2), u(3), a(4), u(7), a(8)];
  assert.deepEqual(mergeTail(prev, [u(3), a(4, 'edited')]).items.map(i => i.id), ['r1', 'r2', 'r3', 'r4']);
  const far = mergeTail(prev, [u(20), a(21)]);
  assert.equal(far.kept, false);
  assert.deepEqual(far.items.map(i => i.id), ['r20', 'r21']);
  assert.deepEqual(mergeTail([], [u(1)]).items.map(i => i.id), ['r1']);
  assert.equal(mergeTail(prev, [u(1), a(2)]).kept, false); // page starts at the very first row: nothing older to keep
});

test('prependOlder never doubles a row', () => {
  const items = [u(5), a(6)];
  assert.deepEqual(prependOlder(items, [u(1), a(2), u(5)]).map(i => i.id), ['r1', 'r2', 'r5', 'r6']);
  assert.equal(prependOlder(items, [u(5)]), items);
});
