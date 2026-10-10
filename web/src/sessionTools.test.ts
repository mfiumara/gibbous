import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolOf, codexApp, claudeApp, chipsOf, countLabel, TOOLS } from './sessionTools.ts';
import { fromHermes, fromForeign, fromThreads, ownSessions, byTool, groupCandidates, type SessionDirs, type Origins } from './importSessions.ts';
import type { SessionListRow, ForeignSessionRow } from './hermes/contract';

test('each session source belongs to one tool', () => {
  assert.deepEqual(['cli', 'tui', 'desktop', 'acp', 'discord', 'telegram', 'api_server', 'webhook', 'claude_code', 'codex', 'weird'].map(toolOf),
    ['cli', 'cli', 'desktop', 'acp', 'messaging', 'messaging', 'api', 'api', 'claude', 'codex', 'other']);
});

test('Codex originators and Claude Code entrypoints name the app', () => {
  assert.deepEqual(['Codex Desktop', 'codex-tui', 'codex_cli_rs', 'codex_exec', 't3code_desktop', 'openmausbot', undefined].map(o => codexApp(o).label),
    ['Codex app', 'Codex CLI', 'Codex CLI', 'codex exec', 'T3 Code', 'Other apps', 'Unknown app']);
  assert.deepEqual(['cli', 'sdk-cli', 'sdk-ts', 'claude-desktop', 'x', ''].map(e => claudeApp(e).key), ['cli', 'sdk', 'sdk', 'desktop', 'other', 'other']);
});

test('tool copy: no tool label or blurb names the backend', () => {
  for (const t of TOOLS) assert.doesNotMatch(`${t.label} ${t.tip} ${t.blurb}`, /hermes/i);
});

test('chips count per app, most used first, and keep the raw names behind "Other apps"', () => {
  const xs = ['codex-tui', 'Codex Desktop', 'codex_cli_rs', 'openmausbot', 'orchestrator_macos'].map(o => ({ ...codexApp(o), raw: o }));
  assert.deepEqual(chipsOf(xs, x => x).map(c => [c.label, c.n, c.raw.length]), [['Codex CLI', 2, 2], ['Other apps', 2, 2], ['Codex app', 1, 1]]);
  assert.equal(countLabel(50, true), '50+'); assert.equal(countLabel(3), '3');
});

const NOW = Date.UTC(2026, 9, 10);
test('sessions sort into tools; Gibbous-made sessions move from "Desktop app" to Gibbous; Codex helper runs are flagged', () => {
  const rows: SessionListRow[] = [
    { id: 'g1', source: 'desktop', message_count: 4, started_at: NOW / 1000 }, { id: 'd1', source: 'desktop', message_count: 2, started_at: NOW / 1000 },
    { id: 'a1', source: 'acp', message_count: 3 }, { id: 'a0', source: 'acp', message_count: 0 }, { id: 'x1', source: 'discord', message_count: 9 }, { id: 'c1', source: 'cron', message_count: 1 },
  ];
  const threads = [{ id: 't1', sessionId: 'g1', title: 'Mine', updatedAt: NOW, cwd: '/u/app', projectId: 'p1' }, { id: 't2', sessionId: 'x1', title: 'Chat', updatedAt: NOW, source: 'discord' }];
  const own = ownSessions(threads);
  assert.deepEqual([...own], ['g1']);
  const dirs: SessionDirs = { home: '/u', sessions: {}, folders: {} };
  const native = fromHermes(rows, dirs, own, s => s.toUpperCase());
  const gib = fromThreads(threads, [{ id: 'p1', path: '/u/app' }], dirs);
  assert.deepEqual(gib.map(c => [c.tool, c.thread, c.folder]), [['gibbous', 't1', '/u/app']]);
  const f: ForeignSessionRow[] = [{ id: 'h1', source: 'codex', label: 'Codex', mtime: 2 }, { id: 'h2', source: 'codex', label: 'Codex', mtime: 1 }, { id: 'h3', source: 'claude', label: 'Claude Code', mtime: 3 }];
  const origins: Origins = { codex: { h1: { app: 't3code_desktop' }, h2: { app: 'codex_exec', sub: true } }, claude: { h3: { app: 'sdk-cli' } } };
  const foreign = fromForeign(f, origins);
  assert.deepEqual(foreign.map(c => [c.tool, c.app?.label, !!c.sub]), [['claude', 'Via SDK (Paseo, apps)', false], ['codex', 'T3 Code', false], ['codex', 'codex exec', true]]);
  const by = byTool([...gib, ...native, ...foreign.filter(c => !c.sub)]);
  assert.deepEqual(Object.fromEntries([...by].map(([k, v]) => [k, v.map(c => c.id)])), { gibbous: ['g1'], desktop: ['d1'], acp: ['a1'], messaging: ['x1'], claude: ['h3'], codex: ['h1'] });
  assert.equal(by.get('messaging')![0].app?.label, 'DISCORD');
  // Without the origins route there are no app chips.
  assert.equal(fromForeign(f, null)[0].app, undefined);
});

test('Claude Code / Codex rows file under the repository they ran in, even in folders only they saw', () => {
  const dirs: SessionDirs = { home: '/u', sessions: {}, folders: { '/u/repos/app': { root: '/u/repos/app', repo: true, exists: true } } };
  const f: ForeignSessionRow[] = [{ id: 'h1', source: 'claude', label: 'Claude Code', mtime: 2, cwd: '/u/repos/app/web' }, { id: 'h2', source: 'codex', label: 'Codex', mtime: 1, cwd: '/u/scratch' }];
  const c = fromForeign(f, null, dirs);
  assert.deepEqual(c.map(x => x.folder), ['/u/repos/app', '/u/scratch']);
  const g = groupCandidates(c, { dirs, label: s => s });
  assert.deepEqual(g.map(x => [x.label, x.canProject]), [['app', true], ['scratch', false]]); // unknown folders aren't "removed", just not offered as projects
});

test('scratch checkouts under /tmp share one "Temporary folders" group', () => {
  const dirs: SessionDirs = { home: '/u', sessions: {}, folders: {} };
  const f: ForeignSessionRow[] = ['/private/tmp/a', '/tmp/b/c', '/tmp'].map((cwd, i) => ({ id: `h${i}`, source: 'codex', label: 'Codex', mtime: i, cwd }));
  const g = groupCandidates(fromForeign(f, null, dirs), { dirs, label: s => s });
  assert.deepEqual(g.map(x => [x.label, x.items.length, x.canProject]), [['Temporary folders', 3, false]]);
});
