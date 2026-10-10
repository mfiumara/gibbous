import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDisplay, cutPage, userText, skillInvocation, toolContext, type StoredMsg } from './history.ts';

const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('stored rows become the display rows session.resume sends', () => {
  const rows: StoredMsg[] = [
    { id: 1, role: 'user', content: 'fix it', timestamp: 100 },
    { id: 2, role: 'assistant', content: '', reasoning: 'look first', tool_calls: [call('c1', 'terminal', { command: 'ls -la' })], timestamp: 101 },
    { id: 3, role: 'tool', content: '{"output":"a huge listing"}', tool_call_id: 'c1', tool_name: 'terminal', timestamp: 102 },
    { id: 4, role: 'assistant', content: 'done', timestamp: 103 },
  ];
  assert.deepEqual(toDisplay(rows), [
    { role: 'user', text: 'fix it', row_id: 1, timestamp: 100 },
    { role: 'assistant', text: '', row_id: 2, timestamp: 101, reasoning: 'look first' },
    { role: 'tool', name: 'terminal', tool_call_id: 'c1', timestamp: 102, args: { command: 'ls -la' }, context: 'ls -la' },
    { role: 'assistant', text: 'done', row_id: 4, timestamp: 103 },
  ]);
});

test('tool output is never shipped and huge arguments are capped', () => {
  const big = 'x'.repeat(10_000);
  const [t] = toDisplay([ // the call-only assistant row has no text: only the tool row is left
    { id: 1, role: 'assistant', content: '', tool_calls: JSON.stringify([call('c', 'write_file', { path: '/a', content: big })]) },
    { id: 2, role: 'tool', content: big, tool_call_id: 'c' },
  ]);
  assert.equal(t.name, 'write_file');
  assert.equal((t as any).content, undefined);
  assert.ok(String(t.args!.content).length < 4100);
  assert.match(String(t.args!.content), /6000 more characters/);
  assert.equal(t.args!.path, '/a');
});

test('hidden rows, gateway notices and empty replies are skipped; queued-prompt metadata is kept', () => {
  const out = toDisplay([
    { id: 1, role: 'user', content: 'scaffold', display_kind: 'hidden' },
    { id: 2, role: 'user', content: '[System: The active model changed.]' },
    { id: 3, role: 'assistant', content: '  ' },
    { id: 4, role: 'user', content: 'later', display_metadata: '{"_queued_prompt": true}' },
  ]);
  assert.deepEqual(out, [{ role: 'user', text: 'later', row_id: 4, display_metadata: { _queued_prompt: true } }]);
});

test('a compaction carrier shows its display copy without the internal reasoning or calls', () => {
  const out = toDisplay([
    { id: 1, role: 'assistant', content: '[PRIOR CONTEXT]\nreply', display_content: 'reply', reasoning: 'internal', tool_calls: [call('c', 'terminal', { command: 'x' })] },
    { id: 2, role: 'tool', content: 'r', tool_call_id: 'c', tool_name: 'process' },
  ]);
  assert.deepEqual(out, [{ role: 'assistant', text: 'reply', row_id: 1 }, { role: 'tool', name: 'process', tool_call_id: 'c' }]);
});

test('user text gets the same projections as resume', () => {
  assert.equal(userText({ id: 1, role: 'user', content: 'hi\n[Triggering message id: `9` — use as `message_id` for reply/react/pin via the discord tools.]\n' }), 'hi\n');
  assert.equal(userText({ id: 1, role: 'user', content: 'do it\n\n[/first-task]\n\nskill body' }), 'do it');
  assert.equal(userText({ id: 1, role: 'user', content: 'look\n\n[Image attached at: /tmp/a.png]\n[Image attached at: /tmp/b.png]' }), 'look\n\n@image:/tmp/a.png\n@image:/tmp/b.png');
  assert.equal(userText({ id: 1, role: 'user', content: 'steer wrapper', display_content: 'my words' }), 'my words');
});

test('skill invocations render as typed', () => {
  const body = '[IMPORTANT: The user has invoked the "work" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\nSKILL\n\nThe user has provided the following instruction alongside the skill invocation: fix  the leak\n\n[Runtime note: x]';
  assert.equal(skillInvocation(body), '/work fix the leak');
  assert.equal(skillInvocation('[IMPORTANT: The user has invoked the "work" skill. The full skill content is loaded below.]\n\nSKILL'), '/work');
  assert.equal(skillInvocation('plain words'), null);
});

test('tool context prefers the obvious argument and stays one short line', () => {
  assert.equal(toolContext({ query: 'moon phase', limit: 5 }), 'moon phase');
  assert.equal(toolContext({ command: 'a\nb' }), 'a');
  assert.equal(toolContext({ x: 'y'.repeat(200) })!.length, 80);
  assert.equal(toolContext({ n: 1 }), undefined);
});

const turn = (u: number): StoredMsg[] => [
  { id: u, role: 'user', content: `q${u}`, timestamp: u },
  { id: u + 1, role: 'assistant', content: '', tool_calls: [call(`c${u}`, 'terminal', { command: 'ls' })], timestamp: u + 1 },
  { id: u + 2, role: 'tool', content: 'out', tool_call_id: `c${u}`, timestamp: u + 2 },
  { id: u + 3, role: 'assistant', content: `a${u}`, timestamp: u + 3 },
];

test('a full page starts at its first turn; the cut rows come with the next page', () => {
  const rows = [...turn(10).slice(2), ...turn(20)]; // window opens mid-turn (tool row without its call)
  const p = cutPage(rows, 0, rows.length);
  assert.equal(p.more, true);
  assert.equal(p.first, 20);
  assert.equal(p.next, rows.length - 2);
  assert.deepEqual(p.messages.map(m => m.role), ['user', 'tool', 'assistant']); // the call-only assistant row has no text
});

test('the oldest page (not full) keeps everything', () => {
  const rows = [...turn(10).slice(2), ...turn(20)];
  const p = cutPage(rows, 40, rows.length + 5);
  assert.equal(p.more, false);
  assert.equal(p.first, 12);
  assert.equal(p.next, 40 + rows.length);
});

test('rows the client already has (new rows shifted the offsets) are dropped', () => {
  const rows = [...turn(10), ...turn(20), ...turn(30)];
  const p = cutPage(rows, 0, 100, 20);
  assert.deepEqual(p.messages.filter(m => m.role === 'user').map(m => m.text), ['q10']);
});

test('one giant turn still keeps calls with their results', () => {
  const rows: StoredMsg[] = [{ id: 1, role: 'tool', content: 'x', tool_call_id: 'z' }, ...turn(10).slice(1)];
  const p = cutPage(rows, 0, rows.length);
  assert.equal(p.first, 11);
  assert.deepEqual([p.messages[0].role, p.messages[0].name], ['tool', 'terminal']); // the orphan result is cut, the next one has its call
});
