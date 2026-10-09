// Monkey test: random taps, typing and keys across every screen of an isolated Gibbous (temp state, :7979), looking
// for crashes and console errors. Safe against the real Hermes it reads from: the WebSocket only passes read-only
// methods, terminals are refused, writes only reach the throwaway Gibbous state, and the run queue is off.
// Run: pnpm build && node e2e/monkey.ts [rounds-per-screen] [seed] [phone]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webkit, type Page } from 'playwright-core';

const ROUNDS = Number(process.argv[2] ?? 25);
let seed = Number(process.argv[3] ?? Date.now() % 100000);
const PHONE = process.argv[4] === 'phone';
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
const PORT = 7979, BASE = `http://127.0.0.1:${PORT}`;
const READ_ONLY = /\.(list|get|status|state|log|history|options|describe|sources|catalog|context_breakdown|thumbnail|search|preview)$|^(client\.capabilities|session\.resume|complete\.path|complete\.slash|rollback\.diff)$/;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-monkey-'));
const real = `${process.env.HOME}/.gibbous`;
fs.copyFileSync(`${real}/hermes-backend.json`, `${home}/hermes-backend.json`);
const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
for (const a of [['init', '-q', '-b', 'main'], ['-c', 'user.email=m@m', '-c', 'user.name=m', 'commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: repo });
// Seed with your threads (read-only imports stay read-only) so screens have real content; no agents can start.
const st = JSON.parse(fs.readFileSync(`${real}/state.json`, 'utf8'));
fs.writeFileSync(`${home}/state.json`, JSON.stringify({ threads: st.threads, settings: { ...st.settings, maxConcurrent: 0, syncSources: [] } }));

const server = spawn(process.execPath, ['server/main.ts'], { env: { ...process.env, GIBBOUS_HOME: home, GIBBOUS_PORT: String(PORT), GIBBOUS_TICK_MS: '600000' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>(res => server.stdout!.on('data', d => String(d).includes('Gibbous on') && res()));
const token = JSON.parse(fs.readFileSync(`${home}/secret.json`, 'utf8')).accessToken;
const api = (m: string, p: string, body?: unknown) => fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: `gibbous_auth=${token}` }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const project = await api('POST', '/api/projects', { path: repo, name: 'monkey' });
for (const t of ['Parse the config file', 'Add retries', 'Document the CLI']) await api('POST', '/api/tasks', { projectId: project.id, title: t, prompt: 'monkey task', status: 'backlog' });

const b = await webkit.launch();
const ctx = await b.newContext(PHONE ? { viewport: { width: 390, height: 844 }, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const found: { screen: string; error: string; trail: string[] }[] = [];
let trail: string[] = [], screen = '', clicks = 0, typed = 0;
const report = (error: string) => { if (!found.some(f => f.error === error)) found.push({ screen, error, trail: trail.slice(-8) }); };
page.on('pageerror', e => report(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error' && !/blocked by monkey|Failed to load resource|favicon/.test(m.text())) report(`console: ${m.text().slice(0, 300)}`); });
page.on('dialog', d => d.dismiss().catch(() => {}));
// Network: GETs are fine; writes only to Gibbous's own throwaway state; Hermes REST writes are refused.
await page.route('**/*', r => {
  const req = r.request(), u = new URL(req.url());
  if (req.method() === 'GET' || !u.pathname.startsWith('/api/')) return r.continue();
  const ok = /^\/api\/(tasks|projects|settings|playbooks|schedules|plans|threads\/[^/]+$|search)/.test(u.pathname) && !/\/(send|reply|interrupt|continue)$/.test(u.pathname);
  return ok ? r.continue() : r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'blocked by monkey' }) });
});
await page.routeWebSocket(/\/pty/, ws => ws.close());
await page.routeWebSocket(/\/ws/, ws => {
  const up = ws.connectToServer();
  ws.onMessage(raw => {
    let m: any; try { m = JSON.parse(String(raw)); } catch { return up.send(raw); }
    if (m.method && m.id != null && !READ_ONLY.test(m.method)) return ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: `blocked by monkey: ${m.method}` } }));
    if (m.id != null && !m.method) return; // answers to server→client requests (approvals): never sent upstream
    up.send(raw);
  });
});
await page.goto(`${BASE}/login?token=${token}`, { waitUntil: 'networkidle' });

const threads = st.threads.filter((t: any) => !t.host).map((t: any) => t.id);
const screens = ['#/', '#/inbox', '#/sessions', '#/search?q=test', '#/rooms', '#/automations', `#/board/${project.id}`, '#/settings',
  ...['general', 'appearance', 'notifications', 'phone', 'coordinator', 'playbooks', 'maintenance', 'usage', 'profiles', 'skills', 'mcp', 'jobs', 'platforms', 'memory', 'vault', 'config', 'hosts', 'update'].map(t => `#/settings/${t}`),
  ...threads.map((id: string) => `#/t/${id}`)];
const WORDS = ['hello', '/', '@', 'x'.repeat(300), '<b>hi</b>', '🌖', '  ', '12', '-1', 'pcb'];

async function act(p: Page) {
  const r = rand();
  if (r < .08) { trail.push('key Escape'); return p.keyboard.press('Escape'); }
  if (r < .12) { const k = pick(['Meta+k', 'Meta+n', 'Meta+.', 'Meta+\\', 'Meta+f', '?', 'ArrowDown', 'Enter', 'Tab']); trail.push(`key ${k}`); return p.keyboard.press(k); }
  const targets = await p.$$('button:not([disabled]), a[href^="#"], [role=menuitem], [role=radio], [role=switch], input:not([type=file]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
  const visible = [];
  for (const t of targets) if (await t.isVisible().catch(() => false)) visible.push(t);
  if (!visible.length) return;
  const t = pick(visible);
  const tag = await t.evaluate(e => `${e.tagName.toLowerCase()}${(e as HTMLElement).getAttribute('aria-label') ? ` "${(e as HTMLElement).getAttribute('aria-label')}"` : ` "${((e as HTMLElement).innerText || (e as HTMLInputElement).placeholder || '').trim().slice(0, 30)}"`}`).catch(() => '?');
  if (/^(input|textarea)/.test(tag)) { const w = pick(WORDS); trail.push(`type ${JSON.stringify(w.slice(0, 20))} into ${tag}`); typed++; await t.fill(w, { timeout: 1000 }).catch(() => {}); return; }
  if (tag.startsWith('select')) { trail.push(`select in ${tag}`); await t.evaluate((e: any) => { e.selectedIndex = Math.floor(Math.random() * e.options.length); e.dispatchEvent(new Event('change', { bubbles: true })); }).catch(() => {}); return; }
  trail.push(`click ${tag}`); clicks++;
  await t.click({ timeout: 1000 }).catch(() => {});
}

try {
  for (const s of screens) {
    screen = s; trail = [`open ${s}`];
    await page.evaluate(h => { location.hash = h; }, s).catch(() => {});
    await page.waitForTimeout(900);
    for (let i = 0; i < ROUNDS; i++) {
      await act(page).catch(() => {});
      await page.waitForTimeout(120);
      if (await page.evaluate(() => document.body.innerText.includes('This screen hit an error')).catch(() => false)) {
        report(`error screen: ${await page.evaluate(() => document.querySelector('pre')?.textContent?.slice(0, 300) ?? '')}`);
        await page.evaluate(() => { location.hash = '/'; }); break;
      }
    }
    // Stray navigation (links, palette) is part of the game; always come back to the next planned screen.
    await page.keyboard.press('Escape').catch(() => {});
  }
} finally {
  await b.close(); server.kill(); fs.rmSync(home, { recursive: true, force: true });
}
console.log(`seed ${process.argv[3] ?? "(random)"} · ${screens.length} screens × ${ROUNDS} actions · ${clicks} clicks, ${typed} inputs · ${found.length} problem(s)`);
for (const f of found) console.log(`\n✗ ${f.screen}\n  ${f.error}\n  after: ${f.trail.join(' → ')}`);
process.exit(found.length ? 1 : 0);
