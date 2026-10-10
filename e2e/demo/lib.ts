// Demo environment: an isolated Gibbous (own GIBBOUS_HOME, HOME, port) on top of the scripted fake Hermes, plus
// browser and recording helpers. Nothing here touches ~/.gibbous, ~/.hermes or the dev.gibbous.server service.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import puppeteer, { type Browser, type Page, type CDPSession } from 'puppeteer-core';
import { fakeHermes } from './fake-hermes.ts';
import { pick, titleFor } from './scripts.ts';
import { createRepos } from './repo.ts';
import { demoData, writeStateDb } from './demo-data.ts';

export const REPO = path.resolve(import.meta.dirname, '../..');
export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Paths that can show up in the UI live under a neutral demo home; the app snapshot and caches live in scratch.
export const DEMO = process.env.DEMO_HOME ?? '/Users/Shared/gibbous-demo';
export const SCRATCH = process.env.DEMO_SCRATCH ?? path.join(os.homedir(), '.hermes/cache/scratch/gibbous-demo');
export const OUT = process.env.OUT ?? path.join(os.homedir(), 'gibbous-launch/ui');
export const PORT = Number(process.env.DEMO_PORT ?? 7990);
export const BASE = `http://127.0.0.1:${PORT}`;
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Headless Chrome only paints ~20-25 fps, so recordings run in slow motion: the page's clock (Date, performance.now,
// timers, rAF, CSS animations), the scripted agent and our own pacing all slow down by clock.slow, and the frames are
// put back at real speed when encoding. vsleep() is a pause in on-screen time.
export const clock = { slow: 1 };
export const vsleep = (ms: number) => sleep(ms * clock.slow);
const TIME_SCALE = (offset: number) => {
  const RealDate = Date, rnow = RealDate.now.bind(RealDate), rperf = performance.now.bind(performance);
  let scale = 1, baseReal = rperf(), baseVirt = baseReal + offset;
  const vperf = () => baseVirt + (rperf() - baseReal) * scale;
  const vnow = () => rnow() + (vperf() - rperf());
  (window as any).__setTimeScale = (x: number) => { baseVirt = vperf(); baseReal = rperf(); scale = x; };
  performance.now = vperf;
  class VDate extends RealDate {
    constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(vnow()); }
    static now() { return vnow(); }
  }
  (window as any).Date = VDate;
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window), raf = window.requestAnimationFrame.bind(window);
  (window as any).setTimeout = (f: any, d = 0, ...a: any[]) => st(f, d / scale, ...a);
  (window as any).setInterval = (f: any, d = 0, ...a: any[]) => si(f, d / scale, ...a);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => raf(() => cb(vperf()));
};

// The server and web build are copied once, so edits or rebuilds in the repo during a capture can't reload the tab.
function snapshotApp() {
  const app = path.join(SCRATCH, 'app');
  if (fs.existsSync(path.join(app, 'web/dist/index.html')) && !process.argv.includes('--resnapshot')) return app;
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.join(app, 'web'), { recursive: true });
  execFileSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', '*.test.ts', path.join(REPO, 'server'), app]);
  // Only the current build's assets (dist keeps a week of old chunks).
  const dist = path.join(REPO, 'web/dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('web/dist is missing: run pnpm build first');
  execFileSync('rsync', ['-a', '--exclude', 'assets', dist + '/', path.join(app, 'web/dist/')]);
  const assets = path.join(dist, 'assets'), out = path.join(app, 'web/dist/assets');
  fs.mkdirSync(out);
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const todo = [...html.matchAll(/\/assets\/([^"']+)/g)].map(m => m[1]), seen = new Set<string>();
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f) || !fs.existsSync(path.join(assets, f))) continue;
    seen.add(f);
    fs.copyFileSync(path.join(assets, f), path.join(out, f));
    if (/\.(js|css)$/.test(f)) for (const m of fs.readFileSync(path.join(assets, f), 'utf8').matchAll(/([\w.-]+-[\w-]{8}\.(?:js|css|woff2?|png|svg))/g)) todo.push(m[1]);
  }
  fs.symlinkSync(path.join(REPO, 'server/node_modules'), path.join(app, 'server/node_modules'));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(app, 'package.json'));
  return app;
}

