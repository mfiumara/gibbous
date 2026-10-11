// First-run setup: is Hermes installed, install it with the official installer (live log), and is a model set up.
// Hermes stays the official, system-installed one: Gibbous only runs Nous Research's installer script for this OS.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { sys, findHermes, commandFor, isWsl, type Sys, type Command } from './platform.ts';

export const INSTALL_SH = 'https://hermes-agent.nousresearch.com/install.sh';
export const INSTALL_PS1 = 'https://hermes-agent.nousresearch.com/install.ps1';
export const INSTALL_DOCS = 'https://hermes-agent.nousresearch.com/docs/getting-started/installation';
export const MAX_LOG_LINES = 500;

export type SetupOs = 'macos' | 'linux' | 'wsl' | 'windows';
export const setupOs = (s: Sys = sys()): SetupOs => s.platform === 'win32' ? 'windows' : s.platform === 'darwin' ? 'macos' : isWsl(s) ? 'wsl' : 'linux';

// What a person pastes into a terminal to install Hermes themselves (the docs' one-liner; it then runs `hermes setup`).
export function manualInstallCommand(s: Sys = sys()): string {
  return s.platform === 'win32' ? `iex (irm ${INSTALL_PS1})` : `curl -fsSL ${INSTALL_SH} | bash`;
}

