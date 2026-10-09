// Workspace terminals. A PTY outlives its browser socket; reattaching replays recent output.
// Shell tabs run a login shell; script tabs run one command and keep their output (and exit code) after it ends.
import pty from 'node-pty';
import type { WebSocket } from 'ws';

interface Term { p?: pty.IPty; buf: string; sockets: Set<WebSocket>; cwd: string; cmd?: string; exit?: number }
const terms = new Map<string, Term>();
const MAX_BUF = 256 * 1024;

const control = (m: object) => '\x00' + JSON.stringify(m);

function start(t: Term) {
  const shell = process.env.SHELL || '/bin/zsh';
  const p = pty.spawn(shell, t.cmd ? ['-lc', t.cmd] : ['-l'], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: t.cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
  });
  t.p = p; t.exit = undefined;
  if (t.cmd) { const banner = `\x1b[2m$ ${t.cmd}\x1b[0m\r\n`; t.buf = (t.buf + banner).slice(-MAX_BUF); for (const s of t.sockets) s.send(banner); }
  p.onData(d => {
    t.buf = (t.buf + d).slice(-MAX_BUF);
    for (const s of t.sockets) s.send(d);
  });
  p.onExit(({ exitCode }) => {
    t.p = undefined; t.exit = exitCode;
    for (const s of t.sockets) s.send(control({ exit: exitCode }));
  });
}

export function attachTerminal(ws: WebSocket, id: string, cwd: string, cmd?: string) {
  let t = terms.get(id);
  if (!t) { t = { buf: '', sockets: new Set(), cwd, cmd }; terms.set(id, t); start(t); }
  const term = t;
  term.sockets.add(ws);
  if (term.buf) ws.send(term.buf);
  if (term.exit != null) ws.send(control({ exit: term.exit }));
  ws.on('message', (raw, isBinary) => {
    const s = raw.toString();
    // Control frames are JSON prefixed with \x00; everything else is keystrokes.
    if (!isBinary && s.startsWith('\x00')) {
      try {
        const m = JSON.parse(s.slice(1));
        if (m.resize && term.p) term.p.resize(Math.max(2, m.resize.cols | 0), Math.max(2, m.resize.rows | 0));
        if (m.kill) term.p?.kill();
        if (m.restart) { term.p?.kill(); term.buf = ''; start(term); }
        if (m.close) { term.p?.kill(); for (const x of term.sockets) x.close(4001, 'closed'); terms.delete(id); }
      } catch {}
      return;
    }
    if (term.p) term.p.write(s);
    else if (!term.cmd) { term.buf = ''; start(term); } // a shell that exited restarts on the next keystroke
  });
  ws.on('close', () => term.sockets.delete(ws));
}
