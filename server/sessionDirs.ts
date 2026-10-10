// Where each Hermes session ran, for the import picker's "group by project folder". session.list rows don't carry
// the cwd, so it's read straight from state.db (read-only). Worktree folders fold into their main repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStateDb } from './subagents.ts';

export interface Folder { root: string; repo: boolean; exists: boolean }
export interface SessionDirs { home: string; sessions: Record<string, { cwd?: string; at?: number }>; folders: Record<string, Folder> }

// The repository a folder belongs to: the nearest .git upwards (stopping below the home folder, which may hold a
// dotfiles repo); a linked worktree's `.git` file points into `<main>/.git/worktrees/<name>`, so it maps to <main>.
export function folderOf(dir: string, home = os.homedir()): Folder {
  if (!fs.existsSync(dir)) {
    const sibling = /^(.*)(?:-worktrees|\/\.worktrees)\/[^/]+$/.exec(dir)?.[1]; // a removed `<repo>-worktrees/<name>` or `<repo>/.worktrees/<name>` checkout
    return sibling && fs.existsSync(sibling) ? folderOf(sibling, home) : { root: dir, repo: false, exists: false };
  }
  for (let d = dir; d !== home && d !== path.dirname(d); d = path.dirname(d)) {
    const g = path.join(d, '.git');
    let st: fs.Stats; try { st = fs.statSync(g); } catch { continue; }
    if (st.isFile()) {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'))?.[1]?.trim();
      const main = m && /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(path.resolve(d, m))?.[1];
      return { root: main && fs.existsSync(main) ? main : d, repo: true, exists: true };
    }
    return { root: d, repo: true, exists: true };
  }
  return { root: dir, repo: false, exists: true };
}

export function sessionDirs(profile?: string): SessionDirs {
  const home = os.homedir(), out: SessionDirs = { home, sessions: {}, folders: {} };
  const db = openStateDb(profile);
  if (!db) return out;
  const rows = db.prepare(`SELECT id, cwd, git_repo_root AS root, COALESCE(last_activity_at, ended_at, started_at) AS at FROM sessions`).all() as { id: string; cwd: string | null; root: string | null; at: number | null }[];
  for (const r of rows) {
    const cwd = r.cwd?.trim() || undefined;
    out.sessions[r.id] = { cwd, at: r.at ? Math.round(r.at * 1000) : undefined };
    if (cwd && !out.folders[cwd]) {
      const f = folderOf(cwd, home);
      // A deleted worktree can still be placed through the repo root Hermes recorded.
      out.folders[cwd] = !f.exists && r.root && fs.existsSync(r.root) ? { root: r.root, repo: true, exists: true } : f;
    }
  }
  return out;
}