// What Gibbous runs for "Install Hermes": the same installer, non-interactive (it skips `hermes setup` and the
// gateway service, which need a terminal; model setup happens in the next onboarding step instead).
// GIBBOUS_HERMES_INSTALLER (testing only) replaces it with any shell command, so tests never run the real installer.
export function installerCommand(s: Sys = sys()): Command {
  const override = s.env.GIBBOUS_HERMES_INSTALLER?.trim();
  if (s.platform === 'win32') {
    if (override) return { cmd: s.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${override}"`], verbatim: true };
    // `iex (irm …)` can't pass switches; a scriptblock can.
    return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& ([scriptblock]::Create((irm ${INSTALL_PS1}))) -NonInteractive`] };
  }
  if (override) return { cmd: '/bin/sh', args: ['-c', override] };
  // pipefail: a failed download must fail the install, not pipe nothing into bash and "succeed".
  return { cmd: 'bash', args: ['-c', `set -o pipefail; curl -fsSL ${INSTALL_SH} | bash -s -- --non-interactive`] };
}

// ANSI colour/cursor codes and OSC titles out; one entry per line. A line ended by a lone \r is a progress redraw
// (`transient`): the next line replaces it, so a download bar is one updating line, not hundreds.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;
export class LineSplitter {
  private partial = '';
  private onLine: (line: string, transient: boolean) => void;
  constructor(onLine: (line: string, transient: boolean) => void) { this.onLine = onLine; }
  push(chunk: string) {
    let s = this.partial + chunk, hold = '';
    if (s.endsWith('\r')) { s = s.slice(0, -1); hold = '\r'; } // maybe the first half of \r\n: decide with the next chunk
    const parts = s.split(/(\r\n|\n|\r)/);
    this.partial = (parts.pop() ?? '') + hold;
    for (let i = 0; i < parts.length; i += 2) this.emit(parts[i], parts[i + 1] === '\r');
  }
  flush() { if (this.partial) this.emit(this.partial.replace(/\r$/, ''), false); this.partial = ''; }
  private emit(raw: string, transient: boolean) {
    const line = raw.replace(ANSI, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
    if (line.trim()) this.onLine(line.length > 2000 ? line.slice(0, 2000) + '…' : line, transient);
  }
}

export interface InstallResult { ok: boolean; error?: string; at: number }

// One install at a time. Emits 'line' (line, replace: the previous line was a progress redraw this one replaces) and
// 'done' (InstallResult) once.
export class Installer extends EventEmitter {
  lines: string[] = [];
  running = false;
  result?: InstallResult;
  private child?: ChildProcess;
  private cancelled = false;
  private transient = false;

  // false when an install is already running.
  start(c: Command, env: NodeJS.ProcessEnv = process.env): boolean {
    if (this.running) return false;
    this.running = true; this.cancelled = false; this.result = undefined; this.lines = []; this.transient = false;
    const out = new LineSplitter((l, t) => this.line(l, t));
    this.line(`$ ${[c.cmd, ...c.args].join(' ')}`);
    let child: ChildProcess;
    try {
      // Detached on POSIX: its own process group, so Cancel stops curl, bash and everything they started.
      child = spawn(c.cmd, c.args, { env: { ...env, NO_COLOR: '1', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: !!c.verbatim, detached: process.platform !== 'win32' });
    } catch (e: any) { this.finish({ ok: false, error: `Couldn't start ${c.cmd}: ${e?.message ?? e}` }); return true; }
    this.child = child;
    child.stdout!.setEncoding('utf8').on('data', d => out.push(d));
    child.stderr!.setEncoding('utf8').on('data', d => out.push(d));
    child.once('error', e => { out.flush(); this.finish({ ok: false, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${c.cmd} isn't available on this computer, so the installer can't run.` : `Couldn't start ${c.cmd}: ${e.message}` }); });
    child.once('close', (code, signal) => {
      out.flush();
      if (this.cancelled) return this.finish({ ok: false, error: 'Install cancelled.' });
      if (code === 0) return this.finish({ ok: true });
      // The installer prints its reason on a ✗ / [X] line; fall back to the last thing it said.
      const why = [...this.lines].reverse().find(l => /^\s*(✗|\[X\])/.test(l))?.replace(/^\s*(✗|\[X\])\s*/, '') ?? this.lines.at(-1);
      this.finish({ ok: false, error: `The installer stopped (${signal ?? `exit ${code}`})${why && !why.startsWith('$ ') ? `: ${why}` : '.'}` });
    });
    return true;
  }

  cancel() {
    const c = this.child;
    if (!this.running || !c?.pid) return false;
    this.cancelled = true;
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], () => {});
    else {
      try { process.kill(-c.pid, 'SIGTERM'); } catch { c.kill('SIGTERM'); }
      // A shell can lose a SIGTERM that lands mid-fork, leaving a background child behind: finish the group off.
      setTimeout(() => { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* group already gone */ } }, 1000).unref();
    }
    return true;
  }

  private line(l: string, transient = false) {
    const replace = this.transient && this.lines.length > 0;
    this.transient = transient;
    if (replace) this.lines[this.lines.length - 1] = l; else this.lines.push(l);
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
    this.emit('line', l, replace);
  }
  private finish(r: Omit<InstallResult, 'at'>) {
    if (!this.running) return;
    this.running = false; this.child = undefined;
    this.result = { ...r, at: Date.now() };
    if (r.error) this.line(r.ok ? r.error : `✗ ${r.error}`);
    this.emit('done', this.result);
  }
}

export interface HermesInstall { installed: boolean; bin?: string }
export const detectHermes = (s: Sys = sys()): HermesInstall => { const bin = findHermes(s); return { installed: !!bin, bin }; };

// `hermes --version` → "0.12.0" (or the raw first line when it has no version number); undefined when it can't run.
export function parseVersion(out: string): string | undefined {
  const first = out.split(/\r?\n/).find(l => l.trim())?.trim();
  if (!first) return undefined;
  return /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)\b/.exec(first)?.[1] ?? first.slice(0, 80);
}
export function hermesVersion(bin: string): Promise<string | undefined> {
  const c = commandFor(bin, ['--version']);
  return new Promise(res => execFile(c.cmd, c.args, { timeout: 20_000, windowsHide: true, windowsVerbatimArguments: !!c.verbatim }, (e, stdout) => res(e ? undefined : parseVersion(String(stdout)))));
}

// Hermes' readiness answers (tui_gateway setup.status / setup.runtime_check) → configured: true/false, or null when
// this Hermes can't say (older backend, check still running): never block the app on an unknown.
export interface ModelState { configured: boolean | null; provider?: string; model?: string; freeTier?: boolean; reason?: string }
export function modelState(status: any, runtime: any): ModelState {
  const r = runtime && typeof runtime === 'object' ? runtime : {};
  if (r.ok === true) return { configured: true, provider: r.provider || undefined, model: r.model || undefined, freeTier: !!r.free_tier_route };
  if (r.ok === false) return { configured: false, provider: r.provider || undefined, reason: r.error || undefined };
  if (status && typeof status.provider_configured === 'boolean') return { configured: status.provider_configured };
  return { configured: null };
}
