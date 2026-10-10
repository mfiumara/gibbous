// Thread lifecycle against a fake Hermes: restart catch-up, reaped live sessions, stuck "running" threads.
// Real git, temp dirs, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-orch-'));
process.env.GIBBOUS_HOME = home;
const { fakeHermes } = await import('./fake-hermes.ts');
const { HermesClient } = await import('./hermes.ts');
const { Orchestrator } = await import('./orchestrator.ts');
const { saveNow } = await import('./store.ts');

const repo = path.join(home, 'repo');
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
fs.mkdirSync(repo);
git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'README'), 'hi\n'); git('add', '-A'); git('commit', '-qm', 'init');

let hang = false;
const gates: (() => void)[] = []; // 'wait:' prompts run until the test opens their gate; 'hang:' ones never finish
const fake = fakeHermes((prompt, s) => {
  if (hang || prompt.startsWith('hang:')) return new Promise<string>(() => {}); // a turn that is still going when Gibbous restarts
  if (prompt.startsWith('wait:')) return new Promise<string>(r => gates.push(() => r('done')));
  fs.appendFileSync(path.join(s.cwd, 'out.txt'), `${s.prompts.length}\n`);
  return 'done';
});
const backend = async () => ({ port: fake.port(), token: 't' });
const boot = async () => { const hc = new HermesClient(backend); const o = new Orchestrator(hc, backend); await hc.start(); return o; };
const until = async (what: string, ok: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; !ok(); await new Promise(r => setTimeout(r, 20))) if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
};

let orch = await boot();
after(async () => { orch.stop(); await fake.close(); saveNow(); fs.rmSync(home, { recursive: true, force: true }); });

test('a turn that ended while Gibbous was down is caught up on restart', async () => {
  const t = await orch.createThread({ title: 'Slow one', cwd: repo });
  hang = true;
  await orch.send(t, 'take your time');
  assert.equal(t.status, 'running');
  orch.stop();
  hang = false;
  orch = await boot(); // the fake reports the session as no longer running
  await until('thread idle', () => t.status === 'idle');
});

test('a send after Hermes reaped the live session re-attaches instead of failing', async () => {
  const t = await orch.createThread({ title: 'Plain chat', cwd: repo });
  const dead = await orch.attach(t);
  fake.reap(dead); // Hermes now answers 4001 "session not found" for the old runtime id
  await orch.send(t, 'still there?');
  assert.notEqual(orch.liveId(t), dead);
  assert.equal(t.error, undefined);
  await until('turn finished', () => t.lastText === 'done');
  assert.equal(t.status, 'idle');
});

test('a thread stuck on "running" after Hermes finished is set back to idle', async () => {
  const t = await orch.createThread({ title: 'Stuck chat', cwd: repo });
  await orch.attach(t);
  t.status = 'running'; t.updatedAt = Date.now() - 60_000; // the message.complete never reached us
  await orch.reconcileRunning();
  assert.equal(t.status, 'idle');
  t.status = 'running'; t.updatedAt = Date.now();           // just started: leave it alone
  await orch.reconcileRunning();
  assert.equal(t.status, 'running');
  t.status = 'idle';
});

const prompts = (t: { sessionId: string }) => fake.prompts(t.sessionId);

test('queued prompts go out one per turn, in order, only after the running turn ends', async () => {
  const t = await orch.createThread({ title: 'Queue', cwd: repo });
  const sent: string[] = [];
  orch.on('change', ({ kind, data }) => { if (kind === 'queueSent' && data.threadId === t.id) sent.push(data.shown); });
  await orch.send(t, 'wait:first');
  await until('turn running', () => gates.length === 1);
  assert.deepEqual(await orch.enqueue(t, 'A @file', 'A').then(r => r.sent), false);
  await orch.enqueue(t, 'B');
  assert.deepEqual(prompts(t), ['wait:first']); // nothing reached Hermes while the turn runs
  orch.editQueued(t, t.queue![1].id, 'B edited');
  gates.shift()!();
  await until('queue drained', () => !t.queue && t.status === 'idle' && prompts(t).length === 3);
  assert.deepEqual(prompts(t), ['wait:first', 'A @file', 'B edited']);
  assert.deepEqual(sent, ['A', 'B edited']);
});

test('a Stop pauses the queue; resume and send now pick it up again', async () => {
  const t = await orch.createThread({ title: 'Paused', cwd: repo });
  await orch.send(t, 'hang:one');
  await until('running', () => t.status === 'running');
  await orch.enqueue(t, 'C'); await orch.enqueue(t, 'D');
  await orch.interrupt(t);
  await until('paused', () => t.queuePaused === true);
  assert.equal(t.status, 'idle');
  assert.deepEqual(prompts(t), ['hang:one']);
  await orch.sendQueuedNow(t, t.queue![1].id); // idle: D goes now, then C after D's turn
  await until('both sent', () => prompts(t).length === 3 && !t.queue && t.status === 'idle');
  assert.deepEqual(prompts(t), ['hang:one', 'D', 'C']);
  assert.equal(t.queuePaused, undefined);
});

test('send now during a turn stops it and sends that message right after, then the rest', async () => {
  const t = await orch.createThread({ title: 'Now', cwd: repo });
  await orch.send(t, 'hang:two');
  await until('running', () => t.status === 'running');
  await orch.enqueue(t, 'E'); await orch.enqueue(t, 'F');
  await orch.sendQueuedNow(t, t.queue![1].id);
  await until('drained', () => prompts(t).length === 3 && !t.queue && t.status === 'idle');
  assert.deepEqual(prompts(t), ['hang:two', 'F', 'E']);
  assert.equal(t.queuePaused, undefined);
});

test('an idle thread sends a queued message immediately', async () => {
  const t = await orch.createThread({ title: 'Idle', cwd: repo });
  assert.equal((await orch.enqueue(t, 'G')).sent, true);
  await until('turn finished', () => t.lastText === 'done' && t.status === 'idle');
  assert.deepEqual(prompts(t), ['G']);
});
