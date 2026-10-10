import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAgents, agentCounts, agentName, firstLine, QUIET_MS, type StoredSub, type LiveSub } from './agents.ts';

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

test('firstLine skips markdown noise', () => {
  assert.equal(firstLine('## Done\n\n**All good**: shipped'), 'Done');
  assert.equal(firstLine(''), undefined);
});

test('siblings sort by name, numerically', () => {
  const agents = mergeAgents([stored({ sessionId: 'a', goal: 'Worker 10: x' }), stored({ sessionId: 'b', goal: 'Worker 2: y' }), stored({ sessionId: 'c', goal: 'Worker 1: z' })], [], now);
  assert.deepEqual(agents.map(a => a.key), ['c', 'b', 'a']);
});
