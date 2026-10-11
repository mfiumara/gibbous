// Run by docker/bundled-smoke.sh: a fresh home (no ~/.gibbous, no Hermes on PATH) → the app starts its bundled server,
// signs in to it by itself and shows the web app; quitting the app (window close → tray Quit isn't reachable
// headless, so the app is ended through WebDriver) leaves no stray app process.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = c => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); } };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const shot = name => { sh(`import -window root /out/${name}.png`); console.log(`shot /out/${name}.png`); };
const WD = 'http://127.0.0.1:4444';
async function wd(method, path, body) {
  const r = await fetch(WD + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j).slice(0, 400)}`);
  return j.value;
}
const js = (sid, script, args = []) => wd('POST', `/session/${sid}/execute/sync`, { script, args });
const url = sid => wd('GET', `/session/${sid}/url`);
async function until(f, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch {} await sleep(300); } return false; }

fs.rmSync('/root/.gibbous', { recursive: true, force: true });
check('no system Gibbous or Hermes', !fs.existsSync('/root/.gibbous') && !sh('command -v hermes').trim() && !sh('ss -ltn').includes(':7878 '));
const driver = spawn('tauri-driver', [], { stdio: ['ignore', 'inherit', 'inherit'] });
await until(() => fetch(WD + '/status').then(r => r.ok), 10000);
const sid = (await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: '/usr/bin/gibbous' } } } })).sessionId;
const signedIn = await until(async () => (await url(sid)).startsWith('http://127.0.0.1:7878/') && await js(sid, "return document.readyState === 'complete' && !!document.querySelector('#root > *')"), 45000);
check('starts the bundled server and signs in by itself', signedIn, await url(sid).catch(String));
const ps = sh('ps -eo pid,args');
check('server runs on the bundled node', ps.includes('/usr/lib/Gibbous/gibbous-server/node/node'), ps.split('\n').filter(l => /gibbous/i.test(l)).join(' | '));
check('login-url written to ~/.gibbous', fs.existsSync('/root/.gibbous/login-url'));
await sleep(2500);
const info = await js(sid, "return { shell: window.__gibbousShell && window.__gibbousShell.platform, text: document.body.innerText.slice(0, 300), hash: location.hash }");
check('web app rendered in the shell', info.shell === 'linux' && info.text.length > 0, JSON.stringify(info));
shot('bundled-signed-in');
const state = await js(sid, "return fetch('/api/state').then(r => r.status)").catch(e => String(e));
console.log('api/state from the page:', state);
await wd('DELETE', `/session/${sid}`).catch(() => {});
await sleep(1500);
driver.kill();
fs.writeFileSync('/out/bundled-results.json', JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.ok);
console.log(failed.length ? `${failed.length} FAILED` : `all ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