function demoHome() {
  fs.rmSync(DEMO, { recursive: true, force: true });
  for (const d of ['code', 'bin', '.gibbous', '.hermes']) fs.mkdirSync(path.join(DEMO, d), { recursive: true });
  const bin = (name: string, body: string) => { fs.writeFileSync(path.join(DEMO, 'bin', name), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(DEMO, 'bin', name), 0o755); };
  bin('tailscale', 'exit 1');                        // no tailnet in the demo
  bin('hermes', 'echo "demo: real hermes is disabled" >&2; exit 1'); // never start a real backend
  bin('gh', 'case "$1 $2" in "pr list") echo "[]";; *) exit 1;; esac');
  fs.writeFileSync(path.join(DEMO, '.gitconfig'), '[user]\n\tname = Tidepool Maintainers\n\temail = maintainers@tidepool.example\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  fs.writeFileSync(path.join(DEMO, '.zshrc'), [
    `export PATH="${DEMO}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`,
    'export HISTFILE=/dev/null', 'unsetopt PROMPT_SP',
    "PROMPT='%F{244}%1~%f %F{110}❯%f '", "RPROMPT=''",
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(DEMO, '.zprofile'), '');
  return createRepos(path.join(DEMO, 'code'));
}

export interface Env {
  fake: ReturnType<typeof fakeHermes>; server: ChildProcess; token: string; repos: { tide: string; docs: string }; data: ReturnType<typeof demoData>;
  api<T = any>(method: string, p: string, body?: unknown): Promise<T>;
  stop(): Promise<void>;
}

export async function start(): Promise<Env> {
  try { await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(800) }); throw new Error(`port ${PORT} is busy; set DEMO_PORT`); }
  catch (e: any) { if (String(e.message).includes('busy')) throw e; }
  const app = snapshotApp();
  const repos = demoHome();
  const GH = path.join(DEMO, '.gibbous');
  const token = randomBytes(16).toString('hex');
  const data = demoData(DEMO, repos);
  const fake = fakeHermes({ token, pick, titleFor, foreign: data.foreign, kanban: data.kanban });
  const stored = new Map(data.sessions.map(p => [p, fake.preload(p).stored]));
  writeStateDb(path.join(DEMO, '.hermes'), data.sessions, stored);
  const hport = await fake.listen();
  fs.writeFileSync(path.join(GH, 'hermes-backend.json'), JSON.stringify({ port: hport, token }));
  fs.mkdirSync(path.join(SCRATCH, 'tmp'), { recursive: true });
  const env = {
    PATH: `${DEMO}/bin:${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`, HOME: DEMO, ZDOTDIR: DEMO, SHELL: '/bin/zsh', USER: 'dev', LOGNAME: 'dev',
    LANG: 'en_US.UTF-8', TMPDIR: path.join(SCRATCH, 'tmp'), GIBBOUS_HOME: GH, GIBBOUS_PORT: String(PORT), HERMES_HOME: path.join(DEMO, '.hermes'),
    HERMES_BIN: path.join(DEMO, 'bin/hermes'), GIBBOUS_HERMES_PORT: '9199', GIBBOUS_TICK_MS: '600',
  };
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(app, 'server/main.ts')], { env, cwd: DEMO, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(SCRATCH, 'server.log'));   // holds the login link: never print it
  server.stdout!.pipe(log); server.stderr!.pipe(log);
  await new Promise<void>((res, rej) => {
    server.stdout!.on('data', d => String(d).includes('Gibbous on') && res());
    server.on('exit', c => rej(new Error(`gibbous exited ${c}; see ${SCRATCH}/server.log`)));
  });
  const access = JSON.parse(fs.readFileSync(path.join(GH, 'secret.json'), 'utf8')).accessToken as string;
  const api = async <T,>(method: string, p: string, body?: unknown): Promise<T> => {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: `gibbous_auth=${access}` }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
    return j as T;
  };
  for (let i = 0; i < 50 && !(await api<any>('GET', '/api/state')).hermes.ready; i++) await sleep(200);
  return { fake, server, token: access, repos, data, api, stop: async () => { server.kill('SIGTERM'); await fake.close(); } };
}

// ── browser ──────────────────────────────────────────────────────────────
export async function browser(): Promise<Browser> {
  return puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: null,
    args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-features=Translate', '--hide-scrollbars'] });
}

