import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, layers, backEdges, cleanLinks, placeColumn, edgePath, lineage, graphTasks, DEFAULTS, type Link, type GraphLayout } from './graphLayout.ts';

const L = (s: string): Link[] => s.split(/\s+/).filter(Boolean).map(p => { const [parent, child] = p.split('>'); return { parent, child }; });
const at = (g: GraphLayout, id: string) => [...g.nodes, ...g.loose].find(n => n.id === id)!;
const col = (g: GraphLayout, id: string) => Math.round(at(g, id).x / (DEFAULTS.nodeW + DEFAULTS.gapX));

function noOverlaps(g: GraphLayout) {
  const all = [...g.nodes, ...g.loose], { nodeW: w, nodeH: h } = DEFAULTS;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    assert.ok(a.x + w <= b.x || b.x + w <= a.x || a.y + h <= b.y || b.y + h <= a.y, `${a.id} overlaps ${b.id}`);
  }
  for (const n of all) assert.ok(n.x >= 0 && n.y >= -0.01 && n.x + w <= g.width + 0.01 && n.y + h <= g.height + 0.01, `${n.id} outside the canvas`);
}

// Seeded random DAG-ish graph with some cycles thrown in.
function random(n: number, e: number, seed = 7) {
  let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ids = Array.from({ length: n }, (_, i) => `t${i}`), links: Link[] = [];
  for (let k = 0; k < e; k++) { const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n); links.push({ parent: ids[Math.min(a, b)], child: ids[Math.max(a, b)] }); }
  return { ids, links };
}

test('layering: parents left of children, longest path wins, a lone prerequisite sits just before its child', () => {
  const g = layoutGraph(['a', 'b', 'c', 'd', 'x'], L('a>b b>c a>c x>c d>a'));
  assert.deepEqual(['d', 'a', 'b', 'c', 'x'].map(id => col(g, id)), [0, 1, 2, 3, 2]);
  assert.deepEqual(layers(3, [[0, 1], [1, 2]]), [0, 1, 2]);
  for (const e of g.edges) for (let i = 1; i < e.points.length; i++) assert.ok(e.points[i][0] >= e.points[i - 1][0], 'edges run left to right');
  const ac = g.edges.find(e => e.parent === 'a' && e.child === 'c')!;
  assert.equal(ac.points.length, 4, 'a long edge passes through the column it skips');
  assert.deepEqual(ac.points[0], [at(g, 'a').x + DEFAULTS.nodeW, at(g, 'a').y + DEFAULTS.nodeH / 2]);
  assert.deepEqual(ac.points.at(-1), [at(g, 'c').x, at(g, 'c').y + DEFAULTS.nodeH / 2]);
});

test('links are cleaned: duplicates, self links and unknown tasks are dropped', () => {
  assert.deepEqual(cleanLinks(['a', 'b'], L('a>b a>b a>a a>zz b>a')), L('a>b b>a'));
  const g = layoutGraph(['a', 'b'], L('a>b a>b a>a q>a'));
  assert.equal(g.edges.length, 1);
});

test('cycles are broken (back edges reversed) and everything is still placed', () => {
  assert.deepEqual([...backEdges(['a', 'b', 'c'], L('a>b b>c c>a'))], [2]);
  const g = layoutGraph(['a', 'b', 'c', 'd'], L('a>b b>c c>a c>d d>d d>b'));
  assert.equal(g.nodes.length, 4);
  assert.equal(g.edges.filter(e => e.back).length, 2);
  noOverlaps(g);
  const big = random(150, 400, 3); big.links.push(...L('t140>t3 t99>t1 t50>t50'));
  const h = layoutGraph(big.ids, big.links);
  assert.equal(h.nodes.length + h.loose.length, 150);
  noOverlaps(h);
});

test('no overlaps across packed components and the no-dependencies grid', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
  const links = L('n0>n1 n1>n2 n0>n3 n3>n2 n4>n5 n6>n7 n7>n8 n9>n10 n11>n10 n12>n10 n13>n14 n14>n15 n15>n16 n16>n17');
  const g = layoutGraph(ids, links);
  assert.equal(g.loose.length, 22);
  assert.ok(g.looseTop! > Math.max(...g.nodes.map(n => n.y)) + DEFAULTS.nodeH - 1, 'the grid sits below the graph');
  assert.ok(g.loose.every(n => n.y >= g.looseTop! + DEFAULTS.looseLabel));
  noOverlaps(g);
  assert.ok(g.width < g.height * 4, 'components pack into a landscape-ish canvas, not one long row');
});

test('only loose tasks, or nothing', () => {
  const g = layoutGraph(['a', 'b', 'c'], []);
  assert.equal(g.nodes.length, 0); assert.equal(g.loose.length, 3); assert.equal(g.looseTop, 0); noOverlaps(g);
  const e = layoutGraph([], []);
  assert.deepEqual([e.width, e.height, e.looseTop], [0, 0, null]);
});

test('barycenter ordering untangles a crossed pair', () => {
  // Input order puts b above a, but a's child sits on top: x>a, y>b where x is first.
  const g = layoutGraph(['y', 'x', 'b', 'a'], L('x>a y>b'));
  const [ya, yb] = [at(g, 'a').y, at(g, 'b').y], [yx, yy] = [at(g, 'x').y, at(g, 'y').y];
  assert.equal(ya < yb, yx < yy, 'edges do not cross');
  const k = layoutGraph(['p', 'q', 'r', 's', 'c1', 'c2', 'c3'], L('p>c3 q>c2 r>c1 s>c1'));
  noOverlaps(k);
});

test('placeColumn keeps order and spacing and fits targets in least squares', () => {
  assert.deepEqual(placeColumn([0, 0, 0], [10, 10]), [-10, 0, 10]);
  assert.deepEqual(placeColumn([0, 50, 100], [10, 10]), [0, 50, 100]);
  assert.deepEqual(placeColumn([5, 0], [10]), [-2.5, 7.5]);
});

test('edgePath: curves between columns, straight lines through them', () => {
  assert.equal(edgePath([[0, 0], [100, 50]]), 'M0 0C50 0 50 50 100 50');
  assert.equal(edgePath([[0, 0], [100, 0], [200, 0]]), 'M0 0L100 0L200 0');
});

test('lineage: ancestors and descendants, not siblings', () => {
  const links = L('a>b b>c x>b c>d q>r b>s s>a');
  assert.deepEqual([...lineage('c', links)].sort(), ['a', 'b', 'c', 'd', 's', 'x']);
  assert.deepEqual([...lineage('r', links)].sort(), ['q', 'r']);
});

test('hide done keeps done tasks right next to open work', () => {
  const t = (id: string, status: string) => ({ id, status });
  const tasks = [t('a', 'done'), t('b', 'done'), t('c', 'todo'), t('d', 'done'), t('e', 'done'), t('f', 'running')];
  const links = L('a>b b>c d>e');
  assert.deepEqual(graphTasks(tasks, links, true).map(x => x.id), ['b', 'c', 'f']);
  assert.equal(graphTasks(tasks, links, false).length, 6);
});

test('a board-sized graph lays out fast and deterministically', () => {
  const { ids, links } = random(420, 300, 11);
  const t0 = performance.now();
  const g = layoutGraph(ids, links);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)}ms`);
  noOverlaps(g);
  assert.deepEqual(layoutGraph(ids, links), g);
});
