// iPhone footage from the real iOS app (ios/, Debug build) in a throwaway Simulator, signed in to the demo instance.
// Needs Xcode + an iOS runtime and `scripts/build-ios-app.sh` run once. Never foregrounds Simulator.app; the device is
// deleted afterwards. Output: ui/video/ios-approval.mp4 and ui/stills/ios-*.png.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BASE, OUT, REPO, sleep, type Env } from './lib.ts';
import { threadStatus } from './seed.ts';

const DEV = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer' };
const simctl = (...a: string[]) => execFileSync('xcrun', ['simctl', ...a], { env: DEV, encoding: 'utf8' }).trim();
const APP = path.join(REPO, 'ios/build/Build/Products/Debug-iphonesimulator/Gibbous.app');

export async function iosFootage(env: Env, o: { heroId: string; project: string }) {
  if (!fs.existsSync(APP)) { console.log('  ! ios: no simulator build (run scripts/build-ios-app.sh); skipped'); return; }
  const runtime = JSON.parse(simctl('list', 'runtimes', '-j')).runtimes.filter((r: any) => r.platform === 'iOS' && r.isAvailable).pop()?.identifier;
  if (!runtime) { console.log('  ! ios: no iOS simulator runtime; skipped'); return; }
  const udid = simctl('create', 'Gibbous demo', 'iPhone 17 Pro', runtime);
  console.log('ios: throwaway simulator', udid);
  try {
    simctl('boot', udid);
    simctl('bootstatus', udid, '-b');
    simctl('ui', udid, 'appearance', 'dark');
    simctl('status_bar', udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--wifiBars', '3', '--cellularMode', 'notSupported');
    simctl('install', udid, APP);
    // Sign-in link for the demo instance only; it is passed as a launch argument and never printed.
    simctl('launch', udid, 'dev.gibbous.ios', '-GibbousConnect', `${BASE}/login?token=${env.token}`);
    await sleep(7000);
    const data = simctl('get_app_container', udid, 'dev.gibbous.ios', 'data');
    const run = async (js: string, wait = 900) => { fs.mkdirSync(path.join(data, 'Documents'), { recursive: true }); fs.writeFileSync(path.join(data, 'Documents/debug.js'), js); await sleep(wait); };
    // Offline sky: a fixed location so the moon never looks up where this Mac is; quiet prefs like the desktop demo.
    await run(`localStorage.setItem('gibbous.location', JSON.stringify({ lat: 0, lon: 0, src: 'ip', at: Date.now() })); localStorage.setItem('gibbous.chime', '0'); localStorage.setItem('gibbous.seen', JSON.stringify({ '*': Date.now() })); location.hash = '#/t/${o.heroId}'; location.reload(); return 'ok';`, 6000);
    const still = (name: string) => { fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true }); simctl('io', udid, 'screenshot', '--type=png', path.join(OUT, 'stills', `${name}.png`)); console.log(`  ✓ stills/${name}.png`); };
    await run(`document.querySelectorAll('button[aria-label=Dismiss]').forEach(b => b.click()); const s = document.querySelector('.max-w-3xl.px-4.py-6')?.parentElement; if (s) s.scrollTop = s.scrollHeight; return 'ok';`, 1500);
    still('ios-01-thread');

    const out = path.join(OUT, 'video', 'ios-approval.mp4');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const rec = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', out], { env: DEV, stdio: 'ignore' });
    await sleep(1500);
    // A new thread hits an approval while you're reading another one: the app tells you, you open it and allow.
    const prune = await env.api('POST', '/api/threads', { projectId: o.project, title: 'Prune release branches', prompt: 'Delete the release branches on the remote that are already merged into main.' });
    await threadStatus(env, prune.id, 'needs_input');
    await sleep(1800);
    await run(`const t = [...document.querySelectorAll('[role=status] *, [role=alert] *, .toast, [data-toast]')].find(e => e.textContent?.includes('Prune release'));
      (t?.closest('button, a, [role=button]') ?? t)?.click?.(); setTimeout(() => { if (!location.hash.includes('${prune.id}')) location.hash = '#/t/${prune.id}'; }, 400); return t ? 'toast' : 'hash';`, 2600);
    still('ios-02-approval');
    await run(`const b = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Allow once'); b?.click(); return !!b;`, 300);
    await threadStatus(env, prune.id, 'idle');
    await sleep(2600);
    rec.kill('SIGINT');
    await new Promise(r => rec.on('exit', r));
    console.log('  ✓ video/ios-approval.mp4');
    await run(`location.hash = '#/inbox'; return 'ok';`, 2500);
    still('ios-03-inbox');
  } finally {
    try { simctl('shutdown', udid); } catch { /* already down */ }
    try { simctl('delete', udid); } catch { /* */ }
  }
}
