// Which app ran each Claude Code / Codex session on this Mac, so the Sessions screen can tell Codex Desktop, the Codex
// CLI and T3 Code apart. Hermes' `session.foreign.list` hands out opaque handles: sha256("<source>:<real path>") over
// the same files (hermes_cli/foreign_sessions*.py), so the same hash maps a handle back to its log here. Read-only:
// Codex keeps the app in its first line (`session_meta.payload.originator`, plus `source.subagent` for helper runs),
// Claude Code in each entry's `entrypoint` (cli / sdk-cli). Results are cached per file mtime.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { folderOf, type Folder } from './sessionDirs.ts';
import { expandHome } from './platform.ts';

export interface Origin { app: string; sub?: boolean; cwd?: string }
// `folders`: repository roots for the folders these sessions ran in (Paseo worktrees → their main repo), like /api/sessions/dirs.
export interface ForeignOrigins { codex: Record<string, Origin>; claude: Record<string, Origin>; folders: Record<string, Folder>; opencode?: number }

export const handleFor = (source: 'claude' | 'codex', file: string) => crypto.createHash('sha256').update(`${source}:${file}`).digest('hex');

// The tool's own relocation env var wins (blank = unset), like Hermes' _default_root.
function rootOf(env: string, sub: string, ...dflt: string[]) {
  const o = process.env[env]?.trim();
  return o ? path.join(expandHome(o), sub) : path.join(os.homedir(), ...dflt);
}

function walk(dir: string, match: (name: string) => boolean, depth: number, out: string[]) {
  let ents: fs.Dirent[]; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) walk(p, match, depth - 1, out); }
    else if (match(e.name)) out.push(p);
  }
}

// Up to `max` bytes, stopping at the first newline when `line`.
function head(file: string, max: number, line: boolean): string {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks: Buffer[] = []; let total = 0;
    while (total < max) {
      const b = Buffer.alloc(Math.min(65536, max - total)), n = fs.readSync(fd, b, 0, b.length, total);
      if (!n) break;
      const nl = line ? b.subarray(0, n).indexOf(10) : -1;
      chunks.push(b.subarray(0, nl >= 0 ? nl : n)); total += n;
      if (nl >= 0) break;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { fs.closeSync(fd); }
}

export function codexOrigin(firstLine: string): Origin | null {
  try {
    const p = JSON.parse(firstLine)?.payload;
    if (!p) return null;
    const sub = !!p.source && typeof p.source === 'object' && 'subagent' in p.source;
    return { app: String(p.originator ?? ''), ...(sub ? { sub } : {}), ...(typeof p.cwd === 'string' && p.cwd ? { cwd: p.cwd } : {}) };
  } catch { return null; }
}
export function claudeOrigin(text: string): Origin | null {
  const m = /"entrypoint":"([^"]+)"/.exec(text), cwd = /"cwd":"((?:[^"\\]|\\.)+)"/.exec(text)?.[1];
  return m ? { app: m[1], ...(cwd ? { cwd: JSON.parse(`"${cwd}"`) as string } : {}) } : null;
}

const cache = new Map<string, { mtime: number; o: Origin | null }>();
function originOf(file: string, read: (f: string) => Origin | null): Origin | null {
  let st: fs.Stats; try { st = fs.statSync(file); } catch { return null; }
  const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.o;
  let o: Origin | null = null; try { o = read(file); } catch { /* unreadable: no origin */ }
  cache.set(file, { mtime: st.mtimeMs, o });
  return o;
}

function collect(source: 'claude' | 'codex', root: string, files: string[], read: (f: string) => Origin | null): Record<string, Origin> {
  const out: Record<string, Origin> = {};
  let real: string; try { real = fs.realpathSync(root); } catch { return out; }
  for (const f of files) {
    let r: string; try { r = fs.realpathSync(f); } catch { continue; }
    if (!r.startsWith(real + path.sep)) continue; // Hermes skips symlinks that escape the store too
    const o = originOf(r, read);
    if (o) out[handleFor(source, r)] = o;
  }
  return out;
}

// OpenCode keeps its own sessions; Hermes can't import them, the Sessions screen only says they exist.
function opencodeCount(): number | undefined {
  const data = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  const file = path.join(data, 'opencode', 'opencode.db');
  if (!fs.existsSync(file)) return undefined;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return Number((db.prepare('SELECT COUNT(*) AS n FROM session WHERE parent_id IS NULL').get() as { n: number }).n); } finally { db.close(); }
  } catch { return undefined; }
}

export function foreignOrigins(): ForeignOrigins {
  const codexRoot = rootOf('CODEX_HOME', 'sessions', '.codex', 'sessions'), claudeRoot = rootOf('CLAUDE_CONFIG_DIR', 'projects', '.claude', 'projects');
  const cx: string[] = [], cl: string[] = [];
  walk(codexRoot, n => n.startsWith('rollout-') && n.endsWith('.jsonl'), 8, cx);
  walk(claudeRoot, n => n.endsWith('.jsonl'), 1, cl); // <project>/<session>.jsonl only
  const codex = collect('codex', codexRoot, cx, f => codexOrigin(head(f, 1 << 20, true)));
  const claude = collect('claude', claudeRoot, cl.filter(f => path.dirname(path.dirname(f)) === claudeRoot), f => claudeOrigin(head(f, 256 << 10, false)));
  const folders: Record<string, Folder> = {}, home = os.homedir();
  for (const o of [...Object.values(codex), ...Object.values(claude)]) if (o.cwd && !folders[o.cwd]) folders[o.cwd] = folderOf(o.cwd, home);
  // The client only needs the app; cwd travels with Hermes' own rows.
  const strip = (r: Record<string, Origin>) => Object.fromEntries(Object.entries(r).map(([k, { cwd: _, ...o }]) => [k, o]));
  return { codex: strip(codex), claude: strip(claude), folders, opencode: opencodeCount() };
}
