// Walks a deployed (or `wrangler dev`) Gibbous demo like a visitor: signs in with the link, opens every main screen,
// sends a prompt from Home and from an existing thread, approves, waits for the reply, answers the seeded approval,
// and opens the terminal panel. Fails on console errors, connection banners or error toasts.
// Usage: node e2e/demo/check-demo.ts [https://demo.gibbousapp.com] [--shots=<dir>]
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer-core';
import { CHROME, SCRATCH, sleep } from './lib.ts';

const BASE = (process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'https://demo.gibbousapp.com').replace(/\/$/, '');
const SHOTS = process.argv.find(a => a.startsWith('--shots='))?.slice(8) ?? path.join(SCRATCH, 'demo-check');
const TOKEN = /"DEMO_TOKEN":\s*"([^"]+)"/.exec(fs.readFileSync(path.join(import.meta.dirname, 'worker/wrangler.jsonc'), 'utf8'))![1];
fs.mkdirSync(SHOTS, { recursive: true });

const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: null, args: ['--hide-scrollbars'] });
const problems: string[] = [];
try {
  const page = await b.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { get: () => false });
  });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|geojs|ipapi|ERR_BLOCKED/i.test(m.text())) errors.push(m.text()); });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*geojs*'] });
  await page.goto(`${BASE}/login?token=${TOKEN}`, { waitUntil: 'networkidle2' });
  await page.bringToFront();
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitForFunction(() => !!document.querySelector('[data-pane]'), { timeout: 20000 });
  const shot = (n: string) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) as `${string}.png` });
  const check = async (where: string) => {
    const bad = await page.evaluate(() => {
      const t = document.body.innerText;
      return ['Lost the connection', 'Hermes is starting', 'Gibbous was updated', 'not connected', 'screen crashed', 'Something went wrong'].filter(x => t.includes(x));
    });
    for (const x of bad) problems.push(`${where}: "${x}" on screen`);
    for (const e of errors.splice(0)) problems.push(`${where}: console ${e.slice(0, 200)}`);
  };
  const go = async (hash: string, wait = 1500) => { await page.evaluate(h => { location.hash = h; }, hash); await sleep(wait); await check(hash); };
  const clickText = async (text: string, timeout = 30000) => {
    await page.waitForFunction(t => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === t), { timeout }, text);
    await page.evaluate(t => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.innerText.trim() === t)!.click(), text);
  };
  const waitText = (t: string, timeout = 40000) => page.waitForFunction(t => document.body.innerText.includes(t), { timeout }, t);

  const state = await page.evaluate(() => fetch('/api/state').then(r => r.json()));
  console.log(`signed in: ${state.threads.length} threads, ${state.requests.length} open request(s), build ${state.build}`);
  await go('#/', 2000); await shot('01-home');
  for (const t of state.threads) await go(`#/t/${t.id}`, 1300);
  await go('#/inbox'); await shot('02-inbox');
  await go('#/kanban'); await go(`#/board/${state.projects[0].id}`, 2000); await shot('03-board');
  await go('#/sessions'); await go('#/sessions/claude');
  // Open (import) a Claude Code session from the Sessions screen.
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-sessions-list] [data-vim-item]')?.focus());
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.startsWith('#/t/'), { timeout: 15000 }).catch(() => problems.push('sessions: opening a Claude Code session did nothing'));
  await sleep(2500); await check('sessions → import'); await shot('03b-imported-session');
  for (const s of ['general', 'appearance', 'notifications', 'phone', 'usage', 'skills', 'mcp', 'jobs', 'platforms', 'memory', 'config', 'update']) await go(`#/settings/${s}`, 1000);
  await shot('04-settings');
  await go('#/settings/usage', 2000); await shot('04b-usage');

  // A prompt from Home: new thread, scripted turn, approval, reply.
  await go(`#/new/${state.projects[0].id}`);
  await page.waitForSelector('textarea[aria-label="First message"]', { visible: true });
  await page.focus('textarea[aria-label="First message"]');
  await page.keyboard.type('Make rejected requests say when to retry, and push it.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.startsWith('#/t/'), { timeout: 15000 });
  await waitText('Allow once'); await sleep(800); await shot('05-turn-approval'); await check('turn (approval)');
  await clickText('Allow once');
  await waitText('is pushed', 40000); await sleep(1500); await shot('06-turn-done'); await check('turn (done)');
  const tid = await page.evaluate(() => location.hash.slice(4));
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(2500);
  if (!(await page.evaluate(() => document.body.innerText.includes('is pushed')))) problems.push('turn: reply gone after reload');
  await check('turn (reload)');

  // A prompt in an existing thread, through the composer.
  const bench = state.threads.find((t: any) => /Benchmark/.test(t.title)) ?? state.threads.find((t: any) => !t.readOnly && t.status === 'idle');
  await go(`#/t/${bench.id}`, 2000);
  await page.focus('textarea[aria-label="Message"]');
  await page.keyboard.type('Now add retry headers too.');
  await page.keyboard.press('Enter');
  await waitText('Allow once'); await clickText('Allow once');
  await page.waitForFunction(() => (document.body.innerText.match(/is pushed/g) ?? []).length >= 1, { timeout: 40000 }); await sleep(1500);
  await shot('07-existing-thread'); await check('existing thread turn');

  // The seeded approval (TypeScript upgrade).
  const ts = state.requests[0]?.threadId;
  if (ts) { await go(`#/t/${ts}`, 2000); await clickText('Allow once'); await waitText('lockfile changed', 40000); await sleep(1200); await shot('08-seeded-approval'); await check('seeded approval'); }

  // Terminal: refused politely.
  await go(`#/t/${tid}`, 1500);
  await page.click('button[aria-label="Terminal"]').catch(() => problems.push('terminal: no Terminal button'));
  await waitText('not available in the demo', 15000).catch(() => problems.push('terminal: no "not available" line'));
  await sleep(600); await shot('09-terminal'); await check('terminal');
  console.log(`screenshots → ${SHOTS}`);
} finally {
  await b.close();
}
if (problems.length) { console.log('PROBLEMS:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('✓ demo check passed');
