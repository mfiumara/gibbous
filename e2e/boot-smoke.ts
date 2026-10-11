// Boot smoke for every OS (CI on macOS, Linux, Windows; Docker): a real `node server/main.ts` with a throwaway home
// over the scripted fake Hermes (e2e/demo/fake-hermes.ts). Never touches ~/.gibbous or a real Hermes, sends no
// prompts to a model, opens no browser.   Run: node e2e/boot-smoke.ts   (SMOKE_PORT, default 7981)
// Checks: sign-in, /api/state (+ per-OS service info), folder picker order, mkdir, media serving/denial, reveal (only
// with CI=1 or SMOKE_REVEAL=1: it opens a file manager), project + chat thread + one turn, a worktree thread, and a
// terminal tab that runs a command in the default shell.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from '../server/node_modules/ws/wrapper.mjs';
import { fakeHermes } from './demo/fake-hermes.ts';

const PORT = Number(process.env.SMOKE_PORT ?? 7981), BASE = `http://127.0.0.1:${PORT}`;
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-smoke-'))); // native: no Windows 8.3 names
const home = path.join(root, 'home'), GH = path.join(home, '.gibbous');
fs.mkdirSync(GH, { recursive: true });
const token = randomBytes(16).toString('hex');
const fake = fakeHermes({ token, pick: () => async () => 'pong', titleFor: () => 'Smoke test', home });
fake.speed.factor = 0;
const hport = await fake.listen();
fs.writeFileSync(path.join(GH, 'hermes-backend.json'), JSON.stringify({ port: hport, token }));

const env: NodeJS.ProcessEnv = {
  ...process.env, HOME: home, USERPROFILE: home, GIBBOUS_HOME: GH, GIBBOUS_PORT: String(PORT), HERMES_HOME: path.join(home, '.hermes'),
  HERMES_BIN: path.join(root, 'no-hermes-here'), GIBBOUS_HERMES_PORT: String(hport + 1), // never a real backend
  GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s',
};
fs.writeFileSync(path.join(home, '.gitconfig'), '[init]\n\tdefaultBranch = main\n');
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, '..', 'server', 'main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout!.on('data', d => { log += d; }); server.stderr!.on('data', d => { log += d; });

const results: [string, boolean, string?][] = [];
const check = async (name: string, f: () => Promise<unknown>) => {
  try { const note = await f(); results.push([name, true, note == null ? undefined : String(note)]); }
  catch (e: any) { results.push([name, false, e?.message ?? String(e)]); }
};
const ok = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let cookie = '';
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(BASE + p, { method, headers: { Cookie: cookie, Origin: BASE, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const j: any = await r.json().catch(() => null);
  return { status: r.status, j };
};
const until = async <T>(f: () => Promise<T | undefined | false>, ms: number, what: string): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await f().catch(() => undefined); if (v) return v; }
  throw new Error(`timed out: ${what}`);
};

