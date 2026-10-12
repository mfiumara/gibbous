// iPhone photos arrive as HEIC: models and most browsers can't read it, so Gibbous hands out JPEG instead.
// macOS converts with the built-in `sips`; elsewhere ImageMagick or libheif's heif-convert if installed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const isHeic = (name: string) => /\.(heic|heif)$/i.test(name);

const converters = (src: string, out: string): [string, string[]][] => [
  ...(process.platform === 'darwin' ? [['sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', src, '--out', out]] as [string, string[]]] : []),
  ['magick', [src, '-quality', '85', out]],
  ['heif-convert', ['-q', '85', src, out]],
];

// Converts a HEIC file to JPEG at `out`. Throws when no converter is available or the file isn't a readable HEIC.
export async function heicFileToJpeg(src: string, out: string) {
  let last: unknown;
  for (const [cmd, args] of converters(src, out)) {
    try { await run(cmd, args, { timeout: 30_000 }); if (fs.existsSync(out) && fs.statSync(out).size > 0) return; }
    catch (e) { last = e; }
  }
  throw Object.assign(new Error('HEIC conversion is not available on this machine'), { cause: last });
}

export async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gibbous-heic-'));
  try {
    const src = path.join(dir, 'in.heic'), out = path.join(dir, 'out.jpg');
    fs.writeFileSync(src, bytes);
    await heicFileToJpeg(src, out);
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A JPEG twin of a HEIC file on disk, cached by path + mtime + size so a viewer doesn't reconvert on every load.
export async function cachedJpeg(src: string, cacheDir: string) {
  const st = fs.statSync(src);
  const key = createHash('sha256').update(`${src}\0${st.mtimeMs}\0${st.size}`).digest('hex').slice(0, 24);
  const out = path.join(cacheDir, `${key}.jpg`);
  if (!fs.existsSync(out)) { fs.mkdirSync(cacheDir, { recursive: true }); const tmp = `${out}.${process.pid}.tmp.jpg`; await heicFileToJpeg(src, tmp); fs.renameSync(tmp, out); }
  return out;
}
