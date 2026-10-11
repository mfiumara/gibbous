// First-run setup: installer command per OS (injected Sys), log line splitting, the one-at-a-time installer with a fake
// installer (never the real one), detection in the installers' dirs, and Hermes' readiness answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sys } from './platform.ts';
import { findHermes, knownHermesBins } from './platform.ts';
import { installerCommand, manualInstallCommand, setupOs, LineSplitter, Installer, modelState, parseVersion, INSTALL_SH, INSTALL_PS1, MAX_LOG_LINES, type InstallResult } from './setup.ts';

const fake = (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}, files: string[] = []): Sys => ({ platform, env, home, exists: f => files.includes(f), read: () => undefined });
const LAD = 'C:\\Users\\ada\\AppData\\Local';
const win = (env: NodeJS.ProcessEnv = {}, files: string[] = []) => fake('win32', 'C:\\Users\\ada', { LOCALAPPDATA: LAD, ...env }, files);

test('installerCommand: the official installer per OS, non-interactive', () => {
  for (const s of [fake('darwin', '/Users/ada'), fake('linux', '/home/ada'), fake('linux', '/home/ada', { WSL_DISTRO_NAME: 'Ubuntu' })]) {
    const c = installerCommand(s);
    assert.equal(c.cmd, 'bash');
    assert.deepEqual(c.args.slice(0, 1), ['-c']);
    assert.match(c.args[1], /^set -o pipefail; curl -fsSL https:\/\/hermes-agent\.nousresearch\.com\/install\.sh \| bash -s -- --non-interactive$/);
  }
  const w = installerCommand(win());
  assert.equal(w.cmd, 'powershell.exe');
  assert.ok(w.args.includes('-NoProfile') && w.args.includes('Bypass'));
  assert.equal(w.args.at(-1), `& ([scriptblock]::Create((irm ${INSTALL_PS1}))) -NonInteractive`);
});

test('installerCommand: GIBBOUS_HERMES_INSTALLER (tests) replaces it with a shell command', () => {
  assert.deepEqual(installerCommand(fake('linux', '/h', { GIBBOUS_HERMES_INSTALLER: 'sh /tmp/fake.sh' })), { cmd: '/bin/sh', args: ['-c', 'sh /tmp/fake.sh'] });
  const w = installerCommand(win({ GIBBOUS_HERMES_INSTALLER: 'C:\\fake.cmd', COMSPEC: 'C:\\Windows\\cmd.exe' }));
  assert.deepEqual(w, { cmd: 'C:\\Windows\\cmd.exe', args: ['/d', '/s', '/c', '"C:\\fake.cmd"'], verbatim: true });
});

test('manual command and OS names', () => {
  assert.equal(manualInstallCommand(fake('darwin', '/Users/ada')), `curl -fsSL ${INSTALL_SH} | bash`);
  assert.equal(manualInstallCommand(win()), `iex (irm ${INSTALL_PS1})`);
  assert.deepEqual([fake('darwin', '/'), fake('linux', '/'), fake('linux', '/', { WSL_INTEROP: '/run/x' }), win()].map(s => setupOs(s)), ['macos', 'linux', 'wsl', 'windows']);
});

test('findHermes: HERMES_BIN only when set, then PATH, then where the installers put it', () => {
  assert.equal(findHermes(fake('linux', '/home/ada', { HERMES_BIN: '/nope/hermes', PATH: '/usr/bin' }, ['/usr/bin/hermes'])), undefined); // explicit and missing: not installed
  assert.equal(findHermes(fake('linux', '/home/ada', { PATH: '/usr/bin' })), undefined);
  // A server started before the install has the old PATH: the checkout's own launcher still counts.
  assert.equal(findHermes(fake('linux', '/home/ada', { PATH: '/usr/bin' }, ['/home/ada/.hermes/hermes-agent/.hermes/bin/hermes'])), '/home/ada/.hermes/hermes-agent/.hermes/bin/hermes');
  assert.equal(findHermes(fake('darwin', '/Users/ada', { PATH: '/usr/bin', HERMES_HOME: '/opt/h' }, ['/opt/h/hermes-agent/.hermes/bin/hermes'])), '/opt/h/hermes-agent/.hermes/bin/hermes');
  assert.equal(findHermes(win({ Path: 'C:\\Windows' }, [`${LAD}\\hermes\\bin\\hermes.exe`])), `${LAD}\\hermes\\bin\\hermes.exe`);
  assert.equal(knownHermesBins(fake('linux', '/home/ada'))[0], '/home/ada/.local/bin/hermes');
});

