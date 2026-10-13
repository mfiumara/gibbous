import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchBoards, toBoard, toColumns, slug, taskId, cached, readProfileModel } from './kanban.ts';

// Small, made-up fixtures shaped like Hermes' /api/plugins/kanban responses.
const board = (o: Record<string, unknown>) => toBoard({ name: '', description: '', icon: '', color: '', project_id: null, archived: false, counts: {}, total: 0, ...o });
const boards = [
  board({ slug: 'alpha', default_workdir: '/work/alpha' }),
  board({ slug: 'beta-pkg', default_workdir: '/work/beta/packages/core' }),
  board({ slug: 'gamma', default_workdir: null, project_id: 'p_g' }),
  board({ slug: 'old', default_workdir: '/work/delta', archived: true }),
  board({ slug: 'other', default_workdir: '/elsewhere' }),
];

test('boards match projects: linked, exact workdir, Hermes project, then a workdir inside the project', () => {
  const projects = [
    { id: 'a', path: '/work/alpha' },
    { id: 'b', path: '/work/beta' },
    { id: 'g', path: '/work/gamma' },
    { id: 'd', path: '/work/delta' },                       // only an archived board: no match
    { id: 'x', path: '/work/x', kanbanBoard: 'other' },     // linked by hand
    { id: 'y', path: '/work/y', kanbanBoard: 'missing' },   // link to a board that is gone: falls through
  ];
  const m = matchBoards(projects, boards, [{ id: 'p_g', primary_path: '/work/gamma' }]);
  assert.deepEqual(m, {
    a: { slug: 'alpha', how: 'workdir' },
    b: { slug: 'beta-pkg', how: 'inside' },
    g: { slug: 'gamma', how: 'hermes-project' },
    x: { slug: 'other', how: 'linked' },
  });
});

test('a nested workdir belongs to the closest enclosing project only', () => {
  const m = matchBoards([{ id: 'root', path: '/work' }, { id: 'b', path: '/work/beta' }], boards);
  assert.equal(m.b?.slug, 'beta-pkg');
  assert.equal(m.root?.slug, 'alpha'); // /work/alpha has no closer project
  assert.equal(matchBoards([{ id: 'p', path: '/work/al' }], boards).p, undefined); // prefix of a name is not "inside"
});

test('realpath is applied to both sides', () => {
  const real = (p: string) => p.replace('/link', '/work');
  assert.equal(matchBoards([{ id: 'a', path: '/link/alpha' }], boards, [], real).a?.how, 'workdir');
});

test('board payload becomes trimmed cards in Hermes column order', () => {
  const cols = toColumns({ columns: [
    { name: 'todo', tasks: [{ id: 't_1', title: 'One', status: 'todo', assignee: 'eng', priority: 2, link_counts: { parents: 1, children: 0 }, comment_count: 3, latest_summary: 'did a thing', warnings: { count: 1 }, workspace_path: '/secret' }] },
    { name: 'running', tasks: [{ id: 't_2', title: 'Two', status: 'running', current_run_started_at: 10 }] },
    { name: 'bogus', tasks: [{ id: 't_3' }] },
  ] });
  assert.deepEqual(cols.map(c => c.name), ['todo', 'running']);
  const c = cols[0].tasks[0];
  assert.equal(c.parents, 1); assert.equal(c.comments, 3); assert.equal(c.warnings, 1); assert.equal(c.summary, 'did a thing');
  assert.ok(!('workspace_path' in c));
  assert.equal(cols[1].tasks[0].runStartedAt, 10);
});

test('slugs and task ids are validated before they reach Hermes', () => {
  assert.equal(slug('Spice-TS'), 'spice-ts');
  for (const bad of ['', '-x', '../x', 'a b', 'a/b', 'x'.repeat(65)]) assert.throws(() => slug(bad), /invalid board slug/);
  assert.equal(taskId('t_0a1b'), 't_0a1b');
  for (const bad of ['', 't_1/../2', 't 1', '?x']) assert.throws(() => taskId(bad), /invalid task id/);
});

test('cached shares one load within the ttl and drops failures', async () => {
  let n = 0;
  const load = () => Promise.resolve(++n);
  assert.equal(await cached('k1', 1000, load), 1);
  assert.equal(await cached('k1', 1000, load), 1);
  await assert.rejects(cached('k2', 1000, () => Promise.reject(new Error('down'))));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(await cached('k2', 1000, load), 2);
});

