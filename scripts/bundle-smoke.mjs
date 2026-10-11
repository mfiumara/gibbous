#!/usr/bin/env node
// Boot the bundled server (scripts/bundle-server.mjs output) the way a fresh desktop install would: its own Node,
// a throwaway GIBBOUS_HOME, no Hermes (HERMES_BIN points nowhere, bare PATH). Checks the web app, the sign-in
// routes, /api/state and that node-pty loads, then stops it. Exit code 0 = good.
//   node scripts/bundle-smoke.mjs <dir>/gibbous-server [port] [--exe <desktop app binary>]
// --exe starts `<app> --serve` (the background service's entry point) instead of the bundle directly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const exeAt = argv.indexOf('--exe');
const exe = exeAt >= 0 ? path.resolve(argv.splice(exeAt, 2)[1]) : '';
const B = path.resolve(argv[0] ?? '');
const PORT = Number(argv[1] ?? 7996);
const win = process.platform === 'win32';
const node = path.join(B, 'node', win ? 'node.exe' : 'node');
if (!fs.existsSync(node)) { console.error(`usage: bundle-smoke.mjs <gibbous-server dir>  (no ${node})`); process.exit(2); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-bundle-smoke-'));
const bare = win ? [process.env.SystemRoot + '\\System32', process.env.SystemRoot].join(';') : '/usr/bin:/bin';
const env = { ...(win ? { SystemRoot: process.env.SystemRoot, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TEMP: os.tmpdir(), TMP: os.tmpdir() } : {}),
  HOME: home, PATH: bare, GIBBOUS_HOME: path.join(home, '.gibbous'), GIBBOUS_PORT: String(PORT), HERMES_BIN: path.join(home, 'no-hermes'), GIBBOUS_KEEP_PATH: '1' };
const fail = m => { console.error('FAIL', m); try { console.error(fs.readFileSync(path.join(home, 'out.log'), 'utf8').replace(/token=\w+/g, 'token=…')); } catch {} cleanup(); process.exit(1); };
const out = fs.openSync(path.join(home, 'out.log'), 'w');
const child = exe ? spawn(exe, ['--serve'], { env, stdio: ['ignore', out, out] }) : win
  ? spawn(node, ['--disable-warning=ExperimentalWarning', path.join(B, 'app', 'server', 'main.ts')], { env, stdio: ['ignore', out, out] })
  : spawn('/bin/sh', [path.join(B, 'run')], { env, stdio: ['ignore', out, out] });
function cleanup() { try { child.kill(); } catch {} setTimeout(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }), 500); }

const base = `http://127.0.0.1:${PORT}`;
const loginFile = path.join(env.GIBBOUS_HOME, 'login-url');
for (let i = 0; !fs.existsSync(loginFile); i++) {
  if (i > 60) fail('no login-url after 30s');
  if (child.exitCode !== null) fail(`server exited (${child.exitCode})`);
  await new Promise(r => setTimeout(r, 500));
}
const checks = [];
const ok = (name, cond, detail = '') => { checks.push(name); if (!cond) fail(`${name} ${detail}`); console.log('ok', name); };
const index = await fetch(base + '/');
const html = await index.text();
ok('GET / serves the web app', index.status === 200 && html.includes('<div id="root"'), String(index.status));
const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
ok('entry script', asset && (await fetch(base + asset)).status === 200, asset);
ok('GET /login without a token is 401', (await fetch(base + '/login?token=nope', { redirect: 'manual' })).status === 401);
const token = new URL(fs.readFileSync(loginFile, 'utf8').trim()).searchParams.get('token');
const login = await fetch(`${base}/login?token=${token}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
ok('sign-in sets a cookie', login.status === 302 && cookie, String(login.status));
const st = await fetch(base + '/api/state', { headers: { cookie } });
ok('/api/state without Hermes', st.status === 200 && Array.isArray((await st.json()).threads), String(st.status));
ok('server still running', child.exitCode === null);
// node-pty's native addon for this OS/arch.
const ptyProbe = `const p=require('node-pty');const t=p.spawn(${JSON.stringify(win ? 'cmd.exe' : '/bin/echo')},${JSON.stringify(win ? ['/c', 'echo pty-ok'] : ['pty-ok'])},{});let o='';t.onData(d=>o+=d);t.onExit(()=>{console.log(o.includes('pty-ok')?'PTY-OK':'PTY-BAD '+o);process.exit(0)})`;
const pty = execFileSync(node, ['-e', ptyProbe], { cwd: path.join(B, 'app', 'server'), env: { ...process.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
ok('node-pty spawns a terminal', pty.includes('PTY-OK'), pty);
console.log(`bundle smoke passed (${checks.length} checks, node ${execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()})`);
cleanup();
setTimeout(() => process.exit(0), 800);
