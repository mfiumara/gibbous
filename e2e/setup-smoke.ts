// Setup smoke: a real `node server/main.ts` with NO Hermes (HERMES_BIN points nowhere, PATH stripped, empty homes).
// The server must come up, serve the app and sign-in, report hermes.installed=false, answer Hermes routes with 503
// instead of hanging, and keep browser sockets open. POSIX also runs a fake installer (GIBBOUS_HERMES_INSTALLER) that
// streams a log and drops a stub `hermes` (e2e/fake-hermes-cli.ts) at HERMES_BIN: the server must detect it, start it,
// and then report the model state. Never runs the real installer. Run: node e2e/setup-smoke.ts  (SETUP_SMOKE_PORT, 7982)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import WebSocket from '../server/node_modules/ws/wrapper.mjs';

const PORT = Number(process.env.SETUP_SMOKE_PORT ?? 7982), BASE = `http://127.0.0.1:${PORT}`;
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-setup-smoke-')));
const home = path.join(root, 'home'), GH = path.join(home, '.gibbous'), bin = path.join(root, 'bin', 'hermes');
fs.mkdirSync(GH, { recursive: true });
const freePort = () => new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const posix = process.platform !== 'win32';

// The fake installer: progress lines (with \r redraws and colour), then a stub hermes where HERMES_BIN points.
const installer = path.join(root, 'fake-install.sh');
fs.writeFileSync(installer, [
  'echo "→ Checking prerequisites"', 'sleep 0.3',
  `printf '\\033[0;36m→\\033[0m Downloading 10%%\\r→ Downloading 60%%\\r→ Downloading 100%%\\n'`,
  'echo "✓ prerequisites ok (git, curl)"', 'sleep 0.3',
  'mkdir -p "$(dirname "$HERMES_BIN")"',
  `printf '#!/bin/sh\\nexec "%s" --disable-warning=ExperimentalWarning "%s" "$@"\\n' "${process.execPath}" "${path.join(import.meta.dirname, 'fake-hermes-cli.ts')}" > "$HERMES_BIN"`,
  'chmod +x "$HERMES_BIN"', 'echo "✓ Hermes Agent install complete. Run: hermes"',
].join('\n'));

const env: NodeJS.ProcessEnv = {
  HOME: home, USERPROFILE: home, GIBBOUS_HOME: GH, GIBBOUS_PORT: String(PORT), HERMES_HOME: path.join(home, '.hermes'),
  HERMES_BIN: bin, GIBBOUS_HERMES_PORT: String(await freePort()), PATH: posix ? '/usr/bin:/bin' : process.env.PATH,
  GIBBOUS_HERMES_INSTALLER: `sh "${installer}"`, FAKE_HERMES_UNCONFIGURED: '1',
  ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}),
};
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, '..', 'server', 'main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout!.on('data', d => { log += d; }); server.stderr!.on('data', d => { log += d; });

const results: [string, boolean, string?][] = [];
const check = async (name: string, f: () => Promise<unknown>) => {
  try { const note = await f(); results.push([name, true, note == null ? undefined : String(note)]); }
  catch (e: any) { results.push([name, false, e?.message ?? String(e)]); }
};
const ok = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let cookie = '';
const api = async (method: string, p: string, body?: unknown) => {
  const t = Date.now();
  const r = await fetch(BASE + p, { method, headers: { Cookie: cookie, Origin: BASE, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), signal: AbortSignal.timeout(20_000) });
  return { status: r.status, j: await r.json().catch(() => null) as any, ms: Date.now() - t };
};
const until = async <T>(f: () => Promise<T | undefined | false>, ms: number, what: string): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await f().catch(() => undefined); if (v) return v; }
  throw new Error(`timed out: ${what}`);
};

