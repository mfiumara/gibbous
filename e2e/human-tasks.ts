// Isolated feature smoke, no prompts or real Hermes config writes. pnpm build && node e2e/human-tasks.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { fakeHermes } from './demo/fake-hermes.ts';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-human-smoke-'));
const token = randomBytes(16).toString('hex');
const fake = fakeHermes({ token, pick: () => async () => 'ok', home });
fs.writeFileSync(path.join(home, 'hermes-backend.json'), JSON.stringify({ port: await fake.listen(), token }));
const port = Number(process.env.HUMAN_TASK_TEST_PORT ?? 7994), base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/main.ts'], { env: { ...process.env, GIBBOUS_HOME: home, GIBBOUS_PORT: String(port), HERMES_BIN: path.join(home, 'missing-hermes') }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let stderr = ''; server.stderr!.on('data', b => { stderr += String(b); });
try {
  await new Promise<void>((resolve, reject) => { server.stdout!.on('data', b => { if (String(b).includes('Gibbous on')) resolve(); }); server.on('exit', c => reject(new Error(`server exited ${c}`))); });
  const auth = JSON.parse(fs.readFileSync(path.join(home, 'secret.json'), 'utf8')).accessToken;
  const bearer = JSON.parse(fs.readFileSync(path.join(home, 'human-task-mcp-secret.json'), 'utf8')).token;
  const headers = { 'Content-Type': 'application/json', Cookie: `gibbous_auth=${auth}` };
  const api = async (url: string, method = 'GET', body?: unknown) => {
    const r = await fetch(base + url, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(15_000) }); const out = await r.json(); assert.equal(r.status, 200, out.error ?? url); return out;
  };
  const until = async (ready: () => Promise<boolean>) => { const end = Date.now() + 15_000; while (!await ready()) { if (Date.now() > end) throw new Error('server not ready'); await new Promise(r => setTimeout(r, 50)); } };
  await until(async () => (await api('/api/state')).hermes.ready);
  console.log('ready');
  const t = await api('/api/threads', 'POST', { title: 'Device setup', cwd: home });
  console.log('thread created');
  const mcp = async (method: string, params?: unknown, identity?: string) => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, ...(identity ? { 'X-Hermes-Session-Id': identity } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); assert.equal(r.status, 200); return r.json();
  };
  assert.equal((await mcp('tools/list')).result.tools.length, 2);
  const bad = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{}' }); assert.equal(bad.status, 401);
  assert.equal((await mcp('tools/call', { name: 'gibbous_request_human_task', arguments: { thread: 'unknown', text: 'Check.' } })).result.isError, true);
  const chrome = process.env.CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/chromium');
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push((e as Error).message));
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    (window as any).taskBadges = []; (window as any).taskNotices = [];
    (window as any).webkit = { messageHandlers: { gibbousBadge: { postMessage(n: number) { (window as any).taskBadges.push(n); } } } };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', e => { try { const frame = JSON.parse(e.data); if (frame.params?.kind === 'notify') (window as any).taskNotices.push(frame.params.data); } catch {} });
      }
    };
  });
  await page.goto(`${base}/login?token=${auth}&next=${encodeURIComponent(`#/t/${t.id}`)}`, { waitUntil: 'networkidle0' });
  console.log('page open');
  const clickText = async (text: string) => page.evaluate(text => { const el = [...document.querySelectorAll<HTMLElement>('button')].find(x => x.innerText.trim() === text); if (!el) throw new Error(`missing ${text}`); el.click(); }, text);
  await page.click('button[aria-label="More"]'); await clickText('Add a task for me…');
  await page.waitForSelector('textarea[aria-label="Task for me"]'); await page.type('textarea[aria-label="Task for me"]', 'Plug in the device.'); await clickText('Save task');
  await page.waitForSelector('[aria-label="For me task"]'); await page.waitForFunction(() => document.title === '(1) Gibbous');
  assert.equal((await api('/api/state')).threads[0].humanTask.by, 'user');
  assert.equal(await page.evaluate(() => (window as any).taskBadges.at(-1)), 1);
  await clickText('Edit'); await page.waitForSelector('textarea[aria-label="Task for me"]');
  await page.focus('textarea[aria-label="Task for me"]'); await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task for me"]')!.select()); await page.type('textarea[aria-label="Task for me"]', 'Approve the pairing.'); await clickText('Save task');
  await page.waitForFunction(() => document.querySelector('[aria-label="For me task"]')?.textContent?.includes('Approve the pairing.'));
  assert.equal((await api('/api/state')).threads[0].humanTask.text, 'Approve the pairing.');
  await page.click('nav button[role="checkbox"]'); await page.waitForFunction(() => document.title === 'Gibbous');
  assert.ok((await api('/api/state')).threads[0].humanTask.doneAt);
  assert.equal(await page.evaluate(() => (window as any).taskBadges.at(-1)), 0);
  await api(`/api/threads/${t.id}/human-task`, 'PUT', { text: 'Check the display.' }); await page.waitForSelector('[aria-label="For me task"]');
  await clickText('Remove'); await page.waitForFunction(() => !document.querySelector('[aria-label="For me task"]'));
  assert.equal((await api('/api/state')).threads[0].humanTask, undefined);
  assert.equal(await page.evaluate(() => (window as any).taskNotices.length), 0, 'manual tasks do not notify');
  assert.equal((await mcp('tools/call', { name: 'gibbous_request_human_task', arguments: { text: 'Sign in to the dashboard.' } }, t.sessionId)).result.isError, undefined);
  await page.waitForFunction(() => document.title === '(1) Gibbous');
  assert.equal((await api('/api/state')).threads[0].humanTask.by, 'agent');
  await page.waitForFunction(() => (window as any).taskNotices.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as any).taskNotices[0]), { kind: 'input', title: 'Gibbous needs you', body: 'Sign in to the dashboard.', url: `/#/t/${t.id}` });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.click('button[aria-label="Open sidebar"]');
  await page.waitForFunction(() => { const b = document.querySelector('nav button[role="checkbox"]')!.getBoundingClientRect(); return b.left >= 0; });
  await page.click('nav button[role="checkbox"]'); await page.waitForFunction(() => document.title === 'Gibbous');
  assert.ok((await api('/api/state')).threads[0].humanTask.doneAt);
  await api(`/api/threads/${t.id}/human-task`, 'PUT', { text: 'Plug in the device.' });
  await mcp('tools/call', { name: 'gibbous_complete_human_task', arguments: { thread: t.id } });
  await page.waitForFunction(() => document.title === 'Gibbous');
  await api(`/api/threads/${t.id}/human-task`, 'PUT', { text: 'Approve the purchase.' });
  await page.waitForFunction(() => document.title === '(1) Gibbous');
  await api(`/api/threads/${t.id}`, 'DELETE');
  await page.waitForFunction(() => document.title === 'Gibbous');
  assert.equal((await api('/api/state')).threads.length, 0);
  assert.deepEqual(errors, []);
  console.log('human task smoke passed: REST/MCP/auth, desktop+phone set/edit/done/remove, tab+native badge, deletion');
} finally {
  await browser?.close();
  if (server.exitCode == null) { const stopped = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await stopped; }
  await fake.close(); fs.rmSync(home, { recursive: true, force: true });
}
