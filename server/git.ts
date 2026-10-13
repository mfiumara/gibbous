// Thin wrappers over the git / gh CLIs.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './platform.ts';

export function run(cmd: string, args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // gh talks to the network: a stalled request must not hang a caller forever (the PR poll waits on it).
    const p = execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: cmd === 'gh' ? 60_000 : 0, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } },
      (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout));
    if (input != null) { p.stdin?.end(input); } else p.stdin?.end();
  });
}
export const git = (cwd: string, ...args: string[]) => run('git', args, cwd);

export async function isRepo(dir: string) {
  try { return (await git(dir, 'rev-parse', '--is-inside-work-tree')).trim() === 'true'; } catch { return false; }
}
// symbolic-ref also works before the first commit (rev-parse HEAD doesn't); detached HEAD falls back to rev-parse.
export async function currentBranch(dir: string) {
  return (await git(dir, 'symbolic-ref', '--short', '-q', 'HEAD').catch(() => '')).trim() || (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
}
// A repository with no commits has no HEAD to diff against: use git's empty tree, so every file reads as added.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const hasCommits = (dir: string) => git(dir, 'rev-parse', '-q', '--verify', 'HEAD').then(() => true, () => false);
const headRef = async (dir: string) => (await hasCommits(dir)) ? 'HEAD' : EMPTY_TREE;
export async function branches(dir: string) {
  return (await git(dir, 'branch', '--format=%(refname:short)')).split('\n').filter(Boolean);
}

// Lines of a text file; a trailing newline ends the last line rather than starting an empty one.
export const fileLines = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'thread';

export async function addWorktree(repo: string, root: string, name: string, base: string) {
  if (!(await hasCommits(repo))) throw new Error(`${path.basename(repo)} has no commits yet. Make a first commit, or start the thread without a worktree.`);
  const branch = `gibbous/${name}`;
  const dir = path.join(root, path.basename(repo), name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', '-b', branch, dir, base);
  return { path: dir, branch, base };
}

export async function removeWorktree(repo: string, wt: { path: string; branch: string }, deleteBranch: boolean) {
  await git(repo, 'worktree', 'remove', '--force', wt.path).catch(() => fs.rmSync(wt.path, { recursive: true, force: true }));
  await git(repo, 'worktree', 'prune').catch(() => {});
  if (deleteBranch) await git(repo, 'branch', '-D', wt.branch).catch(() => {});
}

export interface FileChange { path: string; status: string; staged: boolean; added: number; removed: number }

// Changed files: working tree vs HEAD, or (when base given) everything since merge-base with base, incl. uncommitted.
export async function changes(dir: string, base?: string): Promise<FileChange[]> {
  const ref = base ? (await git(dir, 'merge-base', base, 'HEAD')).trim() : await headRef(dir);
  const [numstat, status] = await Promise.all([
    git(dir, 'diff', '--numstat', ref),
    git(dir, 'status', '--porcelain=v1', '--untracked-files=all'),
  ]);
  const map = new Map<string, FileChange>();
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, r, p] = line.split('\t');
    map.set(p, { path: p, status: 'M', staged: false, added: Number(a) || 0, removed: Number(r) || 0 });
  }
  for (const line of status.split('\n').filter(Boolean)) {
    const x = line[0], y = line[1];
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    const st = x === '?' ? 'A' : (y !== ' ' ? y : x);
    const cur = map.get(p) ?? { path: p, status: st, staged: false, added: 0, removed: 0 };
    cur.status = x === '?' ? '?' : st;
    cur.staged = x !== ' ' && x !== '?';
    if (x === '?' && !cur.added) {
      try { cur.added = fileLines(fs.readFileSync(path.join(dir, p), 'utf8')).length; } catch {}
    }
    map.set(p, cur);
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function fileDiff(dir: string, file: string, base?: string): Promise<string> {
  const ref = base ? (await git(dir, 'merge-base', base, 'HEAD')).trim() : await headRef(dir);
  const tracked = await git(dir, 'ls-files', '--error-unmatch', file).then(() => true, () => false);
  if (!tracked) {
    const lines = fileLines(fs.readFileSync(safeJoin(dir, file), 'utf8'));
    return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(l => '+' + l).join('\n');
  }
  return git(dir, 'diff', ref, '--', file);
}

export async function fullDiff(dir: string, base?: string): Promise<string> {
  const ref = base ? (await git(dir, 'merge-base', base, 'HEAD')).trim() : await headRef(dir);
  const untracked = (await git(dir, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean);
  const extra = await Promise.all(untracked.slice(0, 200).map(f => fileDiff(dir, f).catch(() => '')));
  return [await git(dir, 'diff', ref), ...extra].filter(Boolean).join('\n');
}

export async function revertFile(dir: string, file: string) {
  const tracked = await git(dir, 'ls-files', '--error-unmatch', file).then(() => true, () => false);
  if (tracked) await git(dir, 'checkout', 'HEAD', '--', file);
  else fs.rmSync(safeJoin(dir, file), { force: true });
}

export async function commitAll(dir: string, message: string) {
  await git(dir, 'add', '-A');
  const dirty = (await git(dir, 'status', '--porcelain')).trim();
  if (!dirty) return false;
  await run('git', ['commit', '-F', '-'], dir, message);
  return true;
}

// Merge a worktree branch into the project checkout. The checkout must be on `base` and clean of conflicts.
export async function mergeBranch(repo: string, branch: string, base: string, message: string) {
  const cur = await currentBranch(repo);
  if (cur !== base) throw new Error(`project checkout is on ${cur}, expected ${base}`);
  // merge --abort can't reliably restore pre-existing uncommitted work, so never merge into a dirty checkout.
  if ((await git(repo, 'status', '--porcelain', '--untracked-files=no')).trim()) throw new Error('project checkout has uncommitted changes; commit or stash them, then merge');
  try {
    await git(repo, 'merge', '--no-ff', '-m', message, branch);
  } catch (e) {
    await git(repo, 'merge', '--abort').catch(() => {});
    throw e;
  }
  return (await git(repo, 'rev-parse', 'HEAD')).trim();
}

export async function pushAndPr(dir: string, branch: string, base: string, title: string, body: string) {
  await git(dir, 'push', '-u', 'origin', branch);
  const out = await run('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body-file', '-'], dir, body);
  return out.trim().split('\n').pop() ?? '';
}

export async function listFiles(dir: string): Promise<string[]> {
  if (await isRepo(dir)) {
    return (await git(dir, 'ls-files', '--cached', '--others', '--exclude-standard')).split('\n').filter(Boolean);
  }
  // Not a repo (often the home folder): breadth-first, skipping hidden/vendored/system folders and anything unreadable.
  const out: string[] = [], queue = [dir];
  while (queue.length && out.length < 5000) {
    const d = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; } // EPERM (~/.Trash, TCC folders)
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || (d === dir && e.name === 'Library')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) queue.push(p); else if (e.isFile()) out.push(path.relative(dir, p).split(path.sep).join('/')); // `/` like git ls-files, on Windows too
    }
  }
  return out.slice(0, 5000);
}

