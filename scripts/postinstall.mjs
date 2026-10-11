// node-pty ships its macOS spawn-helper without the executable bit under pnpm; fix it. Plain Node so it runs on
// Windows too (no `find`/`chmod` there, and nothing to fix).
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'win32') {
  const store = path.join(import.meta.dirname, '..', 'node_modules', '.pnpm');
  for (const pkg of fs.existsSync(store) ? fs.readdirSync(store).filter(d => d.startsWith('node-pty@')) : []) {
    const root = path.join(store, pkg, 'node_modules', 'node-pty');
    for (const dir of ['prebuilds', path.join('build', 'Release')]) {
      const base = path.join(root, dir);
      const walk = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (e.name === 'spawn-helper') fs.chmodSync(p, 0o755);
      } };
      walk(base);
    }
  }
}
