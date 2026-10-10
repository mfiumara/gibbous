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
const fake = fakeHermes((_prompt, s) => {
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