// Resolve `rel` inside `root`; refuse anything that escapes it.
export function safeJoin(root: string, rel: string) {
  const p = path.resolve(root, rel);
  if (!isInside(p, root)) throw new Error('path escapes workspace');
  return p;
}

// ── toolbelt ──────────────────────────────────────────────────────────────
export interface GitInfo { branch: string; branches: string[]; base?: string; ahead: number; behind: number; conflicts: string[]; stashes: number; dirty: boolean; rebasing: boolean; merging: boolean }

export async function info(dir: string, base?: string): Promise<GitInfo> {
  const gitDir = (await git(dir, 'rev-parse', '--git-dir')).trim();
  const abs = path.resolve(dir, gitDir);
  const [branch, list, status, conflicts, stash] = await Promise.all([
    currentBranch(dir), branches(dir), git(dir, 'status', '--porcelain'),
    git(dir, 'diff', '--name-only', '--diff-filter=U'), git(dir, 'stash', 'list').catch(() => ''),
  ]);
  let ahead = 0, behind = 0;
  if (base && base !== branch) {
    const lr = await git(dir, 'rev-list', '--left-right', '--count', `${base}...HEAD`).catch(() => '0\t0');
    [behind, ahead] = lr.trim().split(/\s+/).map(Number);
  }
  return {
    branch, branches: list, base, ahead, behind, dirty: !!status.trim(),
    conflicts: conflicts.split('\n').filter(Boolean), stashes: stash.split('\n').filter(Boolean).length,
    rebasing: fs.existsSync(path.join(abs, 'rebase-merge')) || fs.existsSync(path.join(abs, 'rebase-apply')),
    merging: fs.existsSync(path.join(abs, 'MERGE_HEAD')),
  };
}

