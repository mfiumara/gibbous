import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAgents, currentBatch, latestDelegatingTurn, agentCounts, agentName, firstLine, QUIET_MS, type StoredSub, type LiveSub } from './agents.ts';

const now = 1_000_000_000_000;
const stored = (o: Partial<StoredSub>): StoredSub => ({ sessionId: 's1', parentSessionId: 'p', depth: 0, goal: 'Worker 1: do a thing', messages: 3, toolCalls: 1, tokens: 10, ...o });
const live = (o: Partial<LiveSub>): LiveSub => ({ kind: 'subagent', id: 'sa1', goal: 'Worker 1: do a thing', status: 'running', tools: ['terminal · ls'], index: 0, count: 1, ...o });

test('stored and live records of the same child merge into one agent', () => {
  const [a, ...rest] = mergeAgents([stored({ startedAt: now - 1000, lastActivityAt: now - 500 })], [live({ childSessionId: 's1' })], now);
  assert.equal(rest.length, 0);
  assert.equal(a.key, 's1'); assert.equal(a.liveId, 'sa1'); assert.equal(a.state, 'running'); assert.equal(a.activity, 'terminal · ls');
});

test('a live event without a child session id still matches its stored session by goal', () => {
  const agents = mergeAgents([stored({ lastActivityAt: now })], [live({})], now);
  assert.equal(agents.length, 1); assert.equal(agents[0].liveId, 'sa1');
});

test('an ended session is done even if the last live event said running', () => {
  const [a] = mergeAgents([stored({ endedAt: now - 10, endReason: 'agent_close' })], [live({ childSessionId: 's1' })], now);
  assert.equal(a.state, 'done');
});

test('a child silent for too long without an end is quiet, not running', () => {
  const [a] = mergeAgents([stored({ lastActivityAt: now - QUIET_MS - 1 })], [], now);
  assert.equal(a.state, 'quiet');
});

test('queued live-only subagents are listed and counted', () => {
  const agents = mergeAgents([stored({ lastActivityAt: now })], [live({ id: 'sa2', goal: 'Worker 2: other', status: 'queued' })], now);
  assert.deepEqual(agentCounts(agents), { total: 2, running: 1, queued: 1, done: 0, failed: 0, other: 0 });
});

test('names come from the goal prefix', () => {
  const [a] = mergeAgents([stored({ goal: 'Worker 4: rebuild and submit new candidate revisions' })], [], now);
  assert.equal(agentName(a, 3), 'Worker 4');
  const [b] = mergeAgents([stored({ goal: 'Audit the repo for dead code and report findings back' })], [], now);
  assert.equal(agentName(b, 0), 'Audit the repo for dead code and');
  const name = (goal: string) => agentName(mergeAgents([stored({ goal })], [], now)[0], 0);
  assert.equal(name('Acme: make switching threads instant (no blank screen on every switch)'), 'Make switching threads instant');
  assert.equal(name('Acme phone UX: menus as bottom sheets, and keep the composer glued'), 'Menus as bottom sheets');
  assert.equal(name('Acme macOS app shell: translucent sidebar with traffic lights inside it. More text'), 'Translucent sidebar with traffic lights inside it');
});

const batchAgent = (key: string, startedAt: number, state: 'done' | 'running' | 'queued' = 'done') => ({
  key, goal: key, depth: 0, state, status: state, tools: [], startedAt,
});

test('current batch keeps all done agents in the latest old delegating turn', () => {
  const old = batchAgent('older', now - 200_000), a = batchAgent('a', now - 100_000);
  assert.deepEqual(currentBatch([old, a], now - 110_000, now), { batch: [a], earlier: [old] });
});

test('current batch scopes a new turn to its fresh agents, including the boundary', () => {
  const old = batchAgent('old', now - 50_000), a = batchAgent('a', now - 1000), b = batchAgent('b', now, 'running');
  assert.deepEqual(currentBatch([old, a, b], now - 1000, now), { batch: [a, b], earlier: [old] });
  assert.equal(agentCounts(currentBatch([old, a, b], now - 1000, now).batch).total, 2);
});

test('current batch retains old agents still running or queued', () => {
  const a = batchAgent('a', now - 900_000, 'running'), b = batchAgent('b', now - 800_000, 'queued'), c = batchAgent('c', now);
  assert.deepEqual(currentBatch([a, b, c], now - 1000, now), { batch: [a, b, c], earlier: [] });
});

test('current batch without turn info uses ten minutes from the newest agent, not now', () => {
  const old = batchAgent('old', now - 2_000_001), edge = batchAgent('edge', now - 2_000_000), newest = batchAgent('newest', now - 1_400_000);
  assert.deepEqual(currentBatch([old, edge, newest], undefined, now), { batch: [edge, newest], earlier: [old] });
});

test('current batch has no earlier agents for a single batch or an empty list', () => {
  const a = batchAgent('a', now - 1000), b = batchAgent('b', now);
  assert.deepEqual(currentBatch([a, b], now - 2000, now), { batch: [a, b], earlier: [] });
  assert.deepEqual(currentBatch([], undefined, now), { batch: [], earlier: [] });
});

test('latest delegating turn uses live rows or history tool rows, not a later non-delegating turn', () => {
  assert.equal(latestDelegatingTurn([
    { kind: 'user', id: 'u1', text: 'first', at: 100 }, live({}),
    { kind: 'user', id: 'u2', text: 'second', at: 200 },
    { kind: 'tool', id: 't', name: 'delegate_task', status: 'done' },
    { kind: 'user', id: 'u3', text: 'later', at: 300 },
  ]), 200);
  assert.equal(latestDelegatingTurn([live({})]), undefined);
});

test('firstLine skips markdown noise', () => {
  assert.equal(firstLine('## Done\n\n**All good**: shipped'), 'Done');
  assert.equal(firstLine(''), undefined);
});

test('siblings sort by name, numerically', () => {
  const agents = mergeAgents([stored({ sessionId: 'a', goal: 'Worker 10: x' }), stored({ sessionId: 'b', goal: 'Worker 2: y' }), stored({ sessionId: 'c', goal: 'Worker 1: z' })], [], now);
  assert.deepEqual(agents.map(a => a.key), ['c', 'b', 'a']);
});