let code = 1;
try {
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start in 30s')), 30_000);
    server.stdout!.on('data', d => { if (String(d).includes('Gibbous on')) { clearTimeout(t); res(); } });
    server.on('exit', c => rej(new Error(`server exited ${c}`)));
  });
  const access = JSON.parse(fs.readFileSync(path.join(GH, 'secret.json'), 'utf8')).accessToken as string;

  await check('login link sets the cookie', async () => {
    ok(fs.readFileSync(path.join(GH, 'login-url'), 'utf8').includes('/login?token='), 'login-url missing');
    const r = await fetch(`${BASE}/login?token=${access}`, { redirect: 'manual' });
    ok(r.status === 302, `status ${r.status}`);
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    ok(cookie.startsWith('gibbous_auth='), 'no cookie');
    ok((await api('GET', '/api/state').then(r => r.status)) === 200, 'state with cookie');
    ok((await fetch(`${BASE}/api/state`)).status === 401, 'state without cookie must be 401');
  });
  await check('/api/state: hermes ready, platform + restart command', async () => {
    const s = await until(async () => { const { j } = await api('GET', '/api/state'); return j?.hermes?.ready && j; }, 20_000, 'hermes ready');
    ok(s.platform === process.platform, `platform ${s.platform}`);
    ok(typeof s.service?.restart === 'string' && s.service.restart.length > 5, 'service.restart');
    return `${s.platform}: ${s.service.restart}`;
  });
  await check('/api/fs/ls: folders only, hidden skipped, natural order', async () => {
    for (const d of ['b', 'A', 'a10', 'a2', '.hidden']) fs.mkdirSync(path.join(home, 'pick', d), { recursive: true });
    fs.writeFileSync(path.join(home, 'pick', 'file.txt'), 'x');
    const { status, j } = await api('GET', `/api/fs/ls?path=${encodeURIComponent(path.join(home, 'pick'))}`);
    ok(status === 200, `status ${status}`);
    ok(JSON.stringify(j.entries) === JSON.stringify(['A', 'a2', 'a10', 'b']), `entries ${JSON.stringify(j.entries)}`);
    ok(j.parent === home, `parent ${j.parent}`);
    const d = await api('GET', '/api/fs/ls');
    ok(d.j.path === home, `default path ${d.j.path} (home ${home})`);
    return j.entries.join(' ');
  });
  await check('/api/fs/mkdir: plain names inside home only', async () => {
    ok((await api('POST', '/api/fs/mkdir', { path: home, name: 'New folder' })).status === 200, 'mkdir');
    ok(fs.existsSync(path.join(home, 'New folder')), 'not created');
    ok((await api('POST', '/api/fs/mkdir', { path: home, name: 'a/b' })).status === 400, 'a/b accepted');
    ok((await api('POST', '/api/fs/mkdir', { path: root, name: 'x' })).status === 400, 'outside home accepted');
  });
  await check('/api/media: serves home files, refuses hidden folders', async () => {
    fs.mkdirSync(path.join(home, 'Pictures'), { recursive: true });
    const png = path.join(home, 'Pictures', 'smoke shot.png');
    fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    const r = await fetch(`${BASE}/api/media?path=${encodeURIComponent(png)}`, { headers: { Cookie: cookie } });
    ok(r.status === 200 && r.headers.get('content-type') === 'image/png', `media ${r.status}`);
    const s = await fetch(`${BASE}/api/media?path=${encodeURIComponent(path.join(GH, 'secret.json'))}`, { headers: { Cookie: cookie } });
    ok(s.status === 404, `secret.json served (${s.status})`);
  });
  if (process.env.CI || process.env.SMOKE_REVEAL) await check('/api/media/reveal never crashes the server', async () => {
    const { status, j } = await api('POST', '/api/media/reveal', { path: path.join(home, 'Pictures', 'smoke shot.png') });
    ok(status === 200 || status === 501, `status ${status} ${JSON.stringify(j)}`);
    await sleep(500);
    ok(server.exitCode === null && (await api('GET', '/api/state')).status === 200, 'server died');
    return status === 200 ? 'file manager launched' : j.error;
  });
  const repo = path.join(home, 'code', 'smoke-repo');
  let project: any, thread: any;
  await check('project + chat thread + one turn', async () => {
    fs.mkdirSync(repo, { recursive: true });
    for (const a of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: repo, env });
    project = (await api('POST', '/api/projects', { path: repo })).j;
    ok(project?.name === 'smoke-repo', `project ${JSON.stringify(project)}`);
    thread = (await api('POST', '/api/threads', { projectId: project.id })).j;
    ok(thread?.id, `thread ${JSON.stringify(thread)}`);
    ok((await api('POST', `/api/threads/${thread.id}/send`, { text: 'ping' })).status === 200, 'send');
    await until(async () => (await api('GET', '/api/state')).j.threads.find((t: any) => t.id === thread.id)?.lastText === 'pong', 15_000, 'reply pong');
    const ch = await api('GET', `/api/threads/${thread.id}/changes`);
    ok(ch.j?.repo === true, `changes ${JSON.stringify(ch.j)}`);
  });
  await check('worktree thread (git worktree add)', async () => {
    const w = (await api('POST', '/api/threads', { projectId: project.id, worktree: true, title: 'wt smoke' })).j;
    ok(w?.worktree?.path && fs.existsSync(w.worktree.path), `worktree ${JSON.stringify(w)}`);
    ok((await api('DELETE', `/api/threads/${w.id}?removeWorktree=1`, {})).status === 200, 'delete');
    return w.worktree.branch;
  });
  await check('terminal tab runs a command in the default shell', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/pty?thread=${thread.id}&name=smoke`, { headers: { Cookie: cookie, Origin: BASE } });
    let out = '';
    ws.on('message', (d: Buffer) => { out += d.toString(); });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    await sleep(1500); // let the login shell print its prompt
    ws.send('echo smoke-$((6*7))-ok\r'.replace('$((6*7))', process.platform === 'win32' ? '$(6*7)' : '$((6*7))'));
    await until(async () => out.includes('smoke-42-ok'), 15_000, `shell output (got ${JSON.stringify(out.slice(-300))})`);
    ws.send('\x00' + JSON.stringify({ close: true }));
    ws.close();
  });
  code = results.every(r => r[1]) ? 0 : 1;
} catch (e: any) {
  results.push(['server boot', false, e?.message ?? String(e)]);
} finally {
  server.kill();
  await fake.close();
  for (const [name, pass, note] of results) console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
  if (code) console.log('\n--- server log (token redacted) ---\n' + log.replace(/token=[\w-]+/g, 'token=…').slice(-4000));
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  console.log(code ? 'boot smoke FAILED' : `boot smoke passed (${results.length} checks, ${process.platform})`);
  process.exit(code);
}
