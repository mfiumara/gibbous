#!/usr/bin/env node
// Stage the Gibbous server for the desktop apps: a Node 22 runtime for the target OS/arch, the server sources (run
// with Node's type stripping, like `node server/main.ts`), their production node_modules and the web build.
//
//   node scripts/bundle-server.mjs --target darwin-universal|darwin-arm64|darwin-x64|linux-x64|linux-arm64|win32-x64|win32-arm64
//        [--out dir]          default dist/server-<target>; the bundle lands in <out>/gibbous-server
//        [--web dir]          reuse an existing web build instead of building one
//        [--node 22.x.y]      default: the newest 22.x release (GIBBOUS_NODE_VERSION also works)
//
// node_modules are copied out of this checkout's own install (pnpm lockfile versions), so run `pnpm install` on the
// target OS for Linux (node-pty is compiled there) and anywhere for macOS/Windows (node-pty ships prebuilds).
//
// Layout:
//   gibbous-server/
//     run                 POSIX launcher (login-shell PATH, then exec node); Windows starts node.exe directly
//     node/node[.exe]     the runtime (+ node/LICENSE)
//     app/package.json    name/version (Settings shows it)
//     app/server/…        *.ts minus tests, package.json, node_modules (ws, web-push, node-pty + their deps)
//     app/web/dist/…      the web app the server serves
//     manifest.json       versions + target
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).join(' ').split(/\s*--/).filter(Boolean).map(a => { const [k, ...v] = a.split(/\s+/); return [k, v.join(' ') || true]; }));
const TARGETS = ['darwin-universal', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];
const target = args.target ?? `${process.platform}-${process.arch}`;
if (!TARGETS.includes(target)) { console.error(`--target must be one of ${TARGETS.join(', ')}`); process.exit(2); }
const [plat, arch] = target.split('-');
const arches = arch === 'universal' ? ['arm64', 'x64'] : [arch];
const OUT = path.resolve(args.out ?? path.join(ROOT, 'dist', `server-${target}`));
const B = path.join(OUT, 'gibbous-server');
const log = (...a) => console.log('[bundle]', ...a);

fs.rmSync(B, { recursive: true, force: true });
fs.mkdirSync(path.join(B, 'node'), { recursive: true });

