// Every per-OS branch of platform.ts, run on any machine through an injected Sys.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from './platform.ts';

const fake = (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {}, files: string[] = [], texts: Record<string, string> = {}): P.Sys => ({
  platform, env, home, exists: f => files.includes(f), read: f => texts[f],
});
const WH = 'C:\\Users\\ada', LAD = 'C:\\Users\\ada\\AppData\\Local';
const win = (env: NodeJS.ProcessEnv = {}, files: string[] = []) => fake('win32', WH, { LOCALAPPDATA: LAD, ...env }, files);

test('homes: GIBBOUS_HOME and HERMES_HOME per OS', () => {
  assert.equal(P.gibbousHome(fake('darwin', '/Users/ada')), '/Users/ada/.gibbous');
  assert.equal(P.gibbousHome(fake('linux', '/home/ada', { GIBBOUS_HOME: '~/g' })), '/home/ada/g');
  assert.equal(P.gibbousHome(win()), `${WH}\\.gibbous`);
  assert.equal(P.hermesHome(fake('linux', '/home/ada')), '/home/ada/.hermes');
  assert.equal(P.hermesHome(fake('linux', '/home/ada', { HERMES_HOME: '  ' })), '/home/ada/.hermes'); // blank = unset, like Hermes
  assert.equal(P.hermesHome(win()), `${LAD}\\hermes`);
  assert.equal(P.hermesHome(fake('win32', WH)), `${WH}\\AppData\\Local\\hermes`); // no LOCALAPPDATA
  assert.equal(P.hermesHome(win({ HERMES_HOME: 'D:\\h' })), 'D:\\h');
});

test('hermesBin: env, then PATH, then the installer locations', () => {
  assert.equal(P.hermesBin(fake('darwin', '/Users/ada', { HERMES_BIN: '~/bin/hermes' })), '/Users/ada/bin/hermes');
  assert.equal(P.hermesBin(fake('linux', '/home/ada', { PATH: '/usr/bin:/opt/h/bin' }, ['/opt/h/bin/hermes'])), '/opt/h/bin/hermes');
  assert.equal(P.hermesBin(fake('linux', '/home/ada', { PATH: '/usr/bin' })), '/home/ada/.local/bin/hermes');
  // Windows: PATH with PATHEXT (and the env key's case doesn't matter), then %LOCALAPPDATA%\hermes\bin.
  assert.equal(P.hermesBin(win({ Path: 'C:\\Windows;C:\\tools' }, ['C:\\tools\\hermes.cmd'])), 'C:\\tools\\hermes.cmd');
  assert.equal(P.hermesBin(win({ Path: 'C:\\Windows' }, [`${LAD}\\hermes\\bin\\hermes.exe`])), `${LAD}\\hermes\\bin\\hermes.exe`);
  assert.equal(P.hermesBin(win({}, [`${LAD}\\hermes\\bin\\hermes.cmd`])), `${LAD}\\hermes\\bin\\hermes.cmd`);
  assert.equal(P.hermesBin(win()), `${LAD}\\hermes\\bin\\hermes.exe`); // nothing installed: the expected place, for the error
});

