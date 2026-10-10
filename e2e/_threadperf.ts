// Thread load timing (node e2e/_threadperf.ts <GIBBOUS_HOME> <port> [--browser chromium|webkit|both] [--runs N] [--profile] <threadId…>).
// Read-only: opens threads on an isolated Gibbous (never sends prompts). Prints, per thread and browser, the median of
// N runs for: a cold page load straight onto #/t/<id>, a switch from another thread (uncached), and a switch back to a
// cached thread. "rows" = first conversation rows on screen; "idle" = last DOM change in the thread + no long task for
// 1.5s. Also lists the RPC/HTTP calls of the last run (duration, response size) and the main-thread long-task total.
import fs from 'node:fs';
import { chromium, webkit, type Browser, type Page } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (n: string) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const which = flag('--browser') ?? 'both', runs = Number(flag('--runs') ?? 3), profile = bool('--profile'), json = flag('--json');
const [H, PORT, ...ids] = args;
if (!H || !PORT || !ids.length) { console.error('usage: node e2e/_threadperf.ts <home> <port> [--browser chromium|webkit|both] [--runs N] [--profile] [--json out.json] <threadId…>'); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const fresh = (h: string) => `${BASE}/?r=${Math.random().toString(36).slice(2)}#${h}`; // a real page load, not a hash change
const token = JSON.parse(fs.readFileSync(`${H}/secret.json`, 'utf8')).accessToken;

// Instrumentation injected before the app: RPC timings + frame sizes, long tasks, and a mutation clock on the thread.
const INIT = `(() => {
  const w = window; w.__perf = { calls: {}, frames: [], lt: [], mut: 0, mark: 0 };
  const P = w.__perf, Ws = w.WebSocket;
  w.WebSocket = class extends Ws {
    constructor(...a) { super(...a);
      this.addEventListener('message', e => {
        const s = typeof e.data === 'string' ? e.data : '', m = /"id":\\s*(\\d+)/.exec(s.slice(0, 64));
        P.frames.push({ t: performance.now(), size: s.length, id: m ? +m[1] : null });
        if (m && P.calls[m[1]]) { P.calls[m[1]].end = performance.now(); P.calls[m[1]].size = s.length; }
      });
    }
    send(d) { try { const j = JSON.parse(d); if (j.id != null) P.calls[j.id] = { method: j.method, start: performance.now(), params: Object.keys(j.params || {}).join(',') }; } catch {} return super.send(d); }
  };
  P.fetching = 0; const f0 = w.fetch;
  w.fetch = function (u, ...a) { const t = String(u && u.url || u).includes('/api/threads/'); if (t) P.fetching++; const p = f0.call(this, u, ...a); if (t) p.finally(() => P.fetching--); return p; };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  new MutationObserver(() => { P.mut = performance.now(); }).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

type Sample = { rows: number; idle: number; nRows: number; lt: number; pinned: boolean };
const state = (p: Page) => p.evaluate(() => {
  const P = (window as any).__perf;
  const c = document.querySelector('.max-w-3xl.px-4.py-6') as HTMLElement | null;
  const rows = c ? c.querySelectorAll('[data-k]').length : 0;
  const skel = !!document.querySelector('[aria-label="Loading conversation"]');
  const sc = c?.parentElement;
  const busy = P.fetching + Object.values(P.calls as Record<string, any>).filter(c => !c.end).length;
  return { now: performance.now(), rows, skel, busy, mut: P.mut, lt: P.lt.slice(), pinned: sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80 : false };
});

// Wait until the thread's requests are done and the page is quiet (no DOM change, no long task for `quiet` ms).
// rows = when the row count first reached its final value's first 10 (what you see at the bottom on open).
async function measure(p: Page, t0: number, quiet = 1500, cap = 120_000): Promise<Sample> {
  const seen: [number, number][] = [];
  let last: Awaited<ReturnType<typeof state>> | undefined;
  const start = Date.now();
  while (Date.now() - start < cap) {
    const s = await state(p).catch(() => undefined);
    if (s) {
      last = s;
      if (!s.skel) seen.push([s.now, s.rows]);
      const ltEnd = Math.max(0, ...s.lt.map(([a, d]: number[]) => a + d));
      if (s.rows > 0 && !s.skel && !s.busy && s.now - Math.max(s.mut, ltEnd) > quiet) break;
    }
    await p.waitForTimeout(50);
  }
  const s = last!;
  const want = Math.min(10, s.rows);
  const rowsAt = seen.find(([, n]) => n >= want)?.[0] ?? s.now;
  const ltEnd = Math.max(0, ...s.lt.map(([a, d]: number[]) => a + d));
  const lt = s.lt.filter(([a]: number[]) => a >= t0).reduce((x: number, [, d]: number[]) => x + d, 0);
  return { rows: Math.round(rowsAt - t0), idle: Math.round(Math.max(s.mut, ltEnd, rowsAt) - t0), nRows: s.rows, lt: Math.round(lt), pinned: s.pinned };
}

async function calls(p: Page, since: number) {
  return p.evaluate(since => {
    const P = (window as any).__perf;
    const rpc = Object.values(P.calls as Record<string, any>).filter(c => c.start >= since && c.end).map(c => `${c.method}${c.params.includes('omit_messages') ? '(omit)' : ''} ${Math.round(c.end - c.start)}ms ${Math.round(c.size / 1024)}KB`);
    const http = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(e => e.startTime >= since && /\/api\/threads\//.test(e.name))
      .map(e => `${e.name.replace(/^.*\/api\/threads\/[^/]+\//, '').replace(/\?.*/, '')} ${Math.round(e.duration)}ms ${Math.round((e.decodedBodySize || e.transferSize) / 1024)}KB`);
    return [...http, ...rpc];
  }, since);
}

