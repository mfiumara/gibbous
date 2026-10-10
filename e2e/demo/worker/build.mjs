// Copies the web build that fixtures.json was recorded with into ./public (the demo Worker's static assets):
// everything except assets/, plus only the assets its index.html reaches (dist keeps a week of old chunks).
// The build must match the recording, or new web code would call routes the recording doesn't have. Candidates:
// $DEMO_DIST, the recorder's snapshot (scratch/gibbous-demo/app/web/dist), web/dist.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = import.meta.dirname, out = path.join(here, 'public');
const fixtures = path.join(here, 'fixtures.json');
if (!fs.existsSync(fixtures)) throw new Error('fixtures.json is missing: run node e2e/demo/record.ts first');
const want = JSON.parse(fs.readFileSync(fixtures, 'utf8')).stateBefore.build;
const entry = dir => /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(fs.existsSync(path.join(dir, 'index.html')) ? fs.readFileSync(path.join(dir, 'index.html'), 'utf8') : '')?.[1];
const scratch = process.env.DEMO_SCRATCH ?? path.join(os.homedir(), '.hermes/cache/scratch/gibbous-demo');
const candidates = [process.env.DEMO_DIST, path.join(scratch, 'app/web/dist'), path.resolve(here, '../../../web/dist')].filter(Boolean);
const dist = candidates.find(d => entry(d) === want);
if (!dist) throw new Error(`no web build matches the recording (${want}); web/dist has ${entry(candidates.at(-1))}. Re-record: node e2e/demo/record.ts`);

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(dist, out, { recursive: true, filter: src => path.relative(dist, src).split(path.sep)[0] !== 'assets' });
const assets = path.join(dist, 'assets'), dest = path.join(out, 'assets');
fs.mkdirSync(dest, { recursive: true });
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const todo = [...html.matchAll(/\/assets\/([^"')\s]+)/g)].map(m => m[1]), seen = new Set();
while (todo.length) {
  const f = todo.pop();
  if (seen.has(f) || !fs.existsSync(path.join(assets, f))) continue;
  seen.add(f);
  fs.copyFileSync(path.join(assets, f), path.join(dest, f));
  if (/\.(js|css)$/.test(f)) for (const m of fs.readFileSync(path.join(assets, f), 'utf8').matchAll(/([\w.-]+-[\w-]{8}\.(?:js|css|woff2?|png|svg|webp|wasm))/g)) todo.push(m[1]);
}
fs.writeFileSync(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log(`public/ ← ${path.relative(process.cwd(), dist) || dist}: ${seen.size} assets, entry ${want}`);