// Bring the branch up to date with its base: rebase a worktree branch onto base; pull for a normal checkout.
export async function syncWithBase(dir: string, base?: string) {
  if (base) {
    await git(dir, 'fetch', '--quiet').catch(() => {}); // no remote is fine
    return git(dir, 'rebase', base);
  }
  return git(dir, 'pull', '--rebase');
}

export const switchBranch = (dir: string, branch: string) => git(dir, 'switch', branch);
export const stash = (dir: string) => git(dir, 'stash', 'push', '--include-untracked', '-m', 'gibbous stash');
export const unstash = (dir: string) => git(dir, 'stash', 'pop');
export async function abortInProgress(dir: string) {
  const i = await info(dir);
  if (i.rebasing) return git(dir, 'rebase', '--abort');
  if (i.merging) return git(dir, 'merge', '--abort');
  return '';
}

// ── pull requests (gh) ────────────────────────────────────────────────────
export interface PrStatus { number: number; url: string; state: string; title: string; isDraft: boolean; mergeable?: string; reviewDecision?: string; checks: { name: string; state: string; url?: string }[] }

export async function prStatus(dir: string, branch: string): Promise<PrStatus | null> {
  const out = await run('gh', ['pr', 'view', branch, '--json', 'number,url,state,title,isDraft,mergeable,reviewDecision,statusCheckRollup'], dir).catch(() => '');
  if (!out) return null;
  const j = JSON.parse(out);
  return {
    number: j.number, url: j.url, state: j.state, title: j.title, isDraft: j.isDraft, mergeable: j.mergeable, reviewDecision: j.reviewDecision,
    checks: (j.statusCheckRollup ?? []).map((c: any) => ({ name: c.name ?? c.context, state: (c.conclusion || c.state || c.status || '').toLowerCase(), url: c.detailsUrl ?? c.targetUrl })),
  };
}

// The sidebar's one-line PR summary: number, state, CI rollup and diff size.
export type CiState = 'pass' | 'fail' | 'pending';
export interface PrBadge { title?: string; headRefName?: string; baseRefName?: string; author?: string; mergeable?: string; reviewDecision?: string; number: number; url: string; state: 'open' | 'draft' | 'merged' | 'closed'; ci: CiState | null; checks?: { passed: number; total: number }; additions: number; deletions: number }

const CI_FAIL = /^(failure|error|timed_out|cancelled|action_required|startup_failure)$/;
// A run cancelled because a newer run of the same check replaced it (a re-push, a re-run) isn't a failure: GitHub
// hides it too. Only a cancelled check with no other run of that name still counts.
export function liveChecks(rollup: any[] | undefined): any[] {
  if (!rollup?.length) return [];
  const key = (c: any) => c.name ?? c.context;
  const cancelled = (c: any) => String(c.conclusion || '').toUpperCase() === 'CANCELLED';
  return rollup.filter(c => !(cancelled(c) && key(c) && rollup.some(o => o !== c && key(o) === key(c) && !cancelled(o))));
}

