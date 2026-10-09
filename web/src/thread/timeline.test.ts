// Replays a real Hermes event capture through the reducer: `node --test web/src/thread/timeline.test.ts`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, MOON_VERBS, fromHistory, fromStored, checkpointFor, parseUserText, withInflight, type Timeline } from './timeline.ts';

const ev = (type: string, payload: any = {}) => ({ type, session_id: 's', payload });

test('streamed turn with tools and duplicate reasoning.available', () => {
  let t: Timeline = { items: [], running: false };
  for (const e of [
    ev('message.start'), ev('thinking.delta', { text: '(⊙_⊙) processing...' }),
    ev('reasoning.delta', { text: 'I need to check' }), ev('reasoning.delta', { text: ' a.txt' }),
    ev('tool.generating', { name: 'mcp__read_file' }),
    ev('tool.start', { tool_id: 't1', name: 'read_file', context: 'a.txt', args: { path: 'a.txt' } }),
    ev('tool.complete', { tool_id: 't1', name: 'read_file', duration_s: 0.1, result: { content: '1|hello' } }),
    ev('tool.start', { tool_id: 't2', name: 'terminal', args: { command: 'false' } }),
    ev('tool.complete', { tool_id: 't2', name: 'terminal', result: { output: '', exit_code: 1 }, inline_diff: '\u001b[31m-a\u001b[0m' }),
    ev('message.delta', { text: '\n\nDone' }), ev('message.delta', { text: ' now.' }),
    ev('reasoning.available', { text: 'Done now.' }),
    ev('message.complete', { text: 'Done now.', status: 'complete' }),
  ]) t = reduce(t, e);
  assert.equal(t.running, false);
  assert.deepEqual(t.items.map(i => i.kind), ['reasoning', 'tool', 'tool', 'assistant', 'turn']);
  const [r, t1, t2, a] = t.items as any[];
  assert.equal(r.text, 'I need to check a.txt');
  assert.equal(t1.status, 'done');
  assert.equal(t2.status, 'error');
  assert.equal(t2.diff, '-a');
  assert.equal(a.text, 'Done now.');
  assert.ok(t.items.every((i: any) => !i.streaming));
});

test('complete without deltas adds the reply once', () => {
  let t: Timeline = { items: fromHistory([{ role: 'user', text: 'hi', row_id: 1 }]), running: true };
  t = reduce(t, ev('message.complete', { text: 'pong', status: 'complete' }));
  t = reduce(t, ev('message.complete', { text: 'pong', status: 'complete' }));
  assert.deepEqual(t.items.map(i => i.kind), ['user', 'assistant']);
});

