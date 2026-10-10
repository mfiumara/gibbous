// Quick look at the seeded demo: a few screenshots into $DEMO_SCRATCH/probe. Usage: node e2e/demo/probe.ts [--hold]
import fs from 'node:fs';
import path from 'node:path';
import { start, browser, open, go, sleep, SCRATCH } from './lib.ts';
import { seed } from './seed.ts';

const env = await start();
let b;
try {
  const s = await seed(env);
  console.log('seeded', JSON.stringify(s.threads));
  b = await browser();
  const o = await open(b, env, { seen: { '*': Date.now() } });
  const dir = path.join(SCRATCH, 'probe'); fs.mkdirSync(dir, { recursive: true });
  const snap = async (n: string) => { await o.page.screenshot({ path: path.join(dir, `${n}.png`) as `${string}.png` }); console.log('shot', n); };
  await go(o, '#/', 'What should we work on'); await snap('home');
  await go(o, `#/board/${s.tide.id}`, 'Redis store'); await sleep(800); await snap('board');
  await go(o, '#/sessions/cli', 'Profile the Redis'); await sleep(800); await snap('sessions-cli');
  await go(o, '#/sessions/claude', 'sliding log'); await sleep(800); await snap('sessions-claude');
  await go(o, '#/sessions/messaging', 'token bucket across'); await sleep(800); await snap('sessions-messaging');
  await go(o, `#/t/${s.threads.ts}`, 'TypeScript'); await sleep(800); await snap('ts');
  await go(o, '#/inbox', 'Inbox'); await snap('inbox');
  console.log('errors:', (o.page as any).demoErrors);
  if (process.argv.includes('--hold')) { console.log('holding 20 min'); await sleep(20 * 60_000); }
} finally {
  await b?.close();
  await env.stop();
}