async function login(b: Browser) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript({ content: INIT });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.error('  pageerror:', e.message));
  await p.goto(`${BASE}/login?token=${token}`, { waitUntil: 'load' });
  return { ctx, p };
}

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const out: Record<string, any> = {};

for (const name of which === 'both' ? ['chromium', 'webkit'] : [which]) {
  const b = name === 'webkit' ? await webkit.launch() : await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const id of ids) {
    const cold: Sample[] = [], sw: Sample[] = [], back: Sample[] = [];
    let log: string[] = [];
    const other = ids.find(x => x !== id) ?? id;
    for (let r = 0; r < runs; r++) {
      // Cold: a fresh page load straight onto the thread.
      const { ctx, p } = await login(b);
      await p.waitForTimeout(300);
      let prof: any;
      const cdp = profile && name === 'chromium' && r === runs - 1 ? await ctx.newCDPSession(p) : undefined;
      await p.goto(fresh(`/t/${id}`), { waitUntil: 'commit' });
      if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
      cold.push(await measure(p, 0));
      if (cdp) prof = (await cdp.send('Profiler.stop')).profile;
      log = await calls(p, 0);
      // Switch to another (uncached) thread, then back to this one (cached).
      if (other !== id) {
        let t0 = await p.evaluate(h => { const t = performance.now(); location.hash = h; return t; }, `#/t/${other}`);
        await measure(p, t0);
        t0 = await p.evaluate(h => { const t = performance.now(); location.hash = h; return t; }, `#/t/${id}`);
        back.push(await measure(p, t0));
        // And uncached switch: a fresh app on the other thread, then open this one.
        await p.goto(fresh(`/t/${other}`)); await measure(p, 0);
        t0 = await p.evaluate(h => { const t = performance.now(); location.hash = h; return t; }, `#/t/${id}`);
        sw.push(await measure(p, t0));
      }
      if (r === runs - 1) {
        await p.goto(fresh(`/t/${id}`)); await measure(p, 0);
        await p.screenshot({ path: `${process.env.HOME}/.hermes/cache/scratch/threadperf-${name}-${id}.png` });
      }
      if (prof) {
        const self = new Map<string, number>();
        const byId = new Map<number, any>(prof.nodes.map((n: any) => [n.id, n]));
        const dt = prof.timeDeltas as number[];
        prof.samples.forEach((sid: number, i: number) => {
          const n = byId.get(sid); const f = n.callFrame;
          const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}:${f.columnNumber}`;
          self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
        });
        console.log(`  [${name} ${id}] self time top:`);
        for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${Math.round(v)}ms  ${k}`);
      }
      await ctx.close();
    }
    const row = (xs: Sample[]) => xs.length ? { rows: med(xs.map(x => x.rows)), idle: med(xs.map(x => x.idle)), longTasks: med(xs.map(x => x.lt)), rendered: xs.at(-1)!.nRows, pinned: xs.every(x => x.pinned) } : null;
    out[`${name} ${id}`] = { cold: row(cold), switch: row(sw), cachedBack: row(back), calls: log };
    console.log(`${name} ${id}`, JSON.stringify(out[`${name} ${id}`]));
  }
  await b.close();
}
if (json) fs.writeFileSync(json, JSON.stringify(out, null, 2));
