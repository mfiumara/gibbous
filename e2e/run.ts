// End-to-end UI check: an isolated Gibbous (temp state, port 7979) on top of the already running Hermes, driven by
// system Chrome at desktop and phone sizes. Walks every screen, adds a project, opens the Hermes kanban views (read
// only), fails on any console error. Never sends a prompt or changes a kanban board, so it costs nothing.  Run: pnpm build && pnpm e2e
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
  await visit(page, '#/sessions/gibbous', 'Threads you started here'); // Sessions, sorted by the tool that ran them
  if (await page.evaluate(() => /Hermes history|Message Hermes/.test(document.body.innerText))) failures.push('#/sessions: old "Hermes history" copy is back');
  await visit(page, '#/import', 'Bring your sessions in'); // the import picker (read-only until you press Import)
  await visit(page, '#/rooms', 'Rooms');
  await visit(page, '#/automations', 'New job');
  await visit(page, '#/search?q=hello', 'hello');
  for (const [tab, text] of [['general', 'General'], ['appearance', 'Theme'], ['notifications', 'Notifications'], ['phone', 'Phone'],
    ['maintenance', 'Maintenance'], ['usage', 'Across every profile'], ['profiles', 'Profiles'], ['skills', 'Skills'], ['mcp', 'MCP'],
    ['jobs', 'Scheduled'], ['platforms', 'Messaging'], ['memory', 'Memory'], ['vault', 'Vault'], ['config', 'Config'], ['hosts', 'Hosts'], ['update', 'Compatibility']])
    await visit(page, `#/settings/${tab}`, text);

  // Kanban: the index lists Hermes' boards; a project without a board offers to link one (nothing is linked here).
  await visit(page, '#/kanban', 'Kanban');
  await visit(page, `#/board/${project.id}`, 'No board for e2e');
  const kb = await (await fetch(`${BASE}/api/kanban/boards`, { headers: { Cookie: `gibbous_auth=${token}` } })).json();
  assert.ok(Array.isArray(kb.boards) && typeof kb.matches === 'object', `kanban boards: ${JSON.stringify(kb).slice(0, 200)}`);
  assert.equal(kb.matches[project.id], undefined);
  const bad = await fetch(`${BASE}/api/kanban/boards/..%2Fx/tasks`, { headers: { Cookie: `gibbous_auth=${token}` } });
  assert.equal(bad.status, 400);
  const st = await (await fetch(`${BASE}/api/state`, { headers: { Cookie: `gibbous_auth=${token}` } })).json();
  for (const k of ['tasks', 'plans', 'playbooks', 'schedules']) assert.equal(st[k], undefined, `state still has ${k}`);

  // Backup → restore round trip; the diagnostics bundle never carries the access token.
  const auth = { Cookie: `gibbous_auth=${token}` };
  const saved = await (await fetch(`${BASE}/api/backup`, { headers: auth })).json();
  assert.equal(saved.projects.length, 1);
  assert.equal(saved.push, undefined);
  const r = await fetch(`${BASE}/api/restore`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ ...saved, projects: [], tasks: [{ id: 'old' }] }) });
  assert.equal(r.status, 200);
  const restored = await (await fetch(`${BASE}/api/state`, { headers: auth })).json();
  assert.equal(restored.projects.length, 0);
  assert.equal(restored.tasks, undefined); // an old backup's task board is dropped on restore
  assert.ok(fs.readdirSync(home).some(f => f.startsWith('state.json.before-restore')));
  await fetch(`${BASE}/api/restore`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(saved) });
  await visit(page, '#/settings/maintenance', 'Copy debug bundle');
  const diag = (await (await fetch(`${BASE}/api/diagnostics`, { headers: auth })).json()).text;
  assert.ok(!diag.includes(token) && diag.includes('"counts"'));

  // Palette opens with ⌘K and jumps.
  await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta');
  await page.waitForSelector('[role=dialog][aria-label="Search or jump"]', { timeout: 3000 }).catch(() => failures.push('⌘K palette did not open'));
  await page.keyboard.press('Escape');

  // An app, not a page: chrome isn't selectable and has no browser context menu; messages and fields keep both.
  // #/new: on an empty state plain #/ may show the first-run import picker, which has no message box.
  await visit(page, '#/new', 'e2e');
  await page.waitForSelector('textarea', { timeout: 5000 }).catch(() => {});
  const feel = await page.evaluate(() => {
    const sel = (e: Element | null) => e ? getComputedStyle(e).userSelect : 'missing';
    const menu = (e: Element | null) => { const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); e?.dispatchEvent(ev); return ev.defaultPrevented; };
    // A timeline message and a user bubble, built from the real classes (no thread exists in this run).
    const msg = Object.assign(document.createElement('div'), { innerHTML: '<div class="prose-moon"><p>reply</p></div><div class="rounded-br-md"><div class="whitespace-pre-wrap">prompt</div></div>' });
    document.getElementById('root')!.append(msg);
    const nav = document.querySelector('nav a[href]'), box = document.querySelector('textarea');
    const r = { nav: sel(nav), button: sel(document.querySelector('button')), prose: sel(msg.querySelector('.prose-moon p')), bubble: sel(msg.querySelector('.whitespace-pre-wrap')), box: sel(box),
      navMenu: menu(nav), boxMenu: menu(box) };
    msg.remove();
    return r;
  });
  if (feel.nav !== 'none' || feel.button !== 'none') failures.push(`chrome text is selectable: ${JSON.stringify(feel)}`);
  if (feel.prose !== 'text' || feel.bubble !== 'text' || feel.box !== 'text') failures.push(`message/field text isn't selectable: ${JSON.stringify(feel)}`);
  if (!feel.navMenu || feel.boxMenu) failures.push(`browser context menu: chrome should block it, fields keep it: ${JSON.stringify(feel)}`);

  // Every density fills the window exactly: nothing cut off at the bottom, no gap (viewport units ignore zoom).
  for (const d of ['compact', 'cozy', 'roomy']) {
    await page.evaluate(x => { localStorage.setItem('gibbous.density', x); document.documentElement.dataset.density = x; }, d);
    await new Promise(r => setTimeout(r, 150));
    const r = await page.evaluate(() => { const b = document.getElementById('root')!.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight }; });
    if (Math.abs(r.top) > 1 || Math.abs(r.bottom - r.h) > 1) failures.push(`density ${d}: app spans ${r.top}..${r.bottom} in a ${r.h}px window`);
  }
  await page.evaluate(() => { localStorage.setItem('gibbous.density', 'cozy'); document.documentElement.dataset.density = 'cozy'; });

  // Phone: home, the kanban screens and settings fit the viewport without horizontal scroll.
  const phone = await open(390, 844);
  for (const [hash, text] of [['#/', 'e2e'], ['#/kanban', 'Kanban'], [`#/board/${project.id}`, 'No board for'], ['#/sessions/codex', 'Codex'], ['#/settings/phone', 'Phone'], ['#/import', 'Bring your sessions in']]) {
    await visit(phone, hash, text);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) failures.push(`${hash} scrolls sideways on a phone (${overflow}px)`);
    // Square/round controls (size-N) squeezed by a crowded flex row turn into ovals.
    const squished = await phone.evaluate(() => [...document.querySelectorAll<HTMLElement>('[class*="size-"]')].flatMap(el => {
      if (!/(^|\s)(pointer-coarse:)?size-\d/.test(String(el.className)) || el.closest('svg')) return [];
      const r = el.getBoundingClientRect();
      return r.width && r.height && Math.abs(r.width - r.height) > 1.5 ? [`${el.getAttribute('aria-label') ?? el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`] : [];
    }));
    if (squished.length) failures.push(`${hash} squeezes square controls on a phone: ${squished.join(', ')}`);
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
