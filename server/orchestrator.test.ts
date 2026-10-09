// The task state machine end to end against a fake Hermes: queue → worker → review (changes, then approve) → merge,
// plus restart catch-up and merge guards. Real git, temp dirs, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-orch-'));
process.env.GIBBOUS_HOME = home;
process.env.GIBBOUS_TICK_MS = '50';
const { fakeHermes } = await import('./fake-hermes.ts');
const { HermesClient } = await import('./hermes.ts');
const { Orchestrator } = await import('./orchestrator.ts');
const { state, saveNow } = await import('./store.ts');

const repo = path.join(home, 'repo');
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
fs.mkdirSync(repo);
git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'README'), 'hi\n'); git('add', '-A'); git('commit', '-qm', 'init');

let hang = false, reviews = 0;
const fake = fakeHermes((prompt, s) => {
  if (/strict code reviewer/.test(prompt)) return ++reviews === 1 ? 'Looks off.\nVERDICT: CHANGES\n1. add a newline' : 'Good.\nVERDICT: APPROVE';
  if (hang) return new Promise<string>(() => {}); // a turn that is still going when Gibbous restarts
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

test('queued task runs, gets changes requested, fixes, is approved and merges', async () => {
  const p = await orch.addProject(repo);
  const task = orch.createTask({ projectId: p.id, title: 'Write out', prompt: 'write out.txt', status: 'queued' });
  await until('task in review', () => task.status === 'review');
  assert.equal(task.verdict, 'approve');
  assert.equal(task.reviewRounds, 2);
  const worker = orch.thread(task.threadId!)!;
  assert.equal(worker.role, 'worker');
  assert.equal(fs.readFileSync(path.join(worker.cwd, 'out.txt'), 'utf8'), '1\n2\n'); // first turn + the fix turn

  await assert.rejects(orch.mergeTask({ ...task, status: 'running' }, 'merge'), /not ready to merge/);
  fs.writeFileSync(path.join(repo, 'README'), 'dirty\n');
  await assert.rejects(orch.mergeTask(task, 'merge'), /uncommitted changes/);
  git('checkout', 'README');

  await orch.mergeTask(task, 'merge');
  assert.equal(task.status, 'done');
  assert.equal(fs.readFileSync(path.join(repo, 'out.txt'), 'utf8'), '1\n2\n');
  assert.equal(orch.thread(task.threadId!)!.status, 'archived');
  assert.ok(!fs.existsSync(worker.cwd), 'worktree removed after merge');
});

test('a turn that ended while Gibbous was down is caught up on restart', async () => {
  state.settings.autoReview = false;
  hang = true;
  const task = orch.createTask({ projectId: state.projects[0].id, title: 'Slow one', prompt: 'take your time', status: 'queued' });
  await until('worker running', () => !!task.threadId && orch.thread(task.threadId)!.status === 'running');
  orch.stop();
  hang = false;
  orch = await boot(); // the fake reports the session as no longer running
  await until('task in review', () => task.status === 'review');
  assert.equal(orch.thread(task.threadId!)!.status, 'idle');
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
