import { test } from 'node:test';
import assert from 'node:assert/strict';
import { token, match, keyLabel, helpRows, BINDINGS, type Actions } from './keys.ts';

const B = [{ keys: 'j' }, { keys: 'g g' }, { keys: 'g t' }, { keys: 'G' }, { keys: 'C-w h' }, { keys: 'C-d' }, { keys: 'C-n', when: ['overlay' as const] }];

test('space switching lives in the key registry and does not capture overlay keys', () => {
  let direction = 0;
  for (const [key, expected] of [[']', 1], ['[', -1]] as const) {
    const r = match([], key, BINDINGS, 'normal');
    assert.equal(r.kind, 'run');
    if (r.kind === 'run') r.binding.run({ space: d => { direction = d; } } as Actions);
    assert.equal(direction, expected);
    assert.equal(match([], key, BINDINGS, 'overlay').kind, 'none');
  }
});

test('token: letters keep their case, ctrl letters become C- tokens', () => {
  assert.equal(token({ key: 'j' }), 'j');
  assert.equal(token({ key: 'G', shiftKey: true }), 'G');
  assert.equal(token({ key: 'd', ctrlKey: true }), 'C-d');
  assert.equal(token({ key: 'D', ctrlKey: true, shiftKey: true }), 'C-d');
  assert.equal(token({ key: '/' }), '/');
  assert.equal(token({ key: ' ' }), 'Space');
  assert.equal(token({ key: 'Escape' }), 'Escape');
});

test('token: ⌘, Alt, bare modifiers and ctrl with named keys are not ours', () => {
  assert.equal(token({ key: 'k', metaKey: true }), null);
  assert.equal(token({ key: 'j', altKey: true }), null);
  assert.equal(token({ key: 'Shift', shiftKey: true }), null);
  assert.equal(token({ key: 'Control', ctrlKey: true }), null);
  assert.equal(token({ key: 'Enter', ctrlKey: true }), null);
});

test('match: a single key runs its binding', () => {
  const r = match([], 'j', B, 'normal');
  assert.equal(r.kind, 'run');
  assert.equal(r.kind === 'run' && r.binding.keys, 'j');
});

test('match: g alone is only a prefix and waits', () => {
  assert.deepEqual(match([], 'g', B, 'normal'), { kind: 'pending' });
  const r = match(['g'], 'g', B, 'normal');
  assert.equal(r.kind === 'run' && r.binding.keys, 'g g');
  assert.equal((m => m.kind === 'run' && m.binding.keys)(match(['g'], 't', B, 'normal')), 'g t');
});

test('match: shifted letters are distinct keys', () => {
  assert.equal((m => m.kind === 'run' && m.binding.keys)(match([], 'G', B, 'normal')), 'G');
  assert.deepEqual(match([], 'J', B, 'normal'), { kind: 'none' });
});

test('match: ctrl tokens and ctrl prefixes', () => {
  assert.equal((m => m.kind === 'run' && m.binding.keys)(match([], 'C-d', B, 'normal')), 'C-d');
  assert.deepEqual(match([], 'C-w', B, 'normal'), { kind: 'pending' });
  assert.equal((m => m.kind === 'run' && m.binding.keys)(match(['C-w'], 'h', B, 'normal')), 'C-w h');
});

test('match: an unknown key, alone or after a prefix, is none', () => {
  assert.deepEqual(match([], 'x', B, 'normal'), { kind: 'none' });
  assert.deepEqual(match(['g'], 'x', B, 'normal'), { kind: 'none' });
  assert.deepEqual(match(['g'], 'j', B, 'normal'), { kind: 'none' });
});

test('match: bindings only fire in their scope', () => {
  assert.deepEqual(match([], 'C-n', B, 'normal'), { kind: 'none' });
  assert.equal(match([], 'C-n', B, 'overlay').kind, 'run');
  assert.deepEqual(match([], 'j', B, 'overlay'), { kind: 'none' });
});

test('keyLabel: readable key names', () => {
  assert.equal(keyLabel('g g'), 'gg');
  assert.equal(keyLabel('g H'), 'gH');
  assert.equal(keyLabel('C-d'), 'Ctrl D');
  assert.equal(keyLabel('C-w h'), 'Ctrl W h');
  assert.equal(keyLabel('Enter'), 'Enter');
});

test('registry: no binding is shadowed or unreachable', () => {
  for (const scope of ['normal', 'overlay'] as const) {
    const live = BINDINGS.filter(b => (b.when ?? ['normal']).includes(scope)).map(b => b.keys);
    assert.equal(new Set(live).size, live.length, `duplicate keys in ${scope}`);
    for (const k of live) assert.ok(!live.some(o => o.startsWith(k + ' ')), `${k} is also a prefix in ${scope}`);
  }
});

test('registry: g g, G and gb call the right actions', () => {
  const calls: string[] = [];
  const a = new Proxy({}, { get: (_, name) => (...args: unknown[]) => calls.push(`${String(name)}(${args.join(',')})`) }) as Actions;
  for (const seq of [['g', 'g'], ['G'], ['g', 'b'], ['C-w', 'l'], ['g', 'H']]) {
    const r = match(seq.slice(0, -1), seq.at(-1)!, BINDINGS, 'normal');
    assert.equal(r.kind, 'run', seq.join(' '));
    if (r.kind === 'run') r.binding.run(a);
  }
  assert.deepEqual(calls, ['edge(top)', 'edge(bottom)', 'board()', 'pane(1)', 'go(/sessions)']);
});

test('helpRows: aliases share a row, every description starts with a capital', () => {
  const groups = helpRows(BINDINGS);
  assert.deepEqual(groups.map(g => g.group), ['Move around', 'Go to', 'Do']);
  const rows = groups.flatMap(g => g.rows);
  assert.ok(rows.some(([k, d]) => k === 'h / Ctrl W h / Ctrl H' && d === 'Move to the pane on the left'));
  assert.ok(rows.some(([k]) => k === 'Enter / i / a / o'));
  for (const [, d] of rows) assert.match(d, /^[A-Z]/);
});