test('links: board db path follows Hermes (default at the root, others under kanban/boards, profiles share the root)', async () => {
  const { kanbanDbPath } = await import('./kanban.ts');
  assert.equal(kanbanDbPath('default', {}, '/u', 'darwin'), '/u/.hermes/kanban.db');
  assert.equal(kanbanDbPath('alpha', {}, '/u', 'darwin'), '/u/.hermes/kanban/boards/alpha/kanban.db');
  assert.equal(kanbanDbPath('alpha', { HERMES_HOME: '/u/.hermes/profiles/coder' }, '/u', 'darwin'), '/u/.hermes/kanban/boards/alpha/kanban.db');
  assert.equal(kanbanDbPath('alpha', { HERMES_HOME: '/srv/h/profiles/coder' }, '/u', 'darwin'), '/srv/h/kanban/boards/alpha/kanban.db');
  assert.equal(kanbanDbPath('alpha', { HERMES_HOME: '/srv/h' }, '/u', 'darwin'), '/srv/h/kanban/boards/alpha/kanban.db');
  assert.equal(kanbanDbPath('default', { HERMES_KANBAN_HOME: '/k', HERMES_HOME: '/srv/h' }, '/u', 'darwin'), '/k/kanban.db');
  // Windows: Hermes' native home is %LOCALAPPDATA%\hermes, profiles under it share that root.
  const local = 'C:\\Users\\u\\AppData\\Local';
  assert.equal(kanbanDbPath('alpha', { LOCALAPPDATA: local }, 'C:\\Users\\u', 'win32'), `${local}\\hermes\\kanban\\boards\\alpha\\kanban.db`);
  assert.equal(kanbanDbPath('default', { LOCALAPPDATA: local, HERMES_HOME: `${local}\\hermes\\profiles\\coder` }, 'C:\\Users\\u', 'win32'), `${local}\\hermes\\kanban.db`);
  assert.equal(kanbanDbPath('default', {}, 'C:\\Users\\u', 'win32'), 'C:\\Users\\u\\AppData\\Local\\hermes\\kanban.db');
});

test('links: read task_links from a board db (read-only), [] when the db or table is missing', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { readLinks, boardLinks } = await import('./kanban.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gib-links-'));
  try {
    const dir = path.join(home, 'kanban', 'boards', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    const w = new DatabaseSync(path.join(dir, 'kanban.db'));
    w.exec('PRAGMA journal_mode = WAL; CREATE TABLE task_links (parent_id TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY (parent_id, child_id));');
    w.exec(`INSERT INTO task_links VALUES ('t_a', 't_b'), ('t_b', 't_c'), ('t_a', 't_c')`);
    assert.deepEqual(readLinks(path.join(dir, 'kanban.db')), [{ parent: 't_a', child: 't_b' }, { parent: 't_b', child: 't_c' }, { parent: 't_a', child: 't_c' }]);
    assert.deepEqual(await boardLinks('alpha', { HERMES_KANBAN_HOME: home }), { links: [{ parent: 't_a', child: 't_b' }, { parent: 't_b', child: 't_c' }, { parent: 't_a', child: 't_c' }] });
    // The reader never writes: the db still takes writes from Hermes' side while it's open.
    w.exec(`INSERT INTO task_links VALUES ('t_c', 't_d')`);
    assert.equal(readLinks(path.join(dir, 'kanban.db')).length, 4);
    w.close();
    assert.deepEqual(await boardLinks('missing', { HERMES_KANBAN_HOME: home }), { links: [] });
    const bare = path.join(home, 'bare.db'); new DatabaseSync(bare).close();
    assert.deepEqual(readLinks(bare), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('readProfileModel reads model.default and agent.reasoning_effort, not same-named keys elsewhere', () => {
  const y = "model:\n  provider: openai-codex\n  default: gpt-6.1-sol\nfallback_providers: []\nagent:\n  max_turns: 90\n  reasoning_effort: medium # how hard\ndelegation:\n  reasoning_effort: ''\n  default: x\n";
  assert.deepEqual(readProfileModel(y), { model: 'gpt-6.1-sol', effort: 'medium' });
  assert.deepEqual(readProfileModel('terminal:\n  backend: local\n'), { model: null, effort: null });
  assert.deepEqual(readProfileModel("model:\n  default: 'anthropic/claude-opus-5-5'\n"), { model: 'anthropic/claude-opus-5-5', effort: null });
});
