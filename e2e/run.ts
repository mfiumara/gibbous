// End-to-end UI check: an isolated Gibbous (temp state, port 7979) on top of the already running Hermes, driven by
// system Chrome at desktop and phone sizes. Walks every screen, adds a project and a backlog task, fails on any
// console error. Never sends a prompt, so it costs no tokens.  Run: pnpm build && pnpm e2e
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer, { type Page } from 'puppeteer-core';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 7979, BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-e2e-'));
const live = `${process.env.HOME}/.gibbous/hermes-backend.json`;
if (fs.existsSync(live)) fs.copyFileSync(live, path.join(home, 'hermes-backend.json')); // reuse the running Hermes
const repo = path.join(home, 'repo');
fs.mkdirSync(repo);
for (const a of [['init', '-q', '-b', 'main'], ['-c', 'user.email=e@e', '-c', 'user.name=e', 'commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: repo });

const server = spawn(process.execPath, ['server/main.ts'], { env: { ...process.env, GIBBOUS_HOME: home, GIBBOUS_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
const failures: string[] = [];
try {
  await new Promise<void>((res, rej) => { server.stdout!.on('data', d => String(d).includes('Gibbous on') && res()); server.on('exit', c => rej(new Error(`server exited ${c}`))); });
  const token = JSON.parse(fs.readFileSync(path.join(home, 'secret.json'), 'utf8')).accessToken;
  const project = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: `gibbous_auth=${token}` }, body: JSON.stringify({ path: repo, name: 'e2e' }) })).json();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

  const open = async (w: number, h: number) => {
    const page = await browser!.newPage();
    await page.setViewport({ width: w, height: h, isMobile: w < 600, hasTouch: w < 600 });
    page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_ABORTED/.test(m.text())) failures.push(`[${w}px console] ${m.text()}`); });
    page.on('pageerror', e => failures.push(`[${w}px pageerror] ${(e as Error).message}`));
    await page.goto(`${BASE}/login?token=${token}`, { waitUntil: 'networkidle0' });
    return page;
  };
  const visit = async (page: Page, hash: string, expect: string) => {
    await page.evaluate(h => { location.hash = h; }, hash);
    try { await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 8000 }, expect); }
    catch { failures.push(`${hash}: "${expect}" never appeared`); return; }
    // Every control needs an accessible name (text, aria-label, a <label>, title or placeholder).
    const nameless = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=switch]')]
      .filter(e => e.getClientRects().length && !(e.innerText?.trim() || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title || (e as HTMLInputElement).placeholder
        || e.closest('label')?.innerText.trim() || (e.id && document.querySelector(`label[for="${e.id}"]`))))
      .map(e => e.outerHTML.slice(0, 140)));
    for (const n of new Set(nameless)) failures.push(`${hash}: control without a name: ${n}`);
  };
  const clickText = (page: Page, tag: string, text: string) => page.evaluate((tag, text) => {
    const el = [...document.querySelectorAll<HTMLElement>(tag)].find(e => e.innerText.trim() === text);
    if (!el) throw new Error(`no ${tag} "${text}"`);
    el.click();
  }, tag, text);

  // Desktop: every screen and settings tab.
  const page = await open(1440, 900);
  await visit(page, '#/', 'e2e');
  await visit(page, '#/inbox', 'Inbox');
  await visit(page, '#/sessions', 'sessions');
  await visit(page, '#/rooms', 'Rooms');
  await visit(page, '#/automations', 'New job');
  await visit(page, '#/search?q=hello', 'hello');
  for (const [tab, text] of [['general', 'General'], ['appearance', 'Theme'], ['notifications', 'Notifications'], ['phone', 'Phone'], ['coordinator', 'Coordinator'],
    ['playbooks', 'Playbooks'], ['maintenance', 'Maintenance'], ['usage', 'Spend'], ['profiles', 'Profiles'], ['skills', 'Skills'], ['mcp', 'MCP'],
    ['jobs', 'Scheduled'], ['platforms', 'Messaging'], ['memory', 'Memory'], ['vault', 'Vault'], ['config', 'Config'], ['hosts', 'Hosts'], ['update', 'Compatibility']])
    await visit(page, `#/settings/${tab}`, text);

  // Board: add a backlog task through the modal.
  await visit(page, `#/board/${project.id}`, 'Add a task');
  await clickText(page, 'button', 'Add a task');
  await page.waitForSelector('dialog[open] input');
  await page.type('dialog[open] input', 'E2E task');
  await page.type('dialog[open] textarea', 'Do nothing; this is a UI test.');
  await clickText(page, 'button', 'Add to backlog');
  await page.waitForFunction(() => document.querySelector('section[aria-label="Backlog"]')?.textContent?.includes('E2E task'), { timeout: 5000 }).catch(() => failures.push('task card never appeared in Backlog'));
  const tasks = (await (await fetch(`${BASE}/api/state`, { headers: { Cookie: `gibbous_auth=${token}` } })).json()).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'backlog');

  // Backup → restore round trip; the diagnostics bundle never carries the access token.
  const auth = { Cookie: `gibbous_auth=${token}` };
  const saved = await (await fetch(`${BASE}/api/backup`, { headers: auth })).json();
  assert.equal(saved.tasks.length, 1);
  assert.equal(saved.push, undefined);
  const r = await fetch(`${BASE}/api/restore`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ ...saved, tasks: [] }) });
  assert.equal(r.status, 200);
  assert.equal((await (await fetch(`${BASE}/api/state`, { headers: auth })).json()).tasks.length, 0);
  assert.ok(fs.readdirSync(home).some(f => f.startsWith('state.json.before-restore')));
  await fetch(`${BASE}/api/restore`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(saved) });
  await visit(page, '#/settings/maintenance', 'Copy debug bundle');
  const diag = (await (await fetch(`${BASE}/api/diagnostics`, { headers: auth })).json()).text;
  assert.ok(!diag.includes(token) && diag.includes('"counts"'));

  // Palette opens with ⌘K and jumps.
  await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta');
  await page.waitForSelector('[role=dialog][aria-label="Search or jump"]', { timeout: 3000 }).catch(() => failures.push('⌘K palette did not open'));
  await page.keyboard.press('Escape');

  // Every density fills the window exactly: nothing cut off at the bottom, no gap (viewport units ignore zoom).
  for (const d of ['compact', 'cozy', 'roomy']) {
    await page.evaluate(x => { localStorage.setItem('gibbous.density', x); document.documentElement.dataset.density = x; }, d);
    await new Promise(r => setTimeout(r, 150));
    const r = await page.evaluate(() => { const b = document.getElementById('root')!.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight }; });
    if (Math.abs(r.top) > 1 || Math.abs(r.bottom - r.h) > 1) failures.push(`density ${d}: app spans ${r.top}..${r.bottom} in a ${r.h}px window`);
  }
  await page.evaluate(() => { localStorage.setItem('gibbous.density', 'cozy'); document.documentElement.dataset.density = 'cozy'; });

  // Phone: home, a thread-less board and settings fit the viewport without horizontal scroll.
  const phone = await open(390, 844);
  for (const [hash, text] of [['#/', 'e2e'], [`#/board/${project.id}`, 'E2E task'], ['#/settings/phone', 'Phone']]) {
    await visit(phone, hash, text);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) failures.push(`${hash} scrolls sideways on a phone (${overflow}px)`);
  }
  // iOS zooms the page into any field rendered under 16px on focus; the density zoom counts toward that size.
  await visit(phone, '#/', 'e2e');
  for (const d of ['compact', 'cozy', 'roomy']) {
    const small = await phone.evaluate(x => {
      document.documentElement.dataset.density = x;
      return [...document.querySelectorAll('textarea, input:not([type=file]):not([type=checkbox]), select')].flatMap(el => {
        let z = 1; for (let e: Element | null = el; e; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1;
        const px = parseFloat(getComputedStyle(el).fontSize) * z;
        return px < 15.99 ? [`${el.getAttribute('aria-label') ?? el.tagName} ${px.toFixed(2)}px`] : [];
      });
    }, d);
    if (small.length) failures.push(`density ${d}: phone fields under 16px make iOS zoom on focus: ${small.join(', ')}`);
  }
  await phone.evaluate(() => { document.documentElement.dataset.density = 'cozy'; });
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(home, { recursive: true, force: true });
}
if (failures.length) { console.error(`✗ ${failures.length} problem(s):\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('✓ e2e passed');
