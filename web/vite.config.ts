import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev: run the server with GIBBOUS_ALLOWED_HOSTS=localhost:5173 so proxied requests pass the host check.
const target = 'http://127.0.0.1:7878';
const pruneOldAssets = {
  name: 'prune-old-assets',
  closeBundle() {
    const dir = path.resolve(import.meta.dirname, 'dist/assets'), cutoff = Date.now() - 7 * 86_400_000;
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (fs.statSync(path.join(dir, f)).mtimeMs < cutoff) fs.rmSync(path.join(dir, f));
  },
};
export default defineConfig({
  plugins: [react(), tailwind(), pruneOldAssets],
  // ponytail: one ~1 MB chunk (highlight.js + xterm); split with dynamic import() if phone load time matters.
  // Keep earlier builds' hashed chunks so tabs opened before a rebuild can still lazy-load; a week's worth is pruned.
  build: { chunkSizeWarningLimit: 1200, emptyOutDir: false },
  server: {
    proxy: {
      '/api': target, '/login': target,
      '/ws': { target, ws: true }, '/pty': { target, ws: true },
    },
  },
});