let code = 1;
const events: { kind: string; data: any }[] = [];
let ws: WebSocket | undefined, wsClosed = false, sawReady = false;
try {
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start in 30s')), 30_000);
    server.stdout!.on('data', d => { if (String(d).includes('Gibbous on')) { clearTimeout(t); res(); } });
    server.on('exit', c => rej(new Error(`server exited ${c}`)));
  });
  const access = JSON.parse(fs.readFileSync(path.join(GH, 'secret.json'), 'utf8')).accessToken as string;

  await check('boots without Hermes: sign-in and the web app', async () => {
    const r = await fetch(`${BASE}/login?token=${access}`, { redirect: 'manual' });
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    ok(r.status === 302 && cookie.startsWith('gibbous_auth='), `login ${r.status}`);
    const page = await fetch(`${BASE}/`);
    ok(page.status === 200 || page.status === 503, `index ${page.status}`); // 503 = web/dist not built in this checkout
  });
  await check('/api/state: hermes.installed=false, ready=false', async () => {
    const { j } = await api('GET', '/api/state');
    ok(j.hermes.installed === false && j.hermes.ready === false, JSON.stringify(j.hermes));
  });
  await check('/api/setup: OS, manual command, docs', async () => {
    const { j } = await api('GET', '/api/setup');
    ok(j.hermes.installed === false && /install\.(sh|ps1)/.test(j.install.command) && j.install.docs.startsWith('https://') && j.os, JSON.stringify(j));
    return `${j.os}: ${j.install.command}`;
  });
  await check('Hermes-backed routes answer 503 at once instead of hanging', async () => {
    const r = await api('GET', '/api/search?q=moon');
    ok(r.status === 503 && /isn't installed/.test(r.j.error) && r.ms < 3000, `${r.status} ${r.ms}ms ${JSON.stringify(r.j)}`);
    return `${r.ms}ms`;
  });
  await check('a browser socket stays open without Hermes', async () => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie, Origin: BASE } });
    ws.on('message', (d: Buffer) => { const m = JSON.parse(d.toString()); if (m.method === 'gibbous.event') events.push(m.params); if (m.params?.type === 'gateway.ready') sawReady = true; });
    ws.on('close', () => { wsClosed = true; });
    await new Promise((res, rej) => { ws!.once('open', res); ws!.once('error', rej); });
    await sleep(2500);
    ok(!wsClosed, 'socket was closed');
  });
  if (posix) {
    await check('install: live log over the socket, one at a time, then Hermes is detected and started', async () => {
      const r = await api('POST', '/api/setup/hermes/install', {});
      ok(r.status === 200 && r.j.install.running === true, `install ${r.status} ${JSON.stringify(r.j)}`);
      ok((await api('POST', '/api/setup/hermes/install', {})).status === 409, 'a second install was accepted');
      const done = await until(async () => events.find(e => e.kind === 'setupDone'), 20_000, 'setupDone');
      ok(done.data.ok === true, `setupDone ${JSON.stringify(done.data)}`);
      const lines = events.filter(e => e.kind === 'setupLog').map(e => e.data.line as string);
      ok(lines.includes('→ Downloading 60%') && lines.includes('✓ Hermes Agent install complete. Run: hermes') && !lines.some(l => l.includes('\x1b')), `log ${JSON.stringify(lines)}`);
      // Progress redraws (\r) replace the line before them: the kept log has one Downloading line, the last one.
      const kept = events.filter(e => e.kind === 'setupLog').reduce<string[]>((l, e) => e.data.replace ? [...l.slice(0, -1), e.data.line] : [...l, e.data.line], []);
      const saved = await api('GET', '/api/setup/log');
      ok(JSON.stringify(saved.j.lines) === JSON.stringify(kept) && saved.j.result.ok, `GET /api/setup/log ${JSON.stringify(saved.j.lines)}`);
      ok(kept.filter(l => l.includes('Downloading')).join() === '→ Downloading 100%', `progress lines ${JSON.stringify(kept)}`);
      const s = await until(async () => { const { j } = await api('GET', '/api/state'); return j.hermes.ready && j; }, 30_000, 'hermes ready after install');
      ok(s.hermes.installed === true && s.hermes.bin === bin, JSON.stringify(s.hermes));
      return `${lines.length} lines, version ${s.hermes.version}`;
    });
    await check('model state: not configured until a key + model are set through Hermes REST', async () => {
      const s = await until(async () => { const { j } = await api('GET', '/api/setup'); return j.configured === false && j; }, 15_000, 'configured=false');
      ok(events.some(e => e.kind === 'setup' && e.data.configured === false), 'no setup event');
      ok((await api('PUT', '/api/hermes/env', { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-test', provider_setup: true })).status === 200, 'PUT env');
      const set = await api('POST', '/api/hermes/model/set', { scope: 'main', provider: 'anthropic', model: 'claude-sonnet-4-5' });
      ok(set.j.ok, `model/set ${JSON.stringify(set.j)}`);
      const after = await api('POST', '/api/setup/check', {});
      ok(after.j.configured === true && after.j.hermes.model === 'claude-sonnet-4-5', JSON.stringify(after.j));
      return `${s.hermes.reason} → ${after.j.hermes.provider}/${after.j.hermes.model}`;
    });
    await check('the socket that waited now reaches Hermes', async () => {
      // Opened before Hermes existed: the same socket is piped through once Hermes is up.
      await until(async () => sawReady, 10_000, 'gateway.ready on the waiting socket');
      ok(!wsClosed, 'socket closed');
    });
  }
  code = results.every(r => r[1]) ? 0 : 1;
} catch (e: any) {
  results.push(['server boot', false, e?.message ?? String(e)]);
} finally {
  ws?.close();
  server.kill();
  try { const b = JSON.parse(fs.readFileSync(path.join(GH, 'hermes-backend.json'), 'utf8')); if (b.pid) process.kill(b.pid); } catch { /* never started */ }
  for (const [name, pass, note] of results) console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
  if (code) console.log('\n--- server log (token redacted) ---\n' + log.replace(/token=[\w-]+/g, 'token=…').slice(-4000));
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  console.log(code ? 'setup smoke FAILED' : `setup smoke passed (${results.length} checks, ${process.platform})`);
  process.exit(code);
}
