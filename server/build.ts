// Which web build the server is serving: the hashed entry script in dist/index.html. Open tabs compare it with
// the script they loaded, so a rebuild shows "reload for the latest" instead of silently running old code.
import fs from 'node:fs';

export const buildIdOf = (html: string): string | null => /<script[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null;

export function readBuildId(indexHtml: string): string | null {
  try { return buildIdOf(fs.readFileSync(indexHtml, 'utf8')); } catch { return null; }
}

// Polls (rather than fs.watch) because vite replaces index.html, which drops inode watchers on macOS.
export function watchBuild(indexHtml: string, onChange: (id: string | null) => void, intervalMs = 1500) {
  let current = readBuildId(indexHtml);
  fs.watchFile(indexHtml, { interval: intervalMs }, () => {
    const next = readBuildId(indexHtml);
    if (next && next !== current) { current = next; onChange(next); }
  });
  return () => current;
}
