// Pictures a tool reported (a browser screenshot, a rendered plot), copied the moment the tool finishes. Some tools
// reuse one file for every screenshot (the browser harness writes …/tmp/p-<id>/shot.png each time), so a step that
// showed "the file at that path" later showed whatever was taken last, even in another chat. Each step keeps its own copy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const IMAGE = /(?:^|[\s"'(\\n])((?:\/)[^\s"')\\]+\.(?:png|jpe?g|webp|gif))/gi;
const MAX_FILES = 2000, MAX_BYTES = 25 << 20;

/** Absolute image paths mentioned anywhere in a tool result. */
export function imagePaths(result: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown, depth = 0) => {
    if (depth > 6) return;
    if (typeof v === 'string') { for (const m of v.matchAll(IMAGE)) found.add(m[1]); }
    else if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach(x => walk(x, depth + 1));
  };
  walk(result);
  return [...found].slice(0, 6);
}

export const shotName = (toolId: string, file: string) =>
  crypto.createHash('sha1').update(`${toolId}\0${path.resolve(file)}`).digest('hex') + path.extname(file).toLowerCase();

export class ToolShots {
  private dir: string;
  constructor(dir: string) { this.dir = dir; }
  /** Copy every image a finished tool mentions; cheap, synchronous, and before the agent's next step can overwrite it. */
  keep(toolId: string, result: unknown) {
    if (!toolId) return;
    for (const f of imagePaths(result)) {
      try {
        const st = fs.statSync(f);
        if (!st.isFile() || st.size > MAX_BYTES) continue;
        fs.mkdirSync(this.dir, { recursive: true });
        fs.copyFileSync(f, path.join(this.dir, shotName(toolId, f)));
      } catch { /* gone already, or unreadable */ }
    }
  }
  /** The copy for this step, if one was kept. */
  find(toolId: string, file: string): string | undefined {
    const p = path.join(this.dir, shotName(toolId, file));
    return fs.existsSync(p) ? p : undefined;
  }
  /** Oldest copies go once there are more than MAX_FILES. */
  prune() {
    try {
      const fs_ = fs.readdirSync(this.dir).map(n => { const p = path.join(this.dir, n); return { p, t: fs.statSync(p).mtimeMs }; });
      if (fs_.length <= MAX_FILES) return;
      fs_.sort((a, b) => a.t - b.t).slice(0, fs_.length - MAX_FILES).forEach(x => fs.rmSync(x.p, { force: true }));
    } catch { /* no folder yet */ }
  }
}
