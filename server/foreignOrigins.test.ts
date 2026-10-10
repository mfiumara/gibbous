import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foreignOrigins, codexOrigin, claudeOrigin, handleFor } from './foreignOrigins.ts';

test('codex and claude origins parse their first lines', () => {
  assert.deepEqual(codexOrigin(JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex Desktop', source: 'vscode', cwd: '/r' } })), { app: 'Codex Desktop', cwd: '/r' });
  assert.deepEqual(codexOrigin(JSON.stringify({ payload: { originator: 'codex_exec', source: { subagent: { other: 'guardian' } } } })), { app: 'codex_exec', sub: true });
  assert.equal(codexOrigin('not json'), null);
  assert.deepEqual(claudeOrigin('{"type":"summary"}\n{"cwd":"/a \\"q\\"","entrypoint":"sdk-cli","x":1}'), { app: 'sdk-cli', cwd: '/a "q"' });
  assert.equal(claudeOrigin('{"type":"summary"}'), null);
});

test('origins are keyed by the handle Hermes hands out (sha256 of source:real path)', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origins-')));
  const cx = path.join(home, 'codex', 'sessions', '2026', '10', '01'), cl = path.join(home, 'claude', 'projects', '-Users-x-repo');
  fs.mkdirSync(cx, { recursive: true }); fs.mkdirSync(cl, { recursive: true });
  const a = path.join(cx, 'rollout-a.jsonl'), b = path.join(cx, 'rollout-b.jsonl'), c = path.join(cl, 's1.jsonl');
  fs.writeFileSync(a, JSON.stringify({ payload: { originator: 't3code_desktop', cwd: path.join(home, 'gone') } }) + '\n{"more":1}\n');
  fs.writeFileSync(b, JSON.stringify({ payload: { originator: 'codex-tui', source: { subagent: 'x' } } }) + '\n');
  fs.writeFileSync(path.join(cx, 'other.jsonl'), '{}\n'); // not a rollout
  fs.writeFileSync(c, '{"type":"summary"}\n{"entrypoint":"cli"}\n');
  const env = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = path.join(home, 'codex'); process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  try {
    const o = foreignOrigins();
    // The hash must match Hermes' hashlib.sha256(f"{name}:{path}") — this one was computed by Python for "codex:/x/rollout.jsonl".
    assert.equal(handleFor('codex', '/x/rollout.jsonl'), '53ae5b8ca066533ec304e2286cb1339d169c230f4c4b6ccd48283803640def3e');
    assert.deepEqual(o.codex, { [handleFor('codex', a)]: { app: 't3code_desktop' }, [handleFor('codex', b)]: { app: 'codex-tui', sub: true } });
    assert.deepEqual(o.claude, { [handleFor('claude', c)]: { app: 'cli' } });
    assert.deepEqual(o.folders, { [path.join(home, 'gone')]: { root: path.join(home, 'gone'), repo: false, exists: false } });
  } finally {
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