export interface Opened { page: Page; cdp: CDPSession }
export async function open(b: Browser, env: Env, o: { phone?: boolean; seen?: Record<string, number>; prefs?: Record<string, string> } = {}): Promise<Opened> {
  const page = await b.newPage();
  if (o.phone) {
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 402, height: 874, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  } else await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 2 });
  const prefs = { 'gibbous.theme': 'night', 'gibbous.density': 'cozy', 'gibbous.panel': '', 'gibbous.chime': '0', ...o.prefs, ...(o.seen ? { 'gibbous.seen': JSON.stringify(o.seen) } : {}) };
  // A capture tab must behave like a visible, focused window: no stale-build auto-reload, rAF and timers at full rate.
  await page.evaluateOnNewDocument(TIME_SCALE, env.fake.clockOffset());
  // The sky moon redraws every 10 min and the moonlight CSS every minute: keep a handle on both so a recording can
  // sweep a pinned date (localStorage gibbous.moonAt) and redraw at once (window.__moonRedraw()).
  await page.evaluateOnNewDocument(() => {
    const si = window.setInterval, fns: (() => void)[] = [];
    (window as any).setInterval = (f: any, d = 0, ...a: any[]) => { if (d === 60_000 || d === 600_000) fns.push(f); return si(f, d, ...a); };
    (window as any).__moonRedraw = () => fns.forEach(f => { try { f(); } catch { /* */ } });
  });
  await page.evaluateOnNewDocument((prefs: Record<string, string>) => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { get: () => false });
    if (!sessionStorage.getItem('demo.prefs')) { for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v); sessionStorage.setItem('demo.prefs', '1'); }
  }, prefs);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_ABORTED|ERR_BLOCKED|ipapi|geolocation|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  (page as any).demoErrors = errors;
  page.on('dialog', d => d.accept().catch(() => {}));
  const cdp = await page.createCDPSession();
  // The sky moon looks the location up over the network; the demo stays offline (default location).
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*ipapi.co*', '*ipwho*', '*ip-api*'] });
  await page.goto(`${BASE}/login?token=${env.token}`, { waitUntil: 'networkidle0' });
  await front({ page, cdp });
  await page.waitForFunction(() => !!document.querySelector('[data-pane]'), { timeout: 15000 });
  await sleep(600);
  return { page, cdp };
}

export async function front({ page, cdp }: Opened) {
  await page.bringToFront();
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
}

export async function go({ page }: Opened, hash: string, waitText?: string) {
  await page.evaluate(h => { location.hash = h; }, hash);
  if (waitText) await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 15000 }, waitText);
  await sleep(500);
}

export async function shot(o: Opened, name: string) {
  fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true });
  await front(o);
  await o.page.evaluate(() => document.fonts.ready);
  // In-app notifications are real, but stills read cleaner without them.
  if (await o.page.evaluate(() => { const b = [...document.querySelectorAll<HTMLElement>('button[aria-label=Dismiss]')]; b.forEach(x => x.click()); return b.length; })) await sleep(600);
  await sleep(350);
  const file = path.join(OUT, 'stills', `${name}.png`);
  await o.page.screenshot({ path: file as `${string}.png`, captureBeyondViewport: false });
  const errs = (o.page as any).demoErrors as string[];
  if (errs.length) console.log(`  ! console errors before ${name}: ${errs.splice(0).join(' | ').slice(0, 400)}`);
  console.log(`  ✓ stills/${name}.png`);
  return file;
}

// Keys as real input events (the tab is focused), one at a time, like a person typing.
export async function keys(o: Opened, seq: string[], gap = 260) {
  for (const k of seq) {
    if (k.startsWith('wait:')) { await vsleep(Number(k.slice(5))); continue; }
    const m = /^(Meta|Control|Shift)\+(.+)$/.exec(k);
    if (m) { await o.page.keyboard.down(m[1] as any); await o.page.keyboard.press(m[2] as any); await o.page.keyboard.up(m[1] as any); }
    else await o.page.keyboard.press(k as any);
    await vsleep(gap);
  }
}

// Smooth programmatic scroll of an element (rAF-driven, eased), for recordings.
export async function smoothScroll(o: Opened, selector: string, to: number | 'bottom' | 'top', ms: number) {
  await o.page.evaluate((sel: string, to: number | string, ms: number) => new Promise<void>(res => {
    const el = typeof sel === 'string' ? document.querySelector<HTMLElement>(sel) : null;
    if (!el) return res();
    const from = el.scrollTop, target = to === 'bottom' ? el.scrollHeight - el.clientHeight : to === 'top' ? 0 : from + (to as number);
    const t0 = performance.now(), ease = (x: number) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    const step = (t: number) => { const p = Math.min(1, (t - t0) / ms); el.scrollTop = from + (target - from) * ease(p); if (p < 1) requestAnimationFrame(step); else res(); };
    requestAnimationFrame(step);
  }), selector, to, ms);
}

