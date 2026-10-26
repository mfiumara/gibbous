import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LinearHistory, branchIssue, linearIds, parseIssue } from './linear.ts';

const keys = new Set(['SCH']);

test('linearIds: issue links always, bare identifiers only for known team keys and only when asked', () => {
  const text = 'See https://linear.app/schematik-io/issue/SCH-100/route-ov2640 and SCH-12, ABC-3, UTF-8';
  assert.deepEqual(linearIds(text, keys, false), ['SCH-100']);
  assert.deepEqual(linearIds(text, keys, true), ['SCH-100', 'SCH-100', 'SCH-12']);
});

test('branchIssue reads Linear-style branch names for known keys', () => {
  assert.equal(branchIssue('mattia/sch-123-fix-leds', keys), 'SCH-123');
  assert.equal(branchIssue('sch-9', keys), 'SCH-9');
  assert.equal(branchIssue('gibbous/missing-led-annotation', keys), undefined);
  assert.equal(branchIssue('feature/utf-8-names', keys), undefined);
});

test('scan: user mentions, created issues; ignores list results, failed calls and bare ids in replies', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sessions (id TEXT, parent_session_id TEXT, model_config TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT);
    INSERT INTO sessions VALUES ('s1', NULL, '{}');`);
  const add = (role: string, content: string, calls?: unknown, callId?: string) =>
    db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)').run('s1', role, content, calls ? JSON.stringify(calls) : null, callId ?? null);
  add('user', 'can you look at SCH-5?');
  add('assistant', 'Also related: SCH-6', [{ id: 'c1', function: { name: 'tool_call', arguments: '{"calls":[{"name":"connectors__linear__LIST_LINEAR_ISSUES"}]}' } }]);
  add('tool', '{"issues":[{"identifier":"SCH-7"},{"identifier":"SCH-8"}]}', undefined, 'c1');
  add('assistant', '', [{ id: 'c2', function: { name: 'tool_call', arguments: '{"calls":[{"name":"connectors__linear__CREATE_LINEAR_ISSUE"}]}' } }]);
  add('tool', '{"results":[{"response":{"successful":true,"data":{"identifier":"SCH-42"}}}]}', undefined, 'c2');
  add('assistant', '', [{ id: 'c3', function: { name: 'connectors__linear__CREATE_LINEAR_ISSUE', arguments: '{}' } }]);
  add('tool', '{"error": {"code": "CONNECTION_REQUIRED"}, "identifier": "SCH-99"}', undefined, 'c3');
  const found = new LinearHistory().scan(db, 's1', keys);
  assert.deepEqual([...found.keys()].sort(), ['SCH-42', 'SCH-5']);
});

test('parseIssue fills defaults', () => {
  const i = parseIssue({ identifier: 'SCH-1', title: 'x', url: 'u', state: { name: 'Todo', type: 'unstarted', color: '#fff' }, labels: { nodes: [{ name: 'Bug', color: '#f00' }] } });
  assert.equal(i.assignee, null);
  assert.equal(i.priority, 0);
  assert.deepEqual(i.labels, [{ name: 'Bug', color: '#f00' }]);
});
