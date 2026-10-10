// Launch-video footage of Gibbous: stills and screen recordings of an isolated demo instance driven by a scripted
// fake Hermes. One command:   node e2e/demo/run.ts            (everything, ~10 min)
//                             node e2e/demo/run.ts --only=stills,phone,a,b,c,e,f,g,h,i,ios
// Output: ~/gibbous-launch/ui/{stills,video}. See e2e/demo/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { start, browser, open, go, shot, keys, record, smoothScroll, front, vsleep, sleep, OUT, type Opened } from './lib.ts';
import { seed, threadStatus } from './seed.ts';
import { iosFootage } from './ios.ts';
import { appStoreShots } from './appstore.ts';

const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
const want = (k: string) => !only || only.includes(k);

const HERO = 'Add a sliding-window limiter next to the token bucket. Same Limiter interface, configurable window and limit, and tests for bursts at window boundaries.';
const TYPED = 'Add Retry-After and RateLimit-Reset headers to the HTTP middleware when a request is rejected, and cover it with a test.';
const HOME = 'What should we work on';

const env = await start();
const b = await browser();
let heroId = '';
try {
  console.log('seeding…');
  const s = await seed(env);
  const seen = { '*': Date.now(), [s.threads.readme]: 0 };
  const prefs = { 'gibbous.lastProject': s.tide.id, 'gibbous.worktree': '1' };
  const d = await open(b, env, { seen, prefs });

  const composer = 'textarea[aria-label="Message"]';
  const typeInto = async (o: Opened, sel: string, text: string, delay = 0) => {
    await o.page.waitForSelector(sel, { visible: true });
    await o.page.focus(sel);
    for (const ch of text) { await o.page.keyboard.sendCharacter(ch); if (delay) await vsleep(delay * (0.7 + ((ch.charCodeAt(0) * 7) % 10) / 16)); }
  };
  const clickText = (o: Opened, sel: string, text: string) => o.page.evaluate((sel, text) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find(e => e.innerText.trim() === text);
    if (!el) throw new Error(`no ${sel} "${text}"`);
    el.click();
  }, sel, text);
  const blur = (o: Opened) => o.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const focused = (o: Opened) => o.page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.split('\n')[0] ?? '');
  const board = `#/board/${s.tide.id}`;

  // ── hero thread: needed by stills and the Changes clip ──
  const hero = await env.api('POST', '/api/threads', { projectId: s.tide.id, title: 'Sliding-window limiter', worktree: true });
  heroId = hero.id;
  await go(d, `#/t/${heroId}`);
  await typeInto(d, composer, HERO);
  await d.page.keyboard.press('Enter');
  await env.fake.waitHold('hero-tests');
  await vsleep(900);

  if (want('stills')) {
    console.log('stills (desktop 1920×1200 @2x)');
    await blur(d);
    await shot(d, 'desktop-02-thread-mid-turn');
    await d.page.evaluate(() => { const el = document.querySelector<HTMLElement>('[data-pane=doc]'); if (el) el.scrollTop = 0; });
    await vsleep(400);
    await shot(d, 'desktop-03-thread-reasoning-subagents-diff');
    await d.page.evaluate(() => { const el = document.querySelector<HTMLElement>('[data-pane=doc]'); if (el) el.scrollTop = el.scrollHeight; });
    await keys(d, ['Meta+\\']);
    await d.page.waitForFunction(() => document.body.innerText.includes('sliding-window.ts') && !!document.querySelector('[aria-pressed=true][aria-label=Changes]'), { timeout: 10000 });
    await vsleep(1200);
    await shot(d, 'desktop-04-changes-panel');
    await d.page.click('button[aria-label="Terminal"]');
    await d.page.waitForSelector('.xterm', { timeout: 10000 });
    await vsleep(1500);
    await d.page.click('.xterm');
    for (const cmd of ['git status --short', 'git diff --stat', 'git log --oneline --no-decorate -5']) { await d.page.keyboard.type(cmd, { delay: 15 }); await d.page.keyboard.press('Enter'); await vsleep(700); }
    await vsleep(600);
    await shot(d, 'desktop-05-terminal-panel');
    await d.page.click('button[aria-label="Terminal"]');   // close the panel
    await vsleep(400);
  }
  env.fake.release('hero-tests');
  await threadStatus(env, heroId, 'idle');
  await vsleep(1500);

  if (want('stills')) {
    await go(d, '#/', HOME); await blur(d);
    await shot(d, 'desktop-01-home');
    await go(d, board, 'Redis store'); await blur(d); await vsleep(600);
    await shot(d, 'desktop-06-kanban-board');
    await keys(d, ['l', 'l', 'l']);
    for (let i = 0; i < 8 && !(await focused(d)).startsWith('Redis store'); i++) await keys(d, ['j'], 120);
    await keys(d, ['Enter']); await d.page.waitForFunction(() => document.querySelector('dialog[open]')?.textContent?.includes('Dependencies'), { timeout: 10000 }); await vsleep(900);
    await shot(d, 'desktop-07-kanban-card');
    await keys(d, ['Escape']); await vsleep(400);
    await go(d, '#/sessions/claude', 'sliding log'); await blur(d); await vsleep(700);
    await shot(d, 'desktop-13-sessions-claude-code');
    await go(d, '#/sessions/messaging', 'token bucket across'); await blur(d); await vsleep(700);
    await shot(d, 'desktop-14-sessions-messaging');
    await go(d, `#/t/${heroId}`, 'sliding-window counter'); await blur(d);
    await keys(d, ['Meta+k']); await vsleep(400);
    await d.page.keyboard.type('redis', { delay: 60 }); await vsleep(600);
    await shot(d, 'desktop-08-command-palette');
    await keys(d, ['Escape']); await blur(d);
    await keys(d, ['?']); await vsleep(700);
    await shot(d, 'desktop-09-keyboard-shortcuts');
    await keys(d, ['Escape']); await vsleep(300);
    await go(d, '#/settings', 'Settings'); await blur(d); await vsleep(500);
    await shot(d, 'desktop-10-settings');
    await go(d, `#/t/${s.threads.ts}`, 'Allow once'); await blur(d); await vsleep(800);
    await shot(d, 'desktop-11-approval-request');
    await go(d, '#/inbox', 'Allow once'); await blur(d);
    await shot(d, 'desktop-12-inbox');
    // Tonight's moon, pinned to the totality of the 3 March 2026 eclipse.
    await go(d, `#/t/${heroId}`, 'sliding-window counter'); await blur(d);
    await moonAt(d, '2026-03-03T11:33:00Z'); await vsleep(800);
    await shot(d, 'desktop-15-moon-eclipse');
    await moonAt(d, null); await vsleep(400);
  }

  if (want('c')) {
    console.log('video c: Changes panel');
    await go(d, `#/t/${heroId}`, 'sliding-window counter'); await blur(d);
    await d.page.evaluate(() => localStorage.setItem('gibbous.lastPanel', 'changes'));
    await vsleep(800);
    await record(d, 'c-changes-panel', async () => {
      await vsleep(1200);
      await keys(d, ['Meta+\\']);
      await d.page.waitForFunction(() => document.body.innerText.includes('sliding-window.ts'), { timeout: 10000 });
      await vsleep(1600);
      const sel = await d.page.evaluate(() => {
        const els = [...document.querySelectorAll<HTMLElement>('.overflow-y-auto')].filter(e => e.scrollHeight > e.clientHeight + 200 && e.getBoundingClientRect().left > innerWidth * 0.45);
        els.forEach((e, i) => e.setAttribute('data-demo-scroll', String(i)));
        return els.length ? '[data-demo-scroll="0"]' : '';
      });
      if (sel) { await smoothScroll(d, sel, 1400, 4200); await vsleep(900); await smoothScroll(d, sel, 'bottom', 3200); await vsleep(1300); }
      await keys(d, ['Meta+\\']);
      await vsleep(1000);
    }, { fake: env.fake });
  }

  if (want('i')) {
    console.log('video i: the moon');
    await go(d, `#/t/${heroId}`, 'sliding-window counter'); await blur(d);
    await moonAt(d, '2026-02-21T18:00:00Z'); await vsleep(1500);
    await record(d, 'i-moon-phases', async () => {
      await vsleep(800);
      // Waxing crescent → full over a few seconds, then into the eclipse: Earth's shadow, then copper at totality.
      await sweep(d, Date.parse('2026-02-21T18:00:00Z'), Date.parse('2026-03-03T08:30:00Z'), 4000);
      await vsleep(400);
      await sweep(d, Date.parse('2026-03-03T08:30:00Z'), Date.parse('2026-03-03T11:33:00Z'), 3400);
      await vsleep(2000);
    }, { fake: env.fake });
    await moonAt(d, null);
  }

  if (want('b')) {
    console.log('video b: vim navigation');
    for (const sec of ['general', 'appearance', 'notifications', 'phone']) await go(d, `#/settings/${sec}`);
    await go(d, '#/inbox');
    await go(d, '#/', HOME); await blur(d); await vsleep(800);
    const log: { t: number; key: string }[] = [];
    let t0 = 0;
    const press = async (seq: string[], gap = 420) => { for (const k of seq) { if (!k.startsWith('wait:')) log.push({ t: +((Date.now() - t0) / 1000).toFixed(2), key: k }); await keys(d, [k], gap); } };
    await record(d, 'b-vim-navigation', async () => {
      t0 = Date.now();
      await vsleep(900);
      await press(['j', 'j', 'j', 'j', 'k', 'k', 'k'], 620);
      await press(['wait:400', 'l', 'wait:500', 'g', 'g', 'wait:1300', 'G', 'wait:1300', 'k', 'k', 'k', 'k', 'wait:700'], 260);
      await press(['g', 's', 'wait:1000', 'j', 'wait:500', 'j', 'wait:900'], 480);
      await press(['g', 'i', 'wait:1200', '?', 'wait:2400', 'Escape', 'wait:500', 'g', 'h', 'wait:900'], 300);
    }, { fake: env.fake });
    fs.writeFileSync(path.join(OUT, 'video', 'b-vim-navigation.keys.json'), JSON.stringify(log, null, 1));
  }

  if (want('h')) {
    console.log('video h: kanban board');
    await go(d, board, 'Redis store'); await blur(d); await vsleep(1200);
    await record(d, 'h-kanban-board', async () => {
      await vsleep(1400);
      // Hermes moves cards on its own: the docs worker hands in for review, the dispatcher starts the publish task.
      env.fake.move('t_9b47', 'review');
      env.fake.move('t_a1c3', 'running');
      await d.page.waitForFunction(() => !document.querySelector('section[data-col=ready]'), { timeout: 30000 });
      await vsleep(900);
      await keys(d, ['l'], 480);                 // into the board
      await keys(d, ['l', 'j', 'l', 'l', 'h'], 440);
      for (let i = 0; i < 8 && !(await focused(d)).startsWith('Redis store'); i++) await keys(d, ['j'], 420);
      await vsleep(300);
      await keys(d, ['Enter']);
      await d.page.waitForFunction(() => document.querySelector('dialog[open]')?.textContent?.includes('Dependencies'), { timeout: 10000 });
      await vsleep(1600);
      const sc = await d.page.evaluate(() => { const el = document.querySelector('dialog[open] .overflow-y-auto'); el?.setAttribute('data-demo-scroll', 'card'); return !!el; });
      if (sc) { await smoothScroll(d, '[data-demo-scroll=card]', 'bottom', 2000); await vsleep(1400); }
      await keys(d, ['Escape']);
      await vsleep(700);
    }, { fake: env.fake });
  }

  if (want('g')) {
    console.log('video g: sessions and import');
    await go(d, '#/sessions/cli', 'Profile the Redis'); await blur(d); await vsleep(1000);
    let tid = '';
    await record(d, 'g-sessions-import', async () => {
      await vsleep(1600);
      await keys(d, ['l'], 1300);                 // Paseo & editors
      await keys(d, ['l'], 1500);                 // Messaging (Discord)
      await keys(d, ['l'], 1100);                 // Claude Code
      await d.page.waitForFunction(() => document.body.innerText.includes('sliding log'), { timeout: 10000 });
      await vsleep(500);
      await d.page.evaluate(() => document.querySelector<HTMLElement>('[data-sessions-list] [data-vim-item]')?.focus());
      await vsleep(700);
      await keys(d, ['j', 'k'], 600);
      await vsleep(300);
      await keys(d, ['Enter']);
      await d.page.waitForFunction(() => location.hash.startsWith('#/t/'), { timeout: 15000 });
      tid = await d.page.evaluate(() => location.hash.slice(4));
      await d.page.waitForFunction(() => document.body.innerText.includes('Choosing a limiter'), { timeout: 15000 });
      await vsleep(3200);
    }, { fake: env.fake });
    if (want('stills')) { await blur(d); await shot(d, 'desktop-16-imported-session'); }
  }

  if (want('a')) {
    console.log('video a: prompt → streaming turn');
    await go(d, '#/new', HOME); await vsleep(600);
    await record(d, 'a-prompt-to-diff', async () => {
      await vsleep(700);
      await typeInto(d, 'textarea[aria-label="First message"]', TYPED, 34);
      await vsleep(450);
      await d.page.keyboard.press('Enter');
      await d.page.waitForFunction(() => location.hash.startsWith('#/t/'), { timeout: 10000 });
      const tid = await d.page.evaluate(() => location.hash.slice(4));
      await vsleep(600);
      await threadStatus(env, tid, 'idle');
      await vsleep(2200);
    }, { fake: env.fake });
  }

  if (want('e')) {
    console.log('video e: approving a request');
    await go(d, `#/t/${s.threads.ts}`, 'Allow once'); await blur(d); await vsleep(900);
    await record(d, 'e-approve-request', async () => {
      await vsleep(1800);
      await clickText(d, 'button', 'Allow once');
      await threadStatus(env, s.threads.ts, 'idle');
      await vsleep(2000);
    }, { fake: env.fake });
  }

  if (want('phone') || want('f')) {
    console.log('phone (402×874 @3x)');
    const prune = await env.api('POST', '/api/threads', { projectId: s.tide.id, title: 'Prune release branches', prompt: 'Delete the release branches on the remote that are already merged into main.' });
    await threadStatus(env, prune.id, 'needs_input');
    const p = await open(b, env, { phone: true, seen: { ...seen, '*': Date.now() }, prefs });
    if (want('phone')) {
      await go(p, `#/t/${heroId}`, 'sliding-window counter'); await blur(p); await vsleep(800);
      await shot(p, 'phone-01-thread');
      await go(p, `#/t/${prune.id}`, 'Allow once'); await blur(p); await vsleep(800);
      await shot(p, 'phone-02-approval');
      await go(p, '#/inbox', 'Allow once'); await blur(p);
      await shot(p, 'phone-03-inbox');
    }
    if (want('f')) {
      console.log('video f: phone approval');
      await go(p, `#/t/${prune.id}`, 'Allow once'); await blur(p); await vsleep(900);
      await record(p, 'f-phone-approval', async () => {
        await vsleep(2600);
        await clickText(p, 'button', 'Allow once');
        await threadStatus(env, prune.id, 'idle');
        await vsleep(3200);
      }, { fake: env.fake, shots: true, slow: 8 });
    }
    await p.page.close();
    await front(d);
  }

  if (want('ios')) await iosFootage(env, { heroId, project: s.tide.id });
  if (only?.includes('appstore')) await appStoreShots(env, { heroId, project: s.tide.id });

  console.log('done →', OUT);
} finally {
  await b.close();
  await env.stop();
}

// Pin the sky moon to a date (or back to now) and redraw it and the moonlight tint at once.
async function moonAt(o: Opened, iso: string | null) {
  await o.page.evaluate(v => { v ? localStorage.setItem('gibbous.moonAt', v) : localStorage.removeItem('gibbous.moonAt'); (window as any).__moonRedraw?.(); }, iso);
}
// Ease the pinned date from one instant to another over `ms` of on-screen time, redrawing each step.
async function sweep(o: Opened, from: number, to: number, ms: number) {
  const steps = Math.round(ms / 40);
  for (let i = 1; i <= steps; i++) {
    const x = i / steps, e = x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    await moonAt(o, new Date(from + (to - from) * e).toISOString());
    await vsleep(40);
  }
}
void sleep;
