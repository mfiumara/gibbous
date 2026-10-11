// Everything that differs between macOS, Linux (incl. WSL) and Windows, in one place. Each helper takes an optional
// `Sys` so tests can run the Windows/Linux branches on any machine; callers pass nothing and get this machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface Sys {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists(p: string): boolean;
  read(p: string): string | undefined;
}
export const sys = (): Sys => ({
  platform: process.platform, env: process.env, home: os.homedir(),
  exists: p => fs.existsSync(p),
  read: p => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
});

export const pathOf = (s: Sys) => (s.platform === 'win32' ? path.win32 : path.posix);
const isWin = (s: Sys) => s.platform === 'win32';
const envGet = (s: Sys, k: string) => (s.env[k] ?? (isWin(s) ? Object.entries(s.env).find(([n]) => n.toUpperCase() === k)?.[1] : undefined))?.trim() || undefined;
export const isWsl = (s: Sys = sys()) => s.platform === 'linux' && !!(s.env.WSL_DISTRO_NAME || s.env.WSL_INTEROP);

// `~` and `~/x` (or `~\x`) → the home folder.
export function expandHome(p: string, s: Sys = sys()) {
  return p.replace(/^~(?=$|[\\/])/, s.home);
}

// `child` is `parent` or below it. Windows compares case-insensitively (path.win32.relative does).
export function isInside(child: string, parent: string, s: Sys = sys()) {
  const P = pathOf(s), rel = P.relative(P.resolve(parent), P.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel));
}

export function gibbousHome(s: Sys = sys()) {
  const o = envGet(s, 'GIBBOUS_HOME');
  return o ? pathOf(s).resolve(expandHome(o, s)) : pathOf(s).join(s.home, '.gibbous');
}

// Hermes' own default (hermes_constants._get_platform_default_hermes_home): ~/.hermes, or %LOCALAPPDATA%\hermes.
export function nativeHermesHome(s: Sys = sys()) {
  const P = pathOf(s);
  if (isWin(s)) return P.join(envGet(s, 'LOCALAPPDATA') ?? P.join(s.home, 'AppData', 'Local'), 'hermes');
  return P.join(s.home, '.hermes');
}
export function hermesHome(s: Sys = sys()) {
  const o = envGet(s, 'HERMES_HOME');
  return o ? expandHome(o, s) : nativeHermesHome(s);
}

// `which`: the first executable called `name` on PATH (Windows tries PATHEXT: hermes → hermes.exe / hermes.cmd).
export function which(name: string, s: Sys = sys()): string | undefined {
  const P = pathOf(s), dirs = (envGet(s, 'PATH') ?? '').split(P.delimiter).filter(Boolean);
  const exts = isWin(s) && !P.extname(name) ? (envGet(s, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase()) : [''];
  for (const d of dirs) for (const e of exts) { const f = P.join(d.replace(/^"(.*)"$/, '$1'), name + e); if (s.exists(f)) return f; }
  return undefined;
}

// Where the official installers put the `hermes` command (scripts/install.sh, install.ps1 in hermes-agent): the
// launcher in ~/.local/bin (or %LOCALAPPDATA%\hermes\bin), plus the checkout's own launcher dir, which exists even
// when the PATH change hasn't reached this process yet (a server started before the install never sees it).
export function knownHermesBins(s: Sys = sys()): string[] {
  const P = pathOf(s), home = hermesHome(s), checkout = P.join(home, 'hermes-agent', '.hermes', 'bin');
  return isWin(s)
    ? [P.join(home, 'bin', 'hermes.exe'), P.join(home, 'bin', 'hermes.cmd'), P.join(checkout, 'hermes.exe'), P.join(checkout, 'hermes.cmd'), P.join(s.home, '.local', 'bin', 'hermes.exe')]
    : [P.join(s.home, '.local', 'bin', 'hermes'), P.join(checkout, 'hermes'), P.join(home, 'bin', 'hermes'), '/usr/local/bin/hermes'];
}

// The installed `hermes` CLI, or undefined: HERMES_BIN (only that, when set) → PATH → the installers' locations.
export function findHermes(s: Sys = sys()): string | undefined {
  const o = envGet(s, 'HERMES_BIN');
  if (o) { const f = expandHome(o, s); return s.exists(f) ? f : undefined; }
  return which('hermes', s) ?? knownHermesBins(s).find(f => s.exists(f));
}

// The `hermes` CLI to run: the one found, else the default install location (spawning it then fails with ENOENT).
export function hermesBin(s: Sys = sys()): string {
  const o = envGet(s, 'HERMES_BIN');
  return findHermes(s) ?? (o ? expandHome(o, s) : knownHermesBins(s)[0]);
}

// How to start `cmd args…` with child_process.spawn. Windows can't spawn a .cmd/.bat directly (EINVAL since
// Node 18.20): run it through cmd.exe with the line quoted by hand.
export interface Command { cmd: string; args: string[]; verbatim?: boolean; cwd?: string }
const winQuote = (a: string) => (/[\s"&|<>^()]/.test(a) || !a ? `"${a.replace(/"/g, '""')}"` : a);
export function commandFor(cmd: string, args: string[], s: Sys = sys()): Command {
  if (isWin(s) && /\.(cmd|bat)$/i.test(cmd)) return { cmd: envGet(s, 'COMSPEC') ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${[cmd, ...args].map(winQuote).join(' ')}"`], verbatim: true };
  return { cmd, args };
}

// Show a file in the system file manager. Linux has no portable "select this file", so its folder opens.
export function revealCommand(file: string, s: Sys = sys()): Command {
  if (s.platform === 'darwin') return { cmd: 'open', args: ['-R', file] };
  if (isWin(s)) return { cmd: 'explorer.exe', args: [`/select,"${file}"`], verbatim: true };
  if (isWsl(s)) return { cmd: 'explorer.exe', args: ['.'], cwd: pathOf(s).dirname(file) }; // WSL interop: the folder opens in Windows Explorer
  return { cmd: 'xdg-open', args: [pathOf(s).dirname(file)] };
}

// Fire-and-forget launch (file manager, browser): resolves once it started, rejects when the program is missing.
// Never throws asynchronously: an unhandled 'error' on a ChildProcess would take the server down.
export function launch(c: Command): Promise<void> {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: !!c.verbatim, cwd: c.cwd }); }
    catch (e) { reject(e); return; }
    p.once('error', reject);
    p.once('spawn', () => { p.unref(); resolve(); });
  });
}

