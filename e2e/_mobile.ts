// Temporary mobile audit against the live server (read-only navigation). WebKit, iPhone 17 size.
import fs from 'node:fs';
import { webkit } from 'playwright-core';
const BASE = process.env.BASE ?? 'http://127.0.0.1:7878';
const OUT = process.env.OUT ?? `${process.env.TMPDIR}/mobile`;
fs.mkdirSync(OUT, { recursive: true });
const token = JSON.parse(fs.readFileSync(`${process.env.HOME}/.gibbous/secret.json`, 'utf8')).accessToken;
const state = await (await fetch(`${BASE}/api/state`, { headers: { Cookie: `gibbous_auth=${token}` } })).json();
const threads = state.threads.filter((t: any) => t.status !== 'archived').sort((a: any, b: any) => b.updatedAt - a.updatedAt);
const project = state.projects[0];
const routes: [string, string][] = [
  ['home', '#/'], ['new-project', `#/new/${project?.id}`], ['inbox', '#/inbox'], ['sessions', '#/sessions'], ['search', '#/search?q=fix'],
  ['automations', '#/automations'], ['rooms', '#/rooms'], ['board', `#/board/${project?.id}`], ['settings', '#/settings'],
  ...['general', 'appearance', 'notifications', 'phone', 'coordinator', 'playbooks', 'maintenance', 'usage', 'profiles', 'skills', 'mcp', 'jobs', 'platforms', 'memory', 'vault', 'config', 'hosts', 'update'].map(t => [`settings-${t}`, `#/settings/${t}`] as [string, string]),
  ...threads.slice(0, 3).map((t: any, i: number) => [`thread${i}`, `#/t/${t.id}`] as [string, string]),
];
const only = process.env.ONLY?.split(',');
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(`${BASE}/login?token=${token}`, { waitUntil: 'networkidle' });
await page.evaluate(d => { localStorage.setItem('gibbous.density', d); }, process.env.DENSITY ?? 'cozy');
const report: Record<string, string[]> = {};
for (const [name, hash] of routes) {
  if (only && !only.includes(name)) continue;
  await page.evaluate(h => { location.hash = h; }, hash);
  await page.waitForTimeout(1800);
  if (process.env.SIDEBAR && name === 'home') { await page.click('[aria-label="Open sidebar"]'); await page.waitForTimeout(500); }
  const issues = await page.evaluate(() => {
    const W = innerWidth, out: string[] = [];
    const desc = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String((el as HTMLElement).className?.baseVal ?? (el as HTMLElement).className ?? '').split(' ').slice(0, 4).join('.')} "${((el as HTMLElement).innerText ?? '').trim().slice(0, 40).replace(/\n/g, ' ')}"`;
    // Horizontal scroll anywhere that isn't an intentional sideways scroller (code, tables, chips rows).
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !el.closest('pre, table, [data-hscroll], .xterm, code')) {
        out.push(`HSCROLL ${el.scrollWidth - el.clientWidth}px in ${desc(el)}`);
      }
    }
    // Visible things poking past the right edge, unless clipped by an ancestor.
    const seen = new Set<Element>();
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= W + 1 || r.left >= W) continue;
      const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.position === 'fixed' && el.classList.contains('sky-moon')) continue;
      let clipped = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const ac = getComputedStyle(a);
        // Truncated text (ellipsis) and sideways scrollers are deliberate; overflow:hidden that merely hides a too-wide layout is not.
        if ((ac.overflowX === 'auto' || ac.overflowX === 'scroll') && a.getBoundingClientRect().right <= W + 1 && !a.matches('#root *:not([class*=overflow-y-auto])') ) { clipped = true; break; }
        if (ac.textOverflow === 'ellipsis' || a.matches('pre, table, code, [data-hscroll], .xterm, [role=dialog][aria-hidden=true]')) { clipped = true; break; }
        if (ac.transform !== 'none' && a.getBoundingClientRect().right <= 0) { clipped = true; break; } // off-canvas sidebar
      }
      if (clipped) continue;
      if ([...seen].some(s => s.contains(el))) continue;
      seen.add(el); out.push(`OVERFLOW right=${Math.round(r.right)} ${desc(el)}`);
    }
    for (const el of document.querySelectorAll('textarea, input:not([type=file]):not([type=checkbox]):not([type=range]), select')) {
      if (!(el as HTMLElement).offsetParent) continue;
      let z = 1; for (let e: Element | null = el; e; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1;
      const px = parseFloat(getComputedStyle(el).fontSize) * z;
      if (px < 15.99) out.push(`FONT<16 ${px.toFixed(1)} ${desc(el)}`);
    }
    for (const el of document.querySelectorAll('button, a[href], [role=button], select, input[type=checkbox], [role=switch]')) {
      const r = el.getBoundingClientRect(); if (!r.width || r.right < 0 || r.left > W || r.bottom < 0 || r.top > innerHeight) continue;
      if (r.width < 28 || r.height < 28) out.push(`SMALL ${Math.round(r.width)}x${Math.round(r.height)} ${desc(el)}`);
    }
    return out;
  });
  report[name] = issues;
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, errors }, null, 1));
for (const [k, v] of Object.entries(report)) { const big = v.filter(x => !x.startsWith('SMALL')); console.log(`${k}: ${big.length} issues, ${v.length - big.length} small targets`); big.slice(0, 8).forEach(x => console.log('   ', x)); }
if (errors.length) console.log('ERRORS', errors);
await browser.close();