// ── Node runtime ────────────────────────────────────────────────────────────
const CACHE = process.env.GIBBOUS_NODE_CACHE ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'gibbous-node');
fs.mkdirSync(CACHE, { recursive: true });

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}
async function download(url, file) {
  if (fs.existsSync(file)) return;
  log('downloading', url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
  fs.renameSync(file + '.part', file);
}
const nodePlat = { darwin: 'darwin', linux: 'linux', win32: 'win' }[plat];
let version = args.node || process.env.GIBBOUS_NODE_VERSION;
const shaUrl = v => `https://nodejs.org/dist/${v}/SHASUMS256.txt`;
const sums = await fetchText(shaUrl(version ? `v${version.replace(/^v/, '')}` : 'latest-v22.x'));
if (!version) version = /node-v(22\.\d+\.\d+)-/.exec(sums)[1];
version = version.replace(/^v/, '');
if (!version.startsWith('22.')) throw new Error(`Node ${version}: the server needs Node 22`);

const nodeBins = [];
for (const a of arches) {
  const name = `node-v${version}-${nodePlat}-${a}`;
  const file = `${name}.${plat === 'win32' ? 'zip' : 'tar.xz'}`;
  const tarball = path.join(CACHE, file);
  await download(`https://nodejs.org/dist/v${version}/${file}`, tarball);
  const want = new RegExp(`^([0-9a-f]{64})\\s+${file.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1];
  const got = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  if (want !== got) { fs.rmSync(tarball); throw new Error(`${file}: checksum mismatch (deleted, run again)`); }
  const ex = fs.mkdtempSync(path.join(os.tmpdir(), 'gibnode-'));
  const inner = plat === 'win32' ? [`${name}/node.exe`, `${name}/LICENSE`] : [`${name}/bin/node`, `${name}/LICENSE`];
  execFileSync('tar', ['-xf', tarball, '-C', ex, ...inner]); // bsdtar (macOS, Windows) and GNU tar both read zip/xz
  nodeBins.push(path.join(ex, inner[0]));
  fs.copyFileSync(path.join(ex, inner[1]), path.join(B, 'node', 'LICENSE'));
}
const nodeOut = path.join(B, 'node', plat === 'win32' ? 'node.exe' : 'node');
if (nodeBins.length > 1) execFileSync('lipo', ['-create', ...nodeBins, '-output', nodeOut]);
else fs.copyFileSync(nodeBins[0], nodeOut);
fs.chmodSync(nodeOut, 0o755);
// macOS: drop local symbols (-44 MB universal; exported N-API symbols stay for addons), then re-sign ad hoc so the
// bundle runs as is (Apple Silicon kills unsigned code). The app build signs it properly (scripts/mac-embed-server.sh).
if (plat === 'darwin' && process.platform === 'darwin') {
  execFileSync('strip', ['-x', nodeOut], { stdio: 'ignore' });
  execFileSync('codesign', ['--force', '--sign', '-', nodeOut]);
}
// Official Linux builds keep their symbols (~+20 MB): strip when we can (a cross-arch strip just fails, harmless).
if (plat === 'linux' && process.platform === 'linux') try { execFileSync('strip', ['--strip-unneeded', nodeOut]); } catch { log('strip failed (kept symbols)'); }
for (const b of nodeBins) fs.rmSync(path.dirname(path.dirname(b)), { recursive: true, force: true });

// ── server sources ──────────────────────────────────────────────────────────
const APP = path.join(B, 'app');
const SRV = path.join(APP, 'server');
fs.mkdirSync(SRV, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'server'))) {
  if (!f.endsWith('.ts') || f.includes('.test.') || f === 'fake-hermes.ts') continue;
  fs.copyFileSync(path.join(ROOT, 'server', f), path.join(SRV, f));
}
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const srvPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'package.json'), 'utf8'));
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: 'gibbous', version: rootPkg.version, private: true, type: 'module' }, null, 2) + '\n');
fs.writeFileSync(path.join(SRV, 'package.json'), JSON.stringify({ name: 'server', private: true, type: 'module', dependencies: srvPkg.dependencies }, null, 2) + '\n');
// /api/smoke scans web/src for the RPC methods it calls; the bundle has no sources, so ship the list.
// Same scan as smoke.ts usedMethods() (not imported: loading the server modules touches GIBBOUS_HOME).
const methods = new Set();
for (const dir of ['server', 'web/src']) for (const f of walkFiles(path.join(ROOT, dir)))
  if (/\.tsx?$/.test(f) && !f.includes('.test.') && !f.includes(`${path.sep}node_modules${path.sep}`) && !f.includes(`${path.sep}hermes${path.sep}`) && path.basename(f) !== 'fake-hermes.ts')
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bcall(?:<[^>]*>)?\('([a-z_]+(?:\.[a-z_]+)+)'/g)) methods.add(m[1]);
fs.writeFileSync(path.join(SRV, 'used-methods.json'), JSON.stringify([...methods].sort()) + '\n');

// ── production node_modules (flattened out of the pnpm store) ───────────────
// Node's own lookup: <ancestor>/node_modules/<dep>, skipping ancestors that are node_modules themselves.
function resolvePkg(fromDir, dep) {
  for (let d = fromDir; ; d = path.dirname(d)) {
    if (path.basename(d) !== 'node_modules') {
      const p = path.join(d, 'node_modules', dep);
      if (fs.existsSync(path.join(p, 'package.json'))) return fs.realpathSync(p);
    }
    if (path.dirname(d) === d) return null;
  }
}
const placed = new Map(); // name → {version, dir}
const BUILD_ONLY = new Set(['node-addon-api', 'node-gyp', 'prebuild-install']); // headers/tools for compiling node-pty
const JUNK = /^(\.github|test|tests|__tests__|docs?|examples?|benchmarks?|\.vscode|coverage)$/i;
const JUNK_FILE = /(\.(md|markdown|map|ts|tsbuildinfo|pdb|gyp|gypi|cc|h|c|cpp|o|a|lib|exp|ilk|iobj|ipdb)|^(\.npmignore|\.eslintrc.*|\.editorconfig|\.travis\.yml|tsconfig\.json|Makefile|binding\.gyp|CHANGELOG.*|HISTORY.*|README.*))$/i;
function copyPkg(src, dst, name) {
  const keepNative = name === 'node-pty';
  const walk = (s, d, rel) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') continue;
      if (e.isDirectory()) {
        if (keepNative) {
          // node-pty: lib/ + the native bits for this target only.
          if (!rel && !['lib', 'prebuilds', 'build'].includes(e.name)) continue;
          if (rel === 'prebuilds' && !arches.some(a => e.name === `${plat}-${a}`)) continue;
          if (rel === 'build' && e.name !== 'Release') continue;
          if (rel === 'build/Release') continue; // obj.target, .deps…
          if (r.startsWith('lib/') && /^(test|testing)$/.test(e.name)) continue;
        } else if (JUNK.test(e.name) && rel === '') continue;
        walk(path.join(s, e.name), path.join(d, e.name), r);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (e.name.endsWith('.d.ts') || (JUNK_FILE.test(e.name) && !/^LICEN[CS]E/i.test(e.name))) continue;
        if (keepNative && r.startsWith('build/Release/') && !/^(pty\.node|spawn-helper)$/.test(e.name)) continue;
        if (keepNative && r.startsWith('lib/') && /\.test\.js$/.test(e.name)) continue;
        const sp = path.join(s, e.name);
        fs.copyFileSync(fs.realpathSync(sp), path.join(d, e.name));
        fs.chmodSync(path.join(d, e.name), fs.statSync(sp).mode & 0o777);
      }
    }
  };
  walk(src, dst, '');
}
function install(name, fromDir, parentOut) {
  const src = resolvePkg(fromDir, name);
  if (!src) throw new Error(`${name} not installed (run pnpm install)`);
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  const have = placed.get(name);
  let dst;
  if (!have) { dst = path.join(SRV, 'node_modules', name); placed.set(name, { version: pkg.version, dir: dst }); }
  else if (have.version === pkg.version) return;
  else dst = path.join(parentOut, 'node_modules', name); // a second version nests under its dependent
  copyPkg(src, dst, name);
  const optional = Object.keys(pkg.optionalDependencies ?? {}).filter(d => resolvePkg(src, d));
  for (const d of [...Object.keys(pkg.dependencies ?? {}), ...optional]) if (!BUILD_ONLY.has(d)) install(d, src, dst);
}
for (const d of Object.keys(srvPkg.dependencies)) install(d, path.join(ROOT, 'server'), SRV);

// node-pty: the native addon must exist for every arch we ship.
const pty = path.join(SRV, 'node_modules', 'node-pty');
for (const a of arches) {
  const pre = path.join(pty, 'prebuilds', `${plat}-${a}`, 'pty.node');
  const built = path.join(pty, 'build', 'Release', 'pty.node');
  if (!fs.existsSync(pre) && !fs.existsSync(built)) throw new Error(`node-pty has no ${plat}-${a} binary: run pnpm install on that platform`);
  if (!fs.existsSync(pre) && plat !== process.platform) throw new Error(`node-pty for ${plat}-${a} must be built on ${plat}`);
}
if (fs.existsSync(path.join(pty, 'build')) && plat === 'darwin') fs.rmSync(path.join(pty, 'build'), { recursive: true }); // prebuilds suffice
for (const f of walkFiles(pty)) if (path.basename(f) === 'spawn-helper') fs.chmodSync(f, 0o755);

// ── web app ─────────────────────────────────────────────────────────────────
const WEB = path.join(APP, 'web', 'dist');
if (args.web) fs.cpSync(path.resolve(args.web), WEB, { recursive: true });
else {
  log('building the web app');
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', 'web', 'exec', 'vite', 'build', '--outDir', WEB, '--emptyOutDir', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
}
for (const f of walkFiles(WEB)) if (f.endsWith('.map')) fs.rmSync(f);

// ── launcher ────────────────────────────────────────────────────────────────
if (plat !== 'win32') {
  fs.copyFileSync(path.join(ROOT, 'scripts', 'server-run.sh'), path.join(B, 'run'));
  fs.chmodSync(path.join(B, 'run'), 0o755);
}
const srvVersions = Object.fromEntries([...placed].map(([n, v]) => [n, v.version]));
fs.writeFileSync(path.join(B, 'manifest.json'), JSON.stringify({ target, node: version, gibbous: rootPkg.version, commit: gitRev(), modules: srvVersions }, null, 2) + '\n');

function gitRev() { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }
function walkFiles(d) { return fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true, recursive: true }).filter(e => e.isFile()).map(e => path.join(e.parentPath ?? e.path, e.name)) : []; }
const size = d => walkFiles(d).reduce((n, f) => n + fs.statSync(f).size, 0);
const mb = n => `${(n / 1e6).toFixed(1)} MB`;
log(`${target}: node ${version} ${mb(size(path.join(B, 'node')))}, server+modules ${mb(size(SRV))}, web ${mb(size(WEB))}, total ${mb(size(B))}`);
log(B);
