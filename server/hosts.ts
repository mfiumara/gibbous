// Other machines running Hermes, reached over SSH exactly like Hermes Desktop does: start `hermes serve` there on
// loopback (desktop mode, token handed over in a private file, never on a command line) and talk to it through
// an `ssh -L` tunnel. Neither end listens on a public interface.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { GIBBOUS_HOME, readJson, writeJsonAtomic, type Host } from './store.ts';
import type { Backend } from './hermes.ts';

const DIR = path.join(GIBBOUS_HOME, 'hosts');
const tunnels = new Map<string, ChildProcess>();

const freePort = (start: number) => new Promise<number>(resolve => {
  const s = net.createServer();
  s.once('error', () => resolve(freePort(start + 1)));
  s.listen(start, '127.0.0.1', () => s.close(() => resolve(start)));
});

async function alive(b: Backend) {
  try { return (await fetch(`http://127.0.0.1:${b.port}/api/config`, { headers: { 'X-Hermes-Session-Token': b.token }, signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

function ssh(host: Host, args: string[], input?: string): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host.ssh, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d));
    p.on('close', code => resolve({ code: code ?? 1, out }));
    p.stdin.end(input ?? '');
  });
}

function ensureTunnel(host: Host, localPort: number) {
  const cur = tunnels.get(host.id);
  if (cur && cur.exitCode === null) return;
  const p = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-L', `${localPort}:127.0.0.1:${host.remotePort}`, host.ssh], { stdio: 'ignore' });
  tunnels.set(host.id, p);
  p.on('exit', () => { if (tunnels.get(host.id) === p) tunnels.delete(host.id); });
}

export function closeHost(id: string, forget = false) {
  tunnels.get(id)?.kill(); tunnels.delete(id);
  if (forget) fs.rmSync(path.join(DIR, `${id}.json`), { force: true }); // a removed host leaves no token behind
}

// The remote start script travels over stdin, so the token never shows up in any process list.
export const startScript = (token: string, port: number) => {
  const dir = randomBytes(16).toString('hex'), file = `${randomBytes(8).toString('hex')}.token`;
  return `set -e
root="$HOME/.hermes/desktop-ssh"; d="$root/${dir}"
mkdir -p "$d"; chmod 700 "$root" "$d"; umask 077
printf %s '${token}' > "$d/${file}"
HERMES=$(command -v hermes || echo "$HOME/.local/bin/hermes")
HERMES_DESKTOP=1 nohup "$HERMES" serve --port ${port} --skip-build --ssh-session-token-file "$d/${file}" > "$HOME/.hermes/gibbous-serve.log" 2>&1 < /dev/null &
echo started`;
};

export async function ensureRemoteBackend(host: Host): Promise<Backend> {
  const file = path.join(DIR, `${host.id}.json`);
  const saved = readJson<{ token: string; localPort: number } | null>(file, null);
  const b: Backend = saved ? { port: saved.localPort, token: saved.token } : { port: await freePort(9300), token: randomBytes(24).toString('hex') };
  if (!saved) { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeJsonAtomic(file, { token: b.token, localPort: b.port }); }
  ensureTunnel(host, b.port);
  for (let i = 0; i < 10 && !tunnels.get(host.id)?.pid; i++) await new Promise(r => setTimeout(r, 200));
  if (await alive(b)) return b;
  // Not running (or started with another token): start a fresh backend with ours.
  const r = await ssh(host, ['bash', '-l', '-s'], startScript(b.token, host.remotePort));
  if (r.code !== 0) {
    // Keep Tailscale SSH's check-mode link (printed before ssh's last line) so the app can offer it.
    const link = /https:\/\/login\.tailscale\.com\/a\/\w+/.exec(r.out)?.[0];
    throw new Error(`couldn't start Hermes on ${host.name}: ${r.out.trim().split('\n').pop()}${link ? ` (approve: ${link})` : ''}`);
  }
  for (let i = 0; i < 60; i++) { await new Promise(res => setTimeout(res, 1000)); ensureTunnel(host, b.port); if (await alive(b)) return b; }
  throw new Error(`Hermes on ${host.name} did not come up (see ~/.hermes/gibbous-serve.log there)`);
}

// Quick reachability check for the Settings "Test" button.
// Picking a tailnet machine: find a login that works without a prompt, preferring one with Hermes installed and a
// personal account over root. Candidates: your first name (macOS full name), your Mac and Tailscale user names,
// then the usual server accounts. Tried in parallel; null when none gets in.
export async function findLogin(dns: string, extra: string[] = []): Promise<{ ssh: string; hermes: boolean } | null> {
  if (!/^[\w.-]+$/.test(dns)) return null;
  const users = [...new Set([...extra, 'ubuntu', 'admin', 'debian', 'ec2-user', 'pi', 'root'].map(u => u.toLowerCase()).filter(u => /^[a-z_][\w.-]{0,31}$/.test(u)))];
  const tries = await Promise.all(users.map(async u => {
    // Capped: a Tailscale SSH machine in check mode waits for a browser approval nobody gives here.
    const r = await new Promise<{ code: number; out: string }>(resolve => {
      const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', `${u}@${dns}`, 'bash -lc \'echo __in__; command -v hermes || ls "$HOME/.local/bin/hermes"\''], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d));
      const kill = setTimeout(() => p.kill(), 15_000);
      p.on('close', code => { clearTimeout(kill); resolve({ code: code ?? 1, out }); });
    });
    return { ssh: `${u}@${dns}`, in: r.out.includes('__in__'), hermes: r.code === 0 && /hermes/.test(r.out.split('__in__')[1] ?? '') };
  }));
  const hit = tries.find(t => t.hermes) ?? tries.find(t => t.in);
  return hit ? { ssh: hit.ssh, hermes: hit.hermes } : null;
}

export async function testHost(host: Host) {
  const r = await ssh(host, ['bash', '-l', '-c', 'command -v hermes || ls "$HOME/.local/bin/hermes"; hermes --version 2>/dev/null | head -1']);
  return { ok: r.code === 0 && /hermes/i.test(r.out), output: r.out.trim().slice(-500) };
}
