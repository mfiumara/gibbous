// App Store screenshots from the real iOS app (ios/, Debug simulator build) on a throwaway iPhone 17 Pro Max
// (1320×2868), signed in to the demo instance. Like ios.ts: never foregrounds Simulator.app, deletes the device after.
// Output: ~/gibbous-launch/appstore/ios/raw/*.png (captioned versions are made by ~/gibbous-launch/appstore/caption.py).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE, REPO, sleep, type Env } from './lib.ts';
import { threadStatus } from './seed.ts';

const DEV = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer' };
const simctl = (...a: string[]) => execFileSync('xcrun', ['simctl', ...a], { env: DEV, encoding: 'utf8' }).trim();
const APP = path.join(REPO, 'ios/build/Build/Products/Debug-iphonesimulator/Gibbous.app');
const RAW = process.env.APPSTORE_OUT ?? path.join(os.homedir(), 'gibbous-launch/appstore/ios/raw');

export async function appStoreShots(env: Env, o: { heroId: string; project: string }) {
  if (!fs.existsSync(APP)) { console.log('  ! appstore: no simulator build (run scripts/build-ios-app.sh); skipped'); return; }
  const runtime = JSON.parse(simctl('list', 'runtimes', '-j')).runtimes.filter((r: any) => r.platform === 'iOS' && r.isAvailable).pop()?.identifier;
  const udid = simctl('create', 'Gibbous App Store', 'iPhone 17 Pro Max', runtime);
  console.log('appstore: throwaway simulator', udid);
  fs.mkdirSync(RAW, { recursive: true });
  const still = (name: string) => { simctl('io', udid, 'screenshot', '--type=png', path.join(RAW, `${name}.png`)); console.log(`  ✓ ${name}.png`); };
  try {
    simctl('boot', udid);
    simctl('bootstatus', udid, '-b');
    simctl('ui', udid, 'appearance', 'dark');
    simctl('status_bar', udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--wifiBars', '3', '--cellularMode', 'notSupported');
    simctl('install', udid, APP);
    // The connect screen, before signing in.
    simctl('launch', udid, 'dev.gibbous.ios');
    await sleep(4000);
    still('00-connect');
    simctl('terminate', udid, 'dev.gibbous.ios');
    // Sign-in link for the demo instance only; passed as a launch argument, never printed.
    simctl('launch', udid, 'dev.gibbous.ios', '-GibbousConnect', `${BASE}/login?token=${env.token}`);
    await sleep(7000);
    const data = simctl('get_app_container', udid, 'dev.gibbous.ios', 'data');
    const run = async (js: string, wait = 900) => { fs.mkdirSync(path.join(data, 'Documents'), { recursive: true }); fs.writeFileSync(path.join(data, 'Documents/debug.js'), js); await sleep(wait); };
    await run(`localStorage.setItem('gibbous.location', JSON.stringify({ lat: 0, lon: 0, src: 'ip', at: Date.now() })); localStorage.setItem('gibbous.chime', '0'); localStorage.setItem('gibbous.iosPushAsked', '1'); localStorage.setItem('gibbous.seen', JSON.stringify({ '*': Date.now() })); return 'ok';`, 1500);
    // The first signed-in launch asks for notifications (a system alert screenshots can't hide). The page has now
    // recorded that it asked, so a relaunch comes up without it; the sign-in cookie survives.
    simctl('terminate', udid, 'dev.gibbous.ios');
    await sleep(1500);
    simctl('launch', udid, 'dev.gibbous.ios');
    await sleep(6000);
    await run(`location.hash = '#/t/${o.heroId}'; return 'ok';`, 3000);
    const dismiss = `document.querySelectorAll('button[aria-label=Dismiss]').forEach(b => b.click()); (document.activeElement)?.blur?.();`;
    const scroller = `document.querySelector('.max-w-3xl.px-4.py-6')?.parentElement`;
    await run(`${dismiss} const s = ${scroller}; if (s) s.scrollTop = s.scrollHeight; return 'ok';`, 1500);
    still('01-thread-bottom');
    await run(`const s = ${scroller}; if (s) s.scrollTop = Math.max(0, s.scrollHeight * 0.45); return 'ok';`, 1200);
    still('01-thread-mid');
    await run(`const s = ${scroller}; if (s) s.scrollTop = 0; return 'ok';`, 1200);
    still('01-thread-top');

    const prune = await env.api('POST', '/api/threads', { projectId: o.project, title: 'Prune release branches', prompt: 'Delete the release branches on the remote that are already merged into main.' });
    await threadStatus(env, prune.id, 'needs_input');
    await sleep(1500);
    await run(`${dismiss} location.hash = '#/t/${prune.id}'; return 'ok';`, 2500);
    await run(`${dismiss} const s = ${scroller}; if (s) s.scrollTop = s.scrollHeight; return 'ok';`, 1500);
    still('02-approval');
    await run(`${dismiss} location.hash = '#/inbox'; return 'ok';`, 2500);
    still('03-inbox');
    await run(`${dismiss} location.hash = '#/board/${o.project}'; return 'ok';`, 3000);
    still('04-board');
    await run(`${dismiss} location.hash = '#/sessions'; return 'ok';`, 3000);
    still('04-sessions');
    await run(`${dismiss} location.hash = '#/'; return 'ok';`, 2500);
    still('05-home');
    // A waxing gibbous over the inbox and home sky.
    await run(`localStorage.setItem('gibbous.moonAt', '2026-10-23T20:00:00Z'); window.__moonRedraw?.(); location.hash = '#/inbox'; return 'ok';`, 2500);
    still('05-inbox-gibbous');
    await run(`location.hash = '#/'; return 'ok';`, 2500);
    still('05-home-gibbous');
    await run(`localStorage.removeItem('gibbous.moonAt'); return 'ok';`, 300);
  } finally {
    try { simctl('shutdown', udid); } catch { /* already down */ }
    try { simctl('delete', udid); } catch { /* */ }
  }
}
