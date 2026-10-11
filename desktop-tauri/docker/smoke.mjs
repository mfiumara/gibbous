// Drives the installed app (/usr/bin/gibbous) through tauri-driver + WebKitWebDriver; run by docker/smoke.sh.
// Phases: connect screen while the server is unreachable → auto sign-in once it's up → bridge (notify + click, badge,
// external links, download, route) → hotkey + single instance → relaunch restores the route → AppImage launch.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

const PORT = process.env.GIBBOUS_PORT ?? '7989';
const MEDIA = process.env.MEDIA_PATH ?? '';
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
const newSession = async () => (await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: '/usr/bin/gibbous' } } } })).sessionId;
const js = (sid, script, args = []) => wd('POST', `/session/${sid}/execute/sync`, { script, args });
const jsAsync = (sid, script, args = []) => wd('POST', `/session/${sid}/execute/async`, { script, args });
const url = sid => wd('GET', `/session/${sid}/url`);
async function until(f, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch {} await sleep(300); } return false; }
const title = () => sh('xwininfo -root -tree').match(/"(\(\d+\) )?Gibbous"/)?.[0] ?? '';

const driver = spawn('tauri-driver', [], { stdio: ['ignore', 'inherit', 'inherit'] });
await until(() => fetch(WD + '/status').then(r => r.ok), 10000);