export function ciState(all: any[] | undefined): CiState | null {
  const rollup = liveChecks(all);
  if (!rollup.length) return null;
  const s = rollup.map(c => ({ done: !c.status || String(c.status).toUpperCase() === 'COMPLETED', result: String(c.conclusion || c.state || '').toLowerCase() }));
  if (s.some(c => CI_FAIL.test(c.result))) return 'fail';
  if (s.some(c => !c.done || /^(pending|expected|queued|in_progress)$/.test(c.result))) return 'pending';
  return 'pass';
}

// GitHub's '12/14': checks that passed (success, skipped, neutral) out of all of them.
export function ciChecks(all: any[] | undefined): { passed: number; total: number } | undefined {
  const rollup = liveChecks(all);
  if (!rollup.length) return undefined;
  const passed = rollup.filter(c => /^(success|skipped|neutral)$/i.test(String(c.conclusion || c.state || ''))).length;
  return { passed, total: rollup.length };
}

export function prBadge(j: any): PrBadge {
  const st = String(j.state).toUpperCase();
  const checks = ciChecks(j.statusCheckRollup?.contexts ? j.statusCheckRollup.contexts.nodes : j.statusCheckRollup);
  return {
    ...(checks ? { checks } : {}),
    number: j.number, url: j.url, ...(j.title != null ? { title: j.title } : {}), ...(j.headRefName != null ? { headRefName: j.headRefName } : {}), ...(j.baseRefName != null ? { baseRefName: j.baseRefName } : {}), ...(j.author?.login ? { author: j.author.login } : {}), additions: j.additions ?? 0, deletions: j.deletions ?? 0, ci: ciState(j.statusCheckRollup?.contexts ? j.statusCheckRollup.contexts.nodes : j.statusCheckRollup),
    state: st === 'MERGED' ? 'merged' : st === 'CLOSED' ? 'closed' : j.isDraft ? 'draft' : 'open',
  };
}

// Recent PRs of a repo by head branch (newest wins). One gh call covers every worktree thread of a project.
export async function prsByBranch(dir: string): Promise<Map<string, PrBadge>> {
  const out = await run('gh', ['pr', 'list', '--state', 'all', '--limit', '60', '--json', 'number,url,title,state,isDraft,headRefName,baseRefName,additions,deletions,statusCheckRollup'], dir);
  const m = new Map<string, PrBadge>();
  for (const j of JSON.parse(out || '[]')) if (!m.has(j.headRefName)) m.set(j.headRefName, prBadge(j));
  return m;
}

// Logs of the failing GitHub Actions jobs for a branch, trimmed for an agent prompt.
export async function failingCiLogs(dir: string, branch: string): Promise<string> {
  const runs = JSON.parse(await run('gh', ['run', 'list', '--branch', branch, '--limit', '5', '--json', 'databaseId,conclusion,name'], dir).catch(() => '[]'));
  const failed = runs.filter((r: any) => r.conclusion === 'failure').slice(0, 2);
  const logs = await Promise.all(failed.map((r: any) => run('gh', ['run', 'view', String(r.databaseId), '--log-failed'], dir).then(l => `### ${r.name}\n${l.split('\n').slice(-150).join('\n')}`).catch(() => '')));
  return logs.filter(Boolean).join('\n\n');
}

// Runnable scripts a project already defines (package.json, Makefile).
export function detectScripts(dir: string): { name: string; command: string }[] {
  const out: { name: string; command: string }[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const pm = fs.existsSync(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock')) ? 'bun' : fs.existsSync(path.join(dir, 'yarn.lock')) ? 'yarn' : 'npm run';
    for (const k of Object.keys(pkg.scripts ?? {})) out.push({ name: k, command: `${pm} ${k}` });
  } catch { /* no package.json */ }
  try {
    for (const m of fs.readFileSync(path.join(dir, 'Makefile'), 'utf8').matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)) out.push({ name: m[1], command: `make ${m[1]}` });
  } catch { /* no Makefile */ }
  return out.slice(0, 30);
}
