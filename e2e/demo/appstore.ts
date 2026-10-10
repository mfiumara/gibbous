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
    // en_US so the status bar reads 9:41, not 09:41.
    const prefs = path.join(os.homedir(), 'Library/Developer/CoreSimulator/Devices', udid, 'data/Library/Preferences/.GlobalPreferences.plist');
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    execFileSync('defaults', ['write', prefs, 'AppleLocale', 'en_US']);
    execFileSync('defaults', ['write', prefs, 'AppleLanguages', '-array', 'en-US']);
    execFileSync('defaults', ['write', prefs, 'AppleICUForce24HourTime', '-bool', 'false']);
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
    const data = simctl('get_app_container', udid, 'dev.gibbous.ios', 'data');
    const run = async (js: string, wait = 900) => { fs.mkdirSync(path.join(data, 'Documents'), { recursive: true }); fs.writeFileSync(path.join(data, 'Documents/debug.js'), js); await sleep(wait); };
    // The first signed-in launch asks for notifications (a system alert screenshots can't hide, and the simulator
    // can't pre-grant it). Keep feeding the page a script that marks the prompt as asked and mutes the native call,
    // so neither the login page's redirect nor Home's 1.5 s timer reaches iOS.
    // The page only posts to native while it believes it's in the iOS shell, so hide the shell flag until the timer
    // has passed; the reload below brings it back.
    const mute = `localStorage.setItem('gibbous.iosPushAsked', '1'); if (window.__gibbousShell) window.__gibbousShell = { ...window.__gibbousShell, platform: 'muted' }; delete document.documentElement.dataset.shell; return location.pathname;`;
    simctl('launch', udid, 'dev.gibbous.ios', '-GibbousConnect', `${BASE}/login?token=${env.token}`);
    for (let i = 0; i < 50; i++) await run(mute, 160);
    await sleep(2000);
    await run(`localStorage.setItem('gibbous.location', JSON.stringify({ lat: 0, lon: 0, src: 'ip', at: Date.now() })); localStorage.setItem('gibbous.chime', '0'); localStorage.setItem('gibbous.seen', JSON.stringify({ '*': Date.now() })); location.hash = '#/t/${o.heroId}'; location.reload(); return 'ok';`, 6000);
    const dismiss = `document.querySelectorAll('button[aria-label=Dismiss]').forEach(b => b.click()); (document.activeElement)?.blur?.();`;
    const scroller = `document.querySelector('.max-w-3xl.px-4.py-6')?.parentElement`;
    await run(`${dismiss} const s = ${scroller}; if (s) s.scrollTop = s.scrollHeight; return 'ok';`, 1500);
    still('01-thread-bottom');
    // The hero turn with its patch row opened, so the inline diff shows.
    await run(`const rows = [...document.querySelectorAll('button, [role=button]')].filter(b => /^patch\\s+src\\/index\\.ts/.test(b.innerText.trim().replace(/\\s+/g, ' ')) || /write_file\\s+src\\/sliding-window\\.ts/.test(b.innerText.trim())); rows.forEach(r => r.click()); setTimeout(() => rows[0]?.scrollIntoView({ block: 'start' }), 400); return rows.length;`, 2000);
    still('01-thread-diff');
    // A live turn: reasoning, tool calls and diffs streaming in.
    const live = await env.api('POST', '/api/threads', { projectId: o.project, title: 'Retry-After headers', prompt: 'Add Retry-After and RateLimit-Reset headers to the HTTP middleware when a request is rejected, and cover it with a test.' });
    await run(`${dismiss} location.hash = '#/t/${live.id}'; return 'ok';`, 600);
    for (let i = 0; i < 8; i++) { await sleep(700); still(`01-live-${i}`); }
    const prune = await env.api('POST', '/api/threads', { projectId: o.project, title: 'Prune release branches', prompt: 'Delete the release branches on the remote that are already merged into main.' });
    await threadStatus(env, prune.id, 'needs_input');
    await sleep(1500);
    await run(`${dismiss} location.hash = '#/t/${prune.id}'; return 'ok';`, 2500);
    await run(`${dismiss} const s = ${scroller}; if (s) s.scrollTop = s.scrollHeight; return 'ok';`, 1500);
    still('02-approval');
    await run(`${dismiss} location.hash = '#/inbox'; return 'ok';`, 2500);
    await run(`${dismiss} if (location.hash !== '#/inbox') location.hash = '#/inbox'; return 'ok';`, 2500);
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
