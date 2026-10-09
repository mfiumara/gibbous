// Mac-shell smoke in WebKit (node e2e/_macsmoke.ts <GIBBOUS_HOME> <port>): fake the app's injected script + bridge, check layout and drag messages.
import fs from 'node:fs';
import { webkit } from 'playwright-core';
const H = process.argv[2], PORT = process.argv[3];
const token = JSON.parse(fs.readFileSync(`${H}/secret.json`, 'utf8')).accessToken;
const b = await webkit.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript({ content: `window.__gibbousShell={titlebar:28,fullscreen:false};window.__win=[];window.webkit={messageHandlers:{gibbousNotify:{postMessage(){}},gibbousBadge:{postMessage(){}},gibbousWindow:{postMessage(m){window.__win.push(m)}}}};` });
const errs: string[] = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto(`http://127.0.0.1:${PORT}/login?token=${token}`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
const tid = await p.evaluate(async () => (await (await fetch('/api/state')).json()).threads.find((t: any) => t.status !== 'archived' && !t.readOnly).id);
await p.evaluate(h => { location.hash = h; }, `#/t/${tid}`); await p.waitForTimeout(3000);
const info = await p.evaluate(() => {
  const nav = document.querySelector('nav[aria-label=Threads]')!, logo = nav.querySelector('div')!.getBoundingClientRect();
  return { navPT: getComputedStyle(nav).paddingTop, logoTop: Math.round(logo.top), bodyBg: getComputedStyle(document.body).backgroundColor, menu: typeof (window as any).gibbousMenu };
});
await p.mouse.move(900, 40); await p.mouse.down(); await p.mouse.up();
const afterHeader = await p.evaluate(() => (window as any).__win.filter((m: any) => m.drag).length);
await p.click('[aria-label="More"]'); await p.keyboard.press('Escape');
const afterButton = await p.evaluate(() => (window as any).__win.filter((m: any) => m.drag).length);
await p.evaluate(() => (window as any).gibbousMenu('new')); await p.waitForTimeout(500);
const hash = await p.evaluate(() => location.hash);
await p.screenshot({ path: process.env.HOME + '/.hermes/cache/scratch/all-mac-webkit.png' });
console.log(JSON.stringify({ ...info, afterHeader, afterButton, hash, errs }));
await b.close();
