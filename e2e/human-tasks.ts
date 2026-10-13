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
  fake.session(t.sessionId)!.rows.push({ row_id: 1, role: 'assistant', text: 'Needs you:\n\n- **Hardware:** Plug in the device.\n- Decide the merge order.\n\nApprove the pairing.\n\n```txt\nno action here\n```', timestamp: Date.now() / 1000 } as any);
  console.log('thread created');
  const mcp = async (method: string, params?: unknown, identity?: string) => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, ...(identity ? { 'X-Hermes-Session-Id': identity } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); assert.equal(r.status, 200); return r.json();
  };
  assert.equal((await mcp('tools/list')).result.tools.length, 3);
  const bad = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{}' }); assert.equal(bad.status, 401);
  assert.equal((await mcp('tools/call', { name: 'gibbous_request_human_task', arguments: { thread: 'unknown', text: 'Check.' } })).result.isError, true);
  const chrome = process.env.CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/chromium');
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', e => { errors.push((e as Error).message); console.log((e as Error).stack); });
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
  await page.waitForSelector('.prose-moon li');
  await page.hover('.prose-moon li'); await page.click('.prose-moon li > .reply-task-action');
  // The badge counts unread threads now, not tasks: follow the open task count on the server instead.
  const openTasks = (n: number) => until(async () => ((await api('/api/state')).threads[0]?.humanTasks ?? []).filter((x: any) => x.doneAt == null).length === n);
  await page.waitForSelector('[aria-label="For me tasks"]'); await openTasks(1);
  let tasks = (await api('/api/state')).threads[0].humanTasks;
  assert.equal(tasks[0].text, 'Hardware: Plug in the device.'); assert.equal(tasks[0].by, 'user');
  assert.equal(await page.$('pre .reply-task-action'), null);
  await page.click('button[aria-label="More"]'); await clickText('Add a task for me…');
  await page.type('textarea[aria-label="Task for me"]', 'Choose a profile.'); await clickText('Save task');
  await openTasks(2);
  await page.click('[aria-label="For me tasks"] button[aria-label^="Edit task:"]');
  await page.focus('[aria-label="Edit task"]'); await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Edit task"]')!.select()); await page.type('[aria-label="Edit task"]', 'Check the display.'); await page.keyboard.press('Enter');
  await until(async () => (await api('/api/state')).threads[0].humanTasks[0].text === 'Check the display.');
  await page.click('[aria-label="For me tasks"] button[role="checkbox"]'); await openTasks(1); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === '1 done')); await clickText('1 done');
  await page.click('[aria-label="For me tasks"] button[aria-label^="Reopen task:"]'); await openTasks(2);
  await api(`/api/threads/${t.id}/human-tasks`, 'POST', { text: 'Temporary manual task.' });
  // Only the first few open tasks show; the rest sit behind "N more".
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="For me tasks"] button')].some(b => /more$/.test(b.textContent ?? '') || b.getAttribute('aria-label') === 'Remove task: Temporary manual task.'));
  await page.evaluate(() => ([...document.querySelectorAll<HTMLButtonElement>('[aria-label="For me tasks"] button')].find(b => /more$/.test(b.textContent ?? '')))?.click());
  await page.waitForSelector('[aria-label="Remove task: Temporary manual task."]');
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[aria-label="Remove task: Temporary manual task."]')!.click());
  await until(async () => (await api('/api/state')).threads[0].humanTasks.length === 2);
  await openTasks(2);
  // The app badge counts unread threads, not tasks: the open thread is read, so nothing to show.
  assert.equal(await page.evaluate(() => (window as any).taskBadges.at(-1) ?? 0), 0);
  assert.equal(await page.evaluate(() => (window as any).taskNotices.length), 0);
  const filed = await mcp('tools/call', { name: 'gibbous_request_human_task', arguments: { thread: t.id, tasks: ['Approve the purchase.', 'Sign in.', 'Pick the board.'] } });
  const ids = JSON.parse(filed.result.content[0].text).created; assert.equal(ids.length, 3);
  await openTasks(5); await page.waitForFunction(() => (window as any).taskNotices.length === 1);
  assert.equal(await page.evaluate(() => (window as any).taskNotices[0].title), 'Gibbous needs you · 3 things');
  assert.equal(JSON.parse((await mcp('tools/call', { name: 'gibbous_list_human_tasks', arguments: { thread: t.id } })).result.content[0].text).tasks.length, 5);
  await mcp('tools/call', { name: 'gibbous_complete_human_task', arguments: { thread: t.id, task_id: ids[0] } }); await openTasks(4);
  await api(`/api/threads/${t.id}/human-tasks/${ids[1]}`, 'PATCH', { text: 'Sign in to the dashboard.' });
  await api(`/api/threads/${t.id}/human-tasks/${ids[2]}`, 'DELETE'); await openTasks(3);
  await page.click('[aria-label="For me tasks"] [aria-label="Add a task for me"]'); await page.type('[aria-label="New task"]', 'Run a hardware test.');
  await page.evaluate(() => document.querySelector('[aria-label="New task"]')!.closest('form')!.requestSubmit()); await openTasks(4);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.waitForSelector('.prose-moon li');
  await page.evaluate(() => document.querySelector('.prose-moon li')!.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: document.querySelector('.prose-moon li')!, clientX: 100, clientY: 400 })] })));
  await page.waitForSelector('[role="menu"]'); await clickText('Add to For me'); await openTasks(5);
  tasks = (await api('/api/state')).threads[0].humanTasks; assert.equal(tasks.at(-1).text, 'Hardware: Plug in the device.');
  // The sidebar only counts a thread's open tasks; ticking happens in the thread's card.
  await page.waitForFunction(() => !!document.querySelector('nav [aria-label="5 tasks for you"]'));
  await page.click('[aria-label="For me tasks"] button[role="checkbox"]'); await openTasks(4);
  await api(`/api/threads/${t.id}`, 'DELETE'); await page.waitForFunction(() => document.title === 'Gibbous');
  assert.equal((await api('/api/state')).threads.length, 0);
  assert.deepEqual(errors, []);
  console.log('human task list smoke passed: reply hover/phone long-press, checklist CRUD/reopen, MCP batch/list/complete, debounce, badges');
} finally {
  await browser?.close();
  if (server.exitCode == null) { const stopped = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await stopped; }
  await fake.close(); fs.rmSync(home, { recursive: true, force: true });
}
