// Probe: vim keys on the kanban board and the Sessions screen (prints focus after each key).
import { start, browser, open, go, keys, sleep } from './lib.ts';
import { seed } from './seed.ts';

const env = await start();
const b = await browser();
try {
  const s = await seed(env);
  const o = await open(b, env, { seen: { '*': Date.now() } });
  const where = () => o.page.evaluate(() => { const a = document.activeElement as HTMLElement; return `${location.hash} | ${a?.tagName} ${(a?.innerText ?? '').split('\n')[0].slice(0, 50)} | pane=${a?.closest('[data-pane]')?.getAttribute('data-pane')} col=${a?.closest('section[data-col]')?.getAttribute('data-col')}`; });
  await go(o, `#/board/${s.tide.id}`, 'Redis store'); await o.page.evaluate(() => (document.activeElement as HTMLElement)?.blur()); await sleep(800);
  for (const k of ['l', 'j', 'j', 'l', 'j', 'l', 'l', 'j', 'k', 'h', 'Enter']) { await keys(o, [k], 300); console.log(k.padEnd(6), await where()); }
  await sleep(1200);
  console.log('dialog:', await o.page.evaluate(() => !!document.querySelector('dialog[open], [role=dialog]')), await o.page.evaluate(() => document.querySelector('dialog[open]')?.textContent?.slice(0, 200)));
  await keys(o, ['Escape'], 400); console.log('esc', await where());
  await go(o, '#/sessions/cli', 'Profile the Redis'); await o.page.evaluate(() => (document.activeElement as HTMLElement)?.blur()); await sleep(600);
  for (const k of ['l', 'l', 'l', 'wait:10', 'j', 'j', 'k']) { if (k === 'wait:10') { await o.page.evaluate(() => document.querySelector<HTMLElement>('[data-sessions-list] [data-vim-item]')?.focus()); console.log('focus', await where()); continue; } await keys(o, [k], 500); console.log(k.padEnd(6), await where()); }
  console.log('errors:', (o.page as any).demoErrors);
} finally { await b.close(); await env.stop(); }
