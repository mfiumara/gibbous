// Which project an imported session belongs to: where it ran (Hermes' state.db cwd / git_repo_root), folded to its
// repository (a Paseo or Gibbous worktree → the main checkout), matched against the projects' folders.
import fs from 'node:fs';
import path from 'node:path';
import { openStateDb } from './subagents.ts';
import { folderOf } from './sessionDirs.ts';
import type { Project } from './store.ts';

// Symlinked folders (macOS /var → /private/var) compare by their real path.
// A folder that's gone resolves through its nearest existing parent.
const real = (p: string): string => { const a = path.resolve(p); try { return fs.realpathSync(a); } catch { const up = path.dirname(a); return up === a ? a : path.join(real(up), path.basename(a)); } };
const inside = (dir: string, root: string) => { const r = path.relative(root, dir); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Deepest project containing any of the candidate folders (a repo, or the folder itself).
export function projectForDirs(dirs: (string | null | undefined)[], projects: Project[], home: string): Project | undefined {
  const roots = dirs.filter((d): d is string => !!d?.trim()).flatMap(d => { const f = folderOf(d, home); return f.exists ? [f.root, d] : [d]; });
  return projects
    .filter(p => p.path && real(p.path) !== real(home) && roots.some(r => inside(real(r), real(p.path))))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function projectForSession(sessionId: string, projects: Project[], home: string, profile?: string): Project | undefined {
  try {
    const row = openStateDb(profile)?.prepare('SELECT cwd, git_repo_root AS root FROM sessions WHERE id = ?').get(sessionId) as { cwd?: string | null; root?: string | null } | undefined;
    return row ? projectForDirs([row.cwd, row.root], projects, home) : undefined;
  } catch { return undefined; }
}