test('commandFor: .cmd launchers go through cmd.exe on Windows', () => {
  assert.deepEqual(P.commandFor('/x/hermes', ['serve']), { cmd: '/x/hermes', args: ['serve'] });
  assert.deepEqual(P.commandFor('C:\\h\\hermes.exe', ['serve'], win()), { cmd: 'C:\\h\\hermes.exe', args: ['serve'] });
  assert.deepEqual(P.commandFor('C:\\Program Files\\h\\hermes.cmd', ['serve', '--port', '9120'], win({ COMSPEC: 'C:\\Windows\\system32\\cmd.exe' })),
    { cmd: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', '""C:\\Program Files\\h\\hermes.cmd" serve --port 9120"'], verbatim: true });
});

test('revealCommand: Finder, Explorer, the folder on Linux', () => {
  assert.deepEqual(P.revealCommand('/Users/ada/a b.png', fake('darwin', '/Users/ada')), { cmd: 'open', args: ['-R', '/Users/ada/a b.png'] });
  assert.deepEqual(P.revealCommand(`${WH}\\a b.png`, win()), { cmd: 'explorer.exe', args: [`/select,"${WH}\\a b.png"`], verbatim: true });
  assert.deepEqual(P.revealCommand('/home/ada/x/a.png', fake('linux', '/home/ada')), { cmd: 'xdg-open', args: ['/home/ada/x'] });
  assert.deepEqual(P.revealCommand('/home/ada/x/a.png', fake('linux', '/home/ada', { WSL_DISTRO_NAME: 'Ubuntu' })), { cmd: 'explorer.exe', args: ['.'], cwd: '/home/ada/x' });
});

test('launch: a missing program rejects instead of crashing the server', async () => {
  await assert.rejects(P.launch({ cmd: 'gibbous-no-such-program', args: [] }), (e: any) => e.code === 'ENOENT');
});

test('defaultShell + shellArgs per OS', () => {
  assert.equal(P.defaultShell(fake('darwin', '/Users/ada', { SHELL: '/opt/homebrew/bin/fish' }, ['/opt/homebrew/bin/fish'])), '/opt/homebrew/bin/fish');
  assert.equal(P.defaultShell(fake('darwin', '/Users/ada', {}, ['/bin/zsh', '/bin/bash'])), '/bin/zsh');
  assert.equal(P.defaultShell(fake('linux', '/home/ada', {}, ['/bin/zsh', '/bin/bash', '/bin/sh'])), '/bin/bash'); // no zsh guess on Linux without $SHELL
  assert.equal(P.defaultShell(fake('linux', '/home/ada', { SHELL: '/bin/zsh' }, ['/bin/sh'])), '/bin/sh');       // $SHELL that isn't installed (containers)
  assert.equal(P.defaultShell(win({ SHELL: '/usr/bin/bash', Path: 'C:\\pwsh' }, ['C:\\pwsh\\pwsh.exe'])), 'C:\\pwsh\\pwsh.exe'); // Git Bash's $SHELL ignored
  assert.equal(P.defaultShell(win()), 'powershell.exe');
  assert.equal(P.defaultShell(win({ GIBBOUS_SHELL: 'cmd.exe' })), 'cmd.exe');
  assert.deepEqual(P.shellArgs('/bin/zsh'), ['-l']);
  assert.deepEqual(P.shellArgs('/bin/bash', 'pnpm i'), ['-lc', 'pnpm i']);
  assert.deepEqual(P.shellArgs('powershell.exe'), ['-NoLogo']);
  assert.deepEqual(P.shellArgs('C:\\pwsh\\pwsh.exe', 'pnpm i'), ['-NoLogo', '-NoProfile', '-Command', 'pnpm i']);
  assert.deepEqual(P.shellArgs('C:\\Windows\\System32\\cmd.exe', 'pnpm i'), ['/d', '/s', '/c', 'pnpm i']);
});

test('downloadsDir: XDG user dirs on Linux, ~/Downloads elsewhere', () => {
  assert.equal(P.downloadsDir(fake('darwin', '/Users/ada')), '/Users/ada/Downloads');
  assert.equal(P.downloadsDir(win()), `${WH}\\Downloads`);
  assert.equal(P.downloadsDir(fake('linux', '/home/ada')), '/home/ada/Downloads');
  assert.equal(P.downloadsDir(fake('linux', '/home/ada', {}, [], { '/home/ada/.config/user-dirs.dirs': '# x\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n' })), '/home/ada/Téléchargements');
  assert.equal(P.downloadsDir(fake('linux', '/home/ada', { XDG_CONFIG_HOME: '/c' }, [], { '/c/user-dirs.dirs': 'XDG_DOWNLOAD_DIR="$HOME"\n' })), '/home/ada/Downloads'); // "disabled" = home
});

test('isInside: separators and Windows case-insensitivity', () => {
  assert.ok(P.isInside('/home/ada/x', '/home/ada', fake('linux', '/')));
  assert.ok(!P.isInside('/home/adam/x', '/home/ada', fake('linux', '/')));
  assert.ok(!P.isInside('/home/ada/../bob', '/home/ada', fake('linux', '/')));
  assert.ok(P.isInside('c:\\users\\ADA\\x', WH, win()));
  assert.ok(!P.isInside('D:\\x', WH, win()));
  assert.ok(!P.isInside('C:\\Users\\adam', WH, win()));
});

test('mediaAllowed: home minus hidden folders; Hermes home always; AppData closed on Windows', () => {
  const mac = fake('darwin', '/Users/ada');
  assert.ok(P.mediaAllowed('/Users/ada/Desktop/a.png', mac));
  assert.ok(P.mediaAllowed('/Users/ada/.hermes/cache/a.png', mac));
  assert.ok(!P.mediaAllowed('/Users/ada/.ssh/id_ed25519', mac));
  assert.ok(!P.mediaAllowed('/etc/passwd', mac));
  const w = win();
  assert.ok(P.mediaAllowed(`${WH}\\Pictures\\a.png`, w));
  assert.ok(P.mediaAllowed(`${LAD}\\hermes\\images\\a.png`, w));
  assert.ok(!P.mediaAllowed(`${LAD}\\Google\\Chrome\\User Data\\Default\\Cookies`, w));
  assert.ok(!P.mediaAllowed(`${WH}\\.ssh\\id_ed25519`, w));
  assert.ok(!P.mediaAllowed('C:\\Windows\\win.ini', w));
});

test('badFolderName: Windows-reserved names and characters', () => {
  assert.ok(!P.badFolderName('notes', fake('linux', '/')));
  assert.ok(P.badFolderName('a/b', fake('linux', '/')));
  assert.ok(!P.badFolderName('a:b', fake('linux', '/')));
  for (const n of ['a:b', 'what?', 'CON', 'nul.txt', 'trailing.', 'x|y']) assert.ok(P.badFolderName(n, win()), n);
  assert.ok(!P.badFolderName('My project', win()));
});

test('serviceInfo + exitSignals per OS', () => {
  assert.match(P.serviceInfo(fake('darwin', '/')).restart, /launchctl kickstart/);
  assert.match(P.serviceInfo(fake('linux', '/')).restart, /systemctl --user restart gibbous/);
  assert.equal(P.serviceInfo(fake('linux', '/', { WSL_DISTRO_NAME: 'Ubuntu' })).wsl, true);
  assert.match(P.serviceInfo(win()).restart, /Start-ScheduledTask -TaskName Gibbous/);
  assert.equal(P.serviceInfo(win()).machine, 'PC');
  assert.ok(!P.exitSignals(win()).includes('SIGTERM'));
  assert.ok(P.exitSignals(fake('linux', '/')).includes('SIGTERM'));
});

test('expandHome: both separators', () => {
  assert.equal(P.expandHome('~/k.p8', fake('linux', '/home/ada')), '/home/ada/k.p8');
  assert.equal(P.expandHome('~\\k.p8', win()), `${WH}\\k.p8`);
  assert.equal(P.expandHome('~bob/x', fake('linux', '/home/ada')), '~bob/x');
});
