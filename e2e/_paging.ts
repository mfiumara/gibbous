// Functional check of paging on the isolated server: Show earlier (rendered → server pages), scroll hold, no dup keys,
// switching away and back keeps loaded pages, export loads everything.
import fs from 'node:fs';
import { chromium, webkit } from 'playwright-core';
const [H, PORT, id, other, bname = 'chromium'] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${PORT}`;
const token = JSON.parse(fs.readFileSync(`${H}/secret.json`, 'utf8')).accessToken;
const b = bname === 'webkit' ? await webkit.launch() : await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const p = await ctx.newPage();
const errs: string[] = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(`${BASE}/login?token=${token}`);
await p.goto(`${BASE}/?x=1#/t/${id}`);
await p.waitForSelector('[data-k]', { timeout: 60000 }); await p.waitForTimeout(2500);
const info = () => p.evaluate(() => {
  const c = document.querySelector('.max-w-3xl.px-4.py-6')!, sc = c.parentElement!;
  const keys = [...c.querySelectorAll<HTMLElement>('[data-k]')].map(e => e.dataset.k!);
  const btn = [...c.querySelectorAll('button')].find(x => x.textContent?.startsWith('Show earlier'))?.textContent ?? null;
  const vis = [...c.querySelectorAll<HTMLElement>('[data-k]')].find(n => n.getBoundingClientRect().bottom > sc.getBoundingClientRect().top + 5);
  return { n: keys.length, dup: keys.length - new Set(keys).size, first: keys[0], btn, anchor: vis ? [vis.dataset.k, Math.round(vis.getBoundingClientRect().top)] : null, fromBottom: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) };
});
const log = (l: string, x: unknown) => console.log(l.padEnd(26), JSON.stringify(x));
log('open', await info());
for (let i = 0; i < 4; i++) {
  await p.evaluate(() => { const c = document.querySelector('.max-w-3xl.px-4.py-6')!; c.parentElement!.scrollTop = 0; });
  await p.waitForTimeout(300);
  const before = await info();
  const btn = p.locator('button', { hasText: /^Show earlier/ });
  if (!(await btn.count())) { log('no more', before); break; }
  await btn.first().click();
  await p.waitForTimeout(3000);
  const after = await info();
  const held = await p.evaluate(k => { const e = document.querySelector<HTMLElement>(`[data-k="${CSS.escape(k)}"]`); return e ? Math.round(e.getBoundingClientRect().top) : null; }, before.anchor![0] as string);
  log(`show earlier #${i + 1}`, { ...after, anchorWasAt: before.anchor![1], anchorNowAt: held });
}
const loaded = (await info()).n;
await p.evaluate(h => { location.hash = h; }, `#/t/${other}`); await p.waitForTimeout(4000);
await p.evaluate(h => { location.hash = h; }, `#/t/${id}`); await p.waitForTimeout(500);
log('back (cached paint)', await info());
await p.waitForTimeout(4000);
log('back (after refresh)', { ...(await info()), loadedBefore: loaded });
// Export markdown: everything, not just the loaded pages.
await p.click('[aria-label="More"]').catch(() => {});
const exp = p.getByText('Export as Markdown').first();
if (await exp.count()) {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), exp.click()]);
  const f = await dl.path();
  const md = fs.readFileSync(f!, 'utf8');
  log('export md', { bytes: md.length, userTurns: (md.match(/^\*\*You:\*\*/gm) ?? []).length, toolLines: (md.match(/^> `/gm) ?? []).length });
} else log('export', 'menu item not found');
await p.screenshot({ path: `${process.env.HOME}/.hermes/cache/scratch/paging-${bname}.png` });
log('errors', errs);
await b.close();