// 1 · server unreachable → connect screen
let sid = await newSession();
await sleep(2500);
const u1 = await url(sid);
const connectText = await js(sid, 'return document.body.innerText');
check('unreachable server shows the connect screen', u1.startsWith('tauri://localhost') && /Can't reach Gibbous/.test(connectText), u1);
shot('1-connect-screen');

// 2 · the server comes up (socat → host) → signs in by itself
const socat = spawn('socat', [`TCP-LISTEN:${PORT},bind=127.0.0.1,fork,reuseaddr`, `TCP:host.docker.internal:${PORT}`], { stdio: 'ignore' });
const signedIn = await until(async () => (await url(sid)).startsWith(`http://127.0.0.1:${PORT}/`) && await js(sid, 'return !!document.querySelector(\'nav[aria-label="Threads"]\')'), 20000);
check('auto sign-in once the server is reachable', signedIn, await url(sid));
const shellInfo = await js(sid, 'return { shell: window.__gibbousShell, data: document.documentElement.dataset.shell, bridge: typeof window.gibbousDesktop?.post }');
check('shell values + bridge injected', shellInfo.shell?.platform === 'linux' && shellInfo.data === 'linux' && shellInfo.bridge === 'function', JSON.stringify(shellInfo));
await sleep(1500);
shot('2-signed-in');

// 3 · bridge
await jsAsync(sid, "const done = arguments[arguments.length-1]; fetch('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => done(r.status), e => done(String(e)))");
await sleep(2000);
const hist = fs.readFileSync('/tmp/notify.log', 'utf8');
check('server notify → native notification (POST /api/push/test)', hist.includes('Notifications work.'), hist.includes('Notifications work.') ? '' : hist.slice(-300));
shot('3-notification');

await js(sid, "location.hash = '#/'");
sh('dunstctl close-all');
await sleep(500);
await jsAsync(sid, "const done = arguments[arguments.length-1]; window.gibbousDesktop.post('notify', { title: 'Smoke', body: 'Click to open Settings', url: '/#/settings/general', tag: 'smoke' }).then(() => done(1), e => done(String(e)))");
await sleep(1500);
sh('dunstctl action 0');
await sleep(300);
check('click reaches the app (ActionInvoked)', fs.readFileSync('/tmp/notify.log', 'utf8').includes('ActionInvoked'));
const opened = await until(async () => (await js(sid, 'return location.hash')).startsWith('#/settings'), 5000);
check('notification click → page opens its url', opened, await js(sid, 'return location.hash'));

await jsAsync(sid, "const done = arguments[arguments.length-1]; window.gibbousDesktop.post('badge', { count: 3 }).then(() => done(1), e => done(String(e)))");
await sleep(500);
check('badge → window title', title().includes('(3) Gibbous'), title());
await jsAsync(sid, "const done = arguments[arguments.length-1]; window.gibbousDesktop.post('badge', { count: 0 }).then(() => done(1), e => done(String(e)))");

await js(sid, "const a = document.createElement('a'); a.href = 'https://example.com/smoke-link'; a.textContent = 'x'; document.body.append(a); a.click(); a.remove(); window.open('https://example.org/smoke-popup'); return 1");
await sleep(1500);
await js(sid, "setTimeout(() => { location.href = 'https://example.net/smoke-nav' }, 10); return 1");
await sleep(2000);
const openedLog = fs.existsSync('/tmp/opened.log') ? fs.readFileSync('/tmp/opened.log', 'utf8') : '';
check('external link click → system browser', openedLog.includes('https://example.com/smoke-link'), openedLog.trim().replace(/\n/g, ' | '));
check('window.open → system browser', openedLog.includes('https://example.org/smoke-popup'));
check('navigation to another origin → system browser, app stays', openedLog.includes('https://example.net/smoke-nav') && (await url(sid)).startsWith(`http://127.0.0.1:${PORT}/`), await url(sid));
const blocked = await jsAsync(sid, "const done = arguments[arguments.length-1]; window.gibbousDesktop.post('open', { url: 'file:///bin/sh' }).then(() => done('opened'), e => done(String(e)))");
check('open refuses file: urls', blocked !== 'opened', String(blocked));

if (MEDIA) {
  const saved = await jsAsync(sid, "const done = arguments[arguments.length-1]; window.gibbousDesktop.post('download', { url: '/api/media?path=' + encodeURIComponent(arguments[0]), filename: 'smoke.txt' }).then(done, e => done('ERR ' + e))", [MEDIA]);
  const ok = typeof saved === 'string' && fs.existsSync(saved) && fs.readFileSync(saved, 'utf8').includes('gibbous smoke');
  check('download (page cookies) → ~/Downloads', ok, String(saved));
  const again = await jsAsync(sid, "const done = arguments[arguments.length-1]; window.gibbousDesktop.post('download', { url: '/api/media?path=' + encodeURIComponent(arguments[0]), filename: '../smoke.txt' }).then(done, e => done('ERR ' + e))", [MEDIA]);
  check('download never overwrites, strips paths', again === '/root/Downloads/smoke 2.txt', String(again));
  const rev = await jsAsync(sid, "const done = arguments[arguments.length-1]; window.gibbousDesktop.post('reveal', { path: '/etc/passwd' }).then(() => done('ok'), e => done(String(e)))");
  check('reveal refuses paths outside Downloads', rev !== 'ok', String(rev));
}

await js(sid, "location.hash = '#/settings/general'");
await sleep(800);
const cfg = '/root/.config/dev.gibbous.desktop/settings.json';
const saved = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8')) : {};
check('route reported and saved', saved.route === '#/settings/general', JSON.stringify(saved));

// hotkey: Ctrl+Alt+Space hides the focused window, again shows it
const winId = sh("xdotool search --onlyvisible --name '^Gibbous$' | head -1").trim();
sh(`xdotool windowfocus --sync ${winId}`); // no window manager: focus by hand (can race; rerun if this check flakes)
await sleep(800);
sh('xdotool key ctrl+alt+space');
await sleep(800);
const afterHide = sh(`xwininfo -id ${winId}`).match(/Map State: (\w+)/)?.[1];
// With no window focused X discards key events (no window manager here): focus another app, like a real desktop.
const clock = spawn('xclock', [], { stdio: 'ignore' });
await sleep(800);
sh("xdotool search --class xclock | head -1 | xargs -I{} xdotool windowfocus --sync {}");
sh('xdotool key ctrl+alt+space');
await sleep(800);
const afterShow = sh(`xwininfo -id ${winId}`).match(/Map State: (\w+)/)?.[1];
clock.kill();
check('Ctrl+Alt+Space toggles the window', afterHide === 'IsUnMapped' && afterShow === 'IsViewable', `after 1st: ${afterHide}, after 2nd: ${afterShow}`);

// single instance: a second launch exits and focuses the first
const second = spawn('/usr/bin/gibbous', [], { stdio: 'ignore' });
const code = await new Promise(r => { second.on('exit', c => r(c)); setTimeout(() => r('still running'), 6000); });
check('second launch hands over to the running app', code === 0, `exit ${code}; procs: ${sh('pgrep -c -x gibbous').trim()}`);
if (code === 'still running') second.kill();

await wd('DELETE', `/session/${sid}`);
await sleep(1500);

// 4 · relaunch reopens the route
sid = await newSession();
const restored = await until(async () => (await url(sid)).includes('#/settings/general') && await js(sid, 'return !!document.querySelector(\'nav[aria-label="Threads"]\')'), 20000);
check('relaunch restores the last route', restored, await url(sid));
await sleep(1500);
shot('4-route-restored');
await wd('DELETE', `/session/${sid}`);
driver.kill();
await sleep(1000);

// 5 · the AppImage starts and signs in too
const appimage = fs.readdirSync('/target/release/bundle/appimage').find(f => f.endsWith('.AppImage'));
if (appimage) {
  const p = spawn(`/target/release/bundle/appimage/${appimage}`, [], { stdio: 'ignore', env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' } });
  const t = await until(() => title(), 30000);
  await sleep(6000);
  shot('5-appimage');
  check('AppImage launches a Gibbous window', !!t, t);
  p.kill();
}
socat.kill();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync('/out/results.json', JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