test('stored Discord rows: tool calls pair with results, notifications collapse', () => {
  const items = fromStored([
    { id: 1, role: 'user', content: '[alice] list files' },
    { id: 2, role: 'assistant', content: '', reasoning: 'use ls', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{"command":"ls"}' } }] },
    { id: 3, role: 'tool', tool_call_id: 'c1', tool_name: 'terminal', content: '{"output":"a.txt","exit_code":0}' },
    { id: 4, role: 'user', display_kind: 'internal_notification', content: '[IMPORTANT: Background process done.\nmore' },
    { id: 5, role: 'assistant', content: [{ type: 'text', text: 'Here: a.txt' }, { type: 'image_url' }] },
  ]);
  assert.deepEqual(items.map(i => i.kind), ['user', 'reasoning', 'tool', 'notice', 'assistant']);
  const tool = items[2] as any;
  assert.equal(tool.args.command, 'ls');
  assert.equal(tool.result.output, 'a.txt');
  assert.equal(tool.status, 'done');
  assert.equal((items[3] as any).text, 'Background process done.');
  assert.equal((items[4] as any).text, 'Here: a.txt\n[image]');
});

test('checkpointFor picks the first snapshot inside the turn window', () => {
  const at = Date.parse('2026-10-08T10:00:00Z'), next = Date.parse('2026-10-08T10:05:00Z');
  const cps = [{ hash: 'before', timestamp: '2026-10-08T09:59:00Z' }, { hash: 'late', timestamp: '2026-10-08T10:03:00Z' }, { hash: 'first', timestamp: '2026-10-08T10:00:30Z' }, { hash: 'nextturn', timestamp: '2026-10-08T10:06:00Z' }];
  assert.equal(checkpointFor(at, next, cps)?.hash, 'first');
  assert.equal(checkpointFor(next, undefined, cps)?.hash, 'nextturn');
  assert.equal(checkpointFor(undefined, next, cps), undefined);
});

test('a finished turn gets a footer with its own share of tokens and cost', () => {
  let t: Timeline = { items: [], running: false, usage: { total: 1000, cost_usd: 0.5 } };
  t = reduce(t, ev('message.start'));
  assert.ok(t.turnStartedAt);
  t = reduce(t, ev('message.delta', { text: 'hi' }));
  t = reduce(t, ev('message.complete', { text: 'hi', status: 'complete', usage: { total: 1400, cost_usd: 0.62 } }));
  const f = t.items.at(-1)!;
  assert.equal(f.kind, 'turn');
  if (f.kind === 'turn') { assert.equal(f.tokens, 400); assert.ok(Math.abs((f.cost ?? 0) - 0.12) < 1e-9); assert.ok(f.ms != null); }
  assert.equal(t.turnStartedAt, undefined);
});


test('a sent message with attachments shows what you wrote; attachments become chips', () => {
  // Exactly what Hermes stored for a real turn with one text file and one pasted screenshot.
  const stored = '@file:/Users/me/.hermes/attachments/probe-note.txt\n\nWhat is the secret word?\n\n--- Attached Context ---\n\n📄 @file:/Users/me/.hermes/attachments/probe-note.txt (7 tokens)\n```\nThe secret word is lunation.\n```\n@image:/Users/me/.hermes/images/upload_1.png\n[screenshot]';
  const r = parseUserText(stored);
  assert.equal(r.body, 'What is the secret word?');
  assert.deepEqual(r.files, ['/Users/me/.hermes/attachments/probe-note.txt']);
  assert.deepEqual(r.images, ['/Users/me/.hermes/images/upload_1.png']);
  assert.equal(parseUserText('see @file:src/a.ts please').body, 'see a.ts please');
});

test('history turns get a duration footer; the in-flight one does not', () => {
  const rows = [
    { role: 'user', text: 'a', row_id: 1, timestamp: 100 }, { role: 'assistant', text: 'b', row_id: 2, timestamp: 165 },
    { role: 'user', text: 'c', row_id: 3, timestamp: 200 }, { role: 'tool', name: 'x', row_id: 4, timestamp: 210 },
  ] as any;
  const turns = (items: any[]) => items.filter(i => i.kind === 'turn').map(i => i.ms);
  assert.deepEqual(turns(fromHistory(rows)), [65000, 10000]);
  assert.deepEqual(turns(fromHistory(rows, true)), [65000]);
});

test('thinking status drops the spinner kaomoji and speaks moon', () => {
  const t = (text: string) => reduce({ items: [], running: true }, ev('thinking.delta', { text })).status!;
  const musing = t('( •_•)>⌐■-■ musing...');
  assert.ok(MOON_VERBS.includes(musing.replace('…', '')), musing);
  assert.equal(t('(¬_¬) musing...'), musing);                 // stable per Hermes verb, whatever the face
  assert.ok(t('(⊙_⊙) processing…').endsWith('…'));
  assert.equal(t('Reading files'), 'Reading files');
  assert.equal(t('compacting context'), 'Compacting context');
  assert.match(musing, /^\p{Lu}/u);
});

test('attaching mid-turn shows the prompt once, even when the stored row carries attachment refs', () => {
  const users = (items: any[]) => items.filter(i => i.kind === 'user').length;
  const hist = fromHistory([{ role: 'user', text: 'fix this\n@image:/Users/me/.hermes/images/upload_1.png\n[screenshot]', row_id: 1, timestamp: 1 }] as any, true);
  assert.equal(users(withInflight(hist, { user: 'fix this', streaming: true }, true)), 1);
  assert.equal(users(withInflight(fromHistory([], true), { user: 'fix this' }, true)), 1);   // row not persisted yet
  assert.equal(users(withInflight(hist, { user: 'something else' }, true)), 2);
  assert.equal(users(withInflight(hist, { user: 'fix this' }, false)), 1);                // not running: history only
});

test('compaction status drives the compacting flag until the next status or the end of the turn', () => {
  let t: Timeline = { items: [], running: false };
  t = reduce(t, ev('message.start'));
  t = reduce(t, ev('status.update', { kind: 'compacting', text: '🗜️ Compacting context — summarizing earlier conversation so I can continue...' }));
  assert.equal(t.compacting, true);
  t = reduce(t, ev('status.update', { kind: 'compacted', text: '✓ Context compaction complete — continuing turn...' }));
  assert.equal(t.compacting, false);
  t = reduce(t, ev('status.update', { kind: 'compressing', text: 'Compressing…' }));
  assert.equal(t.compacting, true);
  t = reduce(t, ev('message.complete', { text: 'ok', status: 'complete' }));
  assert.equal(t.compacting, false);
});