// The interactive shell for terminal tabs and project scripts. $SHELL on macOS/Linux; on Windows $SHELL is often a
// Git Bash/MSYS path node-pty can't start, so PowerShell (7 if installed) unless GIBBOUS_SHELL says otherwise.
export function defaultShell(s: Sys = sys()): string {
  const o = envGet(s, 'GIBBOUS_SHELL');
  if (o) return o;
  if (isWin(s)) return which('pwsh.exe', s) ?? 'powershell.exe';
  const sh = envGet(s, 'SHELL');
  if (sh && s.exists(sh)) return sh;
  return ['/bin/zsh', '/bin/bash', '/bin/sh'].filter(f => s.platform === 'darwin' || f !== '/bin/zsh').find(f => s.exists(f)) ?? '/bin/sh';
}

// Arguments for a login shell, or one command run through it.
export function shellArgs(shell: string, cmd?: string): string[] {
  const name = shell.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  if (name === 'powershell' || name === 'pwsh') return cmd ? ['-NoLogo', '-NoProfile', '-Command', cmd] : ['-NoLogo'];
  if (name === 'cmd') return cmd ? ['/d', '/s', '/c', cmd] : [];
  return cmd ? ['-lc', cmd] : ['-l'];
}

// ~/Downloads, or the XDG download folder Linux desktops configure (user-dirs.dirs).
export function downloadsDir(s: Sys = sys()): string {
  const P = pathOf(s);
  if (s.platform === 'linux') {
    const cfg = envGet(s, 'XDG_CONFIG_HOME') ?? P.join(s.home, '.config');
    const m = /^XDG_DOWNLOAD_DIR="?([^"\n]+)"?/m.exec(s.read(P.join(cfg, 'user-dirs.dirs')) ?? '');
    const d = m?.[1].replace(/^\$HOME(?=$|\/)/, s.home);
    if (d && P.isAbsolute(d) && d !== s.home) return d;
  }
  return P.join(s.home, 'Downloads');
}

// What the server's service is called here and how to restart it (shown in Settings → Maintenance).
export function serviceInfo(s: Sys = sys()): { platform: NodeJS.Platform; wsl: boolean; machine: string; restart: string } {
  const wsl = isWsl(s);
  if (s.platform === 'darwin') return { platform: s.platform, wsl, machine: 'Mac', restart: 'launchctl kickstart -k gui/$(id -u)/dev.gibbous.server' };
  if (isWin(s)) return { platform: s.platform, wsl, machine: 'PC', restart: 'Stop-ScheduledTask -TaskName Gibbous; Start-ScheduledTask -TaskName Gibbous' };
  return { platform: s.platform, wsl, machine: 'computer', restart: 'systemctl --user restart gibbous' };
}

// A file name that is fine on every OS we run on (Windows refuses <>:"/\|?* and a trailing dot or space).
export function badFolderName(name: string, s: Sys = sys()) {
  if (!name || name === '.' || name === '..' || name.length > 255 || /[/\\\0]/.test(name)) return true;
  return isWin(s) && (/[<>:"|?*\x01-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name));
}

// A file the agent handed over (MEDIA:) may be served/saved/revealed when it lives in the home folder outside hidden
// folders (~/.ssh…), or anywhere in Hermes' home (attachments). On Windows AppData is the hidden-folder equivalent.
export function mediaAllowed(file: string, s: Sys = sys(), hermes = hermesHome(s)) {
  const P = pathOf(s), p = P.resolve(file);
  if (isInside(p, hermes, s)) return true;
  if (!isInside(p, s.home, s) || p === P.resolve(s.home)) return false;
  const segs = P.relative(s.home, p).split(P.sep);
  if (segs.some(seg => seg.startsWith('.') && seg !== '.hermes')) return false;
  return !(isWin(s) && segs[0].toLowerCase() === 'appdata');
}

// Signals worth saving state on. Windows only delivers SIGINT/SIGBREAK (Ctrl+C/Ctrl+Break) and SIGHUP (console closed).
export function exitSignals(s: Sys = sys()): NodeJS.Signals[] {
  return isWin(s) ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGTERM', 'SIGINT', 'SIGHUP'];
}