// ── recording: CDP screencast frames, placed at their real timestamps, resampled to constant fps by ffmpeg ──────
export async function record(o: Opened, name: string, fn: () => Promise<void>, opts: { fps?: number; size?: [number, number]; slow?: number; shots?: boolean; fake?: { speed: { factor: number }; setSlow(x: number): void } } = {}) {
  const fps = opts.fps ?? 60;
  const slow = opts.slow ?? Number(process.env.REC_SLOW ?? 3);
  const dir = fs.mkdtempSync(path.join(SCRATCH, `rec-${name}-`));
  const frames: { file: string; t: number }[] = [];
  let n = 0;
  await front(o);
  const onFrame = (f: { data: string; metadata: { timestamp?: number }; sessionId: number }) => {
    const file = path.join(dir, `${String(++n).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    o.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  };
  o.cdp.on('Page.screencastFrame', onFrame);
  // 4K screencast frames top out around 24 fps; record at a lower device scale (env REC_DPR, default 1) for smooth 60 fps.
  const vp = o.page.viewport()!;
  // Screencast frames are always CSS-pixel sized, so hi-DPI clips (the phone) use a screenshot loop instead (opts.shots).
  const dpr = opts.shots ? vp.deviceScaleFactor : Number(process.env.REC_DPR ?? 1);
  const changed = dpr !== vp.deviceScaleFactor;
  if (changed) { await o.page.setViewport({ ...vp, deviceScaleFactor: dpr }); await sleep(900); }
  const [w, h] = opts.size ?? [0, 0];
  let shooting = false, shooter: Promise<void> | undefined;
  if (opts.shots) {
    shooting = true;
    shooter = (async () => {
      while (shooting) {
        const t = Date.now() / 1000;
        const r = await o.page.screenshot({ type: 'jpeg', quality: 92, optimizeForSpeed: true, encoding: 'base64' }).catch(() => undefined);
        if (!r) continue;
        const file = path.join(dir, `${String(++n).padStart(5, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(r as string, 'base64'));
        frames.push({ file, t });
      }
    })();
  } else await o.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1, ...(w ? { maxWidth: w, maxHeight: h } : {}) });
  // Keep the compositor producing frames even when nothing moves, so timestamps stay continuous.
  await o.page.evaluate(() => { const d = document.createElement('div'); d.id = 'demo-tick'; d.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.004;pointer-events:none;z-index:2147483647'; document.body.appendChild(d); let i = 0; const f = () => { d.style.transform = `translateX(${(i++ % 2)}px)`; if (document.getElementById('demo-tick')) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const tStart = Date.now() / 1000;
  await sleep(300);
  // Slow motion on: page clock, animations, the fake agent and our pacing.
  await o.cdp.send('Animation.enable');
  await o.cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / slow });
  await o.page.evaluate(x => (window as any).__setTimeScale(x), 1 / slow);
  const agentSpeed = opts.fake?.speed.factor;
  if (opts.fake) { opts.fake.speed.factor = agentSpeed! * slow; opts.fake.setSlow(slow); }
  clock.slow = slow;
  const tFrom = Date.now() / 1000;
  try { await fn(); await vsleep(300); }
  finally {
    clock.slow = 1;
    if (opts.fake) { opts.fake.speed.factor = agentSpeed!; opts.fake.setSlow(1); }
    await o.page.evaluate(() => (window as any).__setTimeScale(1));
    await o.cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  }
  const tTo = Date.now() / 1000;
  const tEnd = tTo;
  if (opts.shots) { shooting = false; await shooter; } else await o.cdp.send('Page.stopScreencast');
  o.cdp.off('Page.screencastFrame', onFrame as any);
  await o.page.evaluate(() => document.getElementById('demo-tick')?.remove());
  if (changed) await o.page.setViewport(vp);
  // Keep only the slow-motion span, then play it back at real speed.
  frames.splice(0, frames.length, ...frames.filter(f => f.t >= tFrom - 0.05 && f.t <= tTo + 0.05));
  if (frames.length < 2) throw new Error(`recording ${name}: no frames`);
  // concat demuxer: each frame lasts until the next one.
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${(Math.max(0.001, (frames[i + 1]?.t ?? f.t + slow / fps) - f.t) / slow).toFixed(5)}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
  fs.writeFileSync(path.join(dir, 'list.txt'), list);
  fs.mkdirSync(path.join(OUT, 'video'), { recursive: true });
  const out = path.join(OUT, 'video', `${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
    '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-profile:v', 'high', '-movflags', '+faststart', '-r', String(fps), out]);
  const span = (frames[frames.length - 1].t - frames[0].t) / slow;
  const gaps = frames.slice(1).map((f, i) => (f.t - frames[i].t) / slow).sort((a, b) => b - a);
  console.log(`  ✓ video/${name}.mp4  ${frames.length} frames over ${span.toFixed(1)}s (avg ${(frames.length / span).toFixed(1)} fps, worst gap ${(gaps[0] * 1000).toFixed(0)}ms), wall ${(tEnd - tStart).toFixed(1)}s`);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