test('LineSplitter: \\n, \\r\\n and \\r progress redraws; ANSI stripped; blanks dropped; partials held', () => {
  const out: string[] = [];
  const s = new LineSplitter((l, t) => out.push(t ? `${l} ~` : l));
  s.push('\x1b[0;36m→\x1b[0m Downloading'); s.push(' 10%\r\x1b[2K 50%\r 100%\n\n');
  s.push('✓ done\r'); s.push('\nlast'); // \r\n split across chunks is still one line end
  assert.deepEqual(out, ['→ Downloading 10% ~', ' 50% ~', ' 100%', '✓ done']);
  s.flush();
  assert.equal(out.at(-1), 'last');
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-setup-'));
const done = (i: Installer) => new Promise<InstallResult>(r => i.once('done', r));
const posix = process.platform !== 'win32';

test('Installer streams lines, keeps the last 500, and refuses a second run', { skip: !posix }, async () => {
  const i = new Installer(), seen: string[] = [];
  i.on('line', l => seen.push(l));
  const script = `i=0; while [ $i -lt 520 ]; do echo "line $i"; i=$((i+1)); done; echo oops >&2`;
  assert.equal(i.start({ cmd: '/bin/sh', args: ['-c', script] }), true);
  assert.equal(i.start({ cmd: '/bin/sh', args: ['-c', 'true'] }), false); // one at a time
  const r = await done(i);
  assert.equal(r.ok, true);
  assert.equal(seen.length, 522); // the "$ command" line + 520 + stderr
  assert.equal(i.lines.length, MAX_LOG_LINES);
  assert.equal(i.lines.at(-1), 'oops');
  assert.equal(i.running, false);
});

test('Installer: progress redraws replace the previous line', { skip: !posix }, async () => {
  const i = new Installer(), seen: [string, boolean][] = [];
  i.on('line', (l, r) => seen.push([l, r]));
  i.start({ cmd: '/bin/sh', args: ['-c', `printf 'start\\n10%%\\r50%%\\r100%%\\nend\\n'`] });
  await done(i);
  assert.deepEqual(i.lines.slice(1), ['start', '100%', 'end']);
  assert.deepEqual(seen.slice(1).map(([l, r]) => `${l}${r ? '^' : ''}`), ['start', '10%', '50%^', '100%^', 'end']);
});

test('Installer: a failing installer reports its ✗ reason; a missing program is a clear error', { skip: !posix }, async () => {
  const i = new Installer();
  i.start({ cmd: '/bin/sh', args: ['-c', 'echo "→ cloning"; echo "✗ git is required. Install it." >&2; exit 1'] });
  const r = await done(i);
  assert.equal(r.ok, false);
  assert.match(r.error!, /exit 1.*git is required/);
  const j = new Installer();
  j.start({ cmd: path.join(tmp(), 'no-such-bash'), args: [] });
  const m = await done(j);
  assert.equal(m.ok, false);
  assert.match(m.error!, /isn't available/);
});

test('Installer: cancel stops the whole process group', { skip: !posix }, async () => {
  const dir = tmp(), marker = path.join(dir, 'still-running');
  const i = new Installer();
  i.start({ cmd: '/bin/sh', args: ['-c', `echo start; (sleep 2; touch ${marker}) & sleep 30`] });
  await new Promise(r => i.once('line', l => l === 'start' ? r(null) : i.once('line', r)));
  assert.equal(i.cancel(), true);
  const r = await done(i);
  assert.deepEqual([r.ok, r.error], [false, 'Install cancelled.']);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(fs.existsSync(marker), false, 'the background child of the installer survived the cancel');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('modelState: Hermes readiness → configured true/false/unknown', () => {
  assert.deepEqual(modelState({ provider_configured: true }, { ok: true, provider: 'anthropic', model: 'claude-x', free_tier_route: false }), { configured: true, provider: 'anthropic', model: 'claude-x', freeTier: false });
  assert.deepEqual(modelState({ provider_configured: false }, { ok: false, provider: 'nous', error: 'No usable credentials found for nous.' }), { configured: false, provider: 'nous', reason: 'No usable credentials found for nous.' });
  assert.equal(modelState({ provider_configured: false }, null).configured, false); // runtime check failed to answer
  assert.equal(modelState(null, null).configured, null);
  assert.equal(modelState({}, {}).configured, null); // an older Hermes (or the demo fake) without these RPCs
  assert.equal(modelState(null, { ok: true, free_tier_route: true }).freeTier, true);
});

test('parseVersion', () => {
  assert.equal(parseVersion('Hermes Agent v0.12.3 (2026.10.01)\nPython 3.12'), '0.12.3');
  assert.equal(parseVersion('hermes 1.0.0-rc.2'), '1.0.0-rc.2');
  assert.equal(parseVersion('\n'), undefined);
});
