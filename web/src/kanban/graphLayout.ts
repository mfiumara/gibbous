// Layered (Sugiyama-style) layout for the kanban dependency graph, pure and DOM-free (tested in graphLayout.test.ts).
// Parent → child runs left to right: cycles are broken by reversing DFS back edges, layers come from the longest path
// (sources pulled right next to their first child), long edges get dummy nodes so they route through the gaps,
// barycenter sweeps reduce crossings, and y positions are a least-squares fit to the neighbours under the
// no-overlap constraint (pool-adjacent-violators). Connected components are shelf-packed; tasks without any link go
// into a separate grid below.

export interface Link { parent: string; child: string }
export interface LayoutOptions {
  nodeW: number; nodeH: number;
  gapX: number;         // between layers
  gapY: number;         // between nodes in a layer
  compGapX: number;     // between packed components side by side: wider than gapX so they don't read as one chain
  compGapY: number;     // between rows of packed components
  looseLabel: number;   // room above the "no dependencies" grid for its label
}
export interface PlacedNode { id: string; x: number; y: number }
export interface PlacedEdge { parent: string; child: string; back: boolean; points: [number, number][] }
export interface GraphLayout {
  nodes: PlacedNode[];          // linked tasks, components in packing order, each by layer then top to bottom
  loose: PlacedNode[];          // tasks with no link in view
  edges: PlacedEdge[];
  looseTop: number | null;      // y of the "no dependencies" label, null when there are none
  width: number; height: number;
}

export const DEFAULTS: LayoutOptions = { nodeW: 232, nodeH: 64, gapX: 64, gapY: 14, compGapX: 120, compGapY: 40, looseLabel: 30 };
const DUMMY_H = 4, DUMMY_GAP = 8, SWEEPS = 24, PLACE_ROUNDS = 12;

interface VNode { id: number; real: string | null; layer: number; up: number[]; down: number[]; order: number; y: number; size: number; rank: number }

// Unique, known, non-self links in input order.
export function cleanLinks(ids: Iterable<string>, links: Link[]): Link[] {
  const known = new Set(ids), seen = new Set<string>(), out: Link[] = [];
  for (const l of links) {
    const k = `${l.parent}\u0000${l.child}`;
    if (l.parent === l.child || !known.has(l.parent) || !known.has(l.child) || seen.has(k)) continue;
    seen.add(k); out.push(l);
  }
  return out;
}

// Edges that close a cycle, found by an iterative DFS in input order (deterministic). Reversing them makes a DAG.
export function backEdges(ids: string[], links: Link[]): Set<number> {
  const out = new Map<string, { to: string; i: number }[]>();
  links.forEach((l, i) => { (out.get(l.parent) ?? out.set(l.parent, []).get(l.parent)!).push({ to: l.child, i }); });
  const state = new Map<string, 1 | 2>(), back = new Set<number>();
  for (const root of ids) {
    if (state.has(root)) continue;
    const stack: [string, number][] = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1], next = out.get(top[0])?.[top[1]++];
      if (!next) { state.set(top[0], 2); stack.pop(); continue; }
      const s = state.get(next.to);
      if (s === 1) back.add(next.i);
      else if (!s) { state.set(next.to, 1); stack.push([next.to, 0]); }
    }
  }
  return back;
}

// Longest-path layers on a DAG (edges as [from, to] index pairs); sources then move right to sit just before
// their nearest child so a lone prerequisite doesn't float at the far left.
export function layers(n: number, dag: [number, number][]): number[] {
  const indeg = new Array(n).fill(0), out: number[][] = Array.from({ length: n }, () => []), inc: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of dag) { out[a].push(b); inc[b].push(a); indeg[b]++; }
  const topo: number[] = [], layer = new Array(n).fill(0);
  const q = [...Array(n).keys()].filter(i => !indeg[i]);
  while (q.length) {
    const v = q.shift()!; topo.push(v);
    for (const w of out[v]) { layer[w] = Math.max(layer[w], layer[v] + 1); if (!--indeg[w]) q.push(w); }
  }
  for (let i = topo.length - 1; i >= 0; i--) {
    const v = topo[i];
    if (!inc[v].length && out[v].length) layer[v] = Math.min(...out[v].map(w => layer[w])) - 1;
  }
  return layer;
}

// Crossings between two adjacent layers, edges as [upper order, lower order] pairs.
function crossings(pairs: [number, number][]): number {
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let c = 0;
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) if (pairs[j][1] < pairs[i][1] && pairs[j][0] > pairs[i][0]) c++;
  return c;
}

// Least-squares y for an ordered column: minimise Σ w(y - target)² with y[i+1] - y[i] ≥ sep[i] (pool adjacent violators).
export function placeColumn(target: number[], sep: number[], w: number[] = target.map(() => 1)): number[] {
  const off = [0]; for (let i = 1; i < target.length; i++) off.push(off[i - 1] + sep[i - 1]);
  const val: number[] = [], wt: number[] = [], cnt: number[] = [];
  for (let i = 0; i < target.length; i++) {
    val.push(target[i] - off[i]); wt.push(w[i]); cnt.push(1);
    while (val.length > 1 && val[val.length - 2] > val[val.length - 1]) {
      const b = val.length - 1, a = b - 1, W = wt[a] + wt[b];
      val[a] = (val[a] * wt[a] + val[b] * wt[b]) / W; wt[a] = W; cnt[a] += cnt[b];
      val.pop(); wt.pop(); cnt.pop();
    }
  }
  const out: number[] = [];
  val.forEach((v, k) => { for (let j = 0; j < cnt[k]; j++) out.push(v + off[out.length]); });
  return out;
}

interface Comp { nodes: PlacedNode[]; edges: PlacedEdge[]; w: number; h: number }

function layoutComponent(ids: string[], links: Link[], o: LayoutOptions): Comp {
  const index = new Map(ids.map((id, i) => [id, i]));
  const back = backEdges(ids, links);
  const dag = links.map((l, i): [number, number] => back.has(i) ? [index.get(l.child)!, index.get(l.parent)!] : [index.get(l.parent)!, index.get(l.child)!]);
  const layer = layers(ids.length, dag);
  const minL = Math.min(...layer); for (let i = 0; i < layer.length; i++) layer[i] -= minL;

  // Layered graph with dummies on long edges.
  const vs: VNode[] = ids.map((id, i) => ({ id: i, real: id, layer: layer[i], up: [], down: [], order: 0, y: 0, size: o.nodeH, rank: i }));
  const chains: number[][] = dag.map(([a, b]) => {
    const chain = [a];
    for (let l = layer[a] + 1; l < layer[b]; l++) {
      const d: VNode = { id: vs.length, real: null, layer: l, up: [], down: [], order: 0, y: 0, size: DUMMY_H, rank: a + 0.5 };
      vs.push(d); chain.push(d.id);
    }
    chain.push(b);
    for (let k = 0; k + 1 < chain.length; k++) { vs[chain[k]].down.push(chain[k + 1]); vs[chain[k + 1]].up.push(chain[k]); }
    return chain;
  });
  const L = Math.max(...layer) + 1;
  const rows: VNode[][] = Array.from({ length: L }, () => []);
  for (const v of vs) rows[v.layer].push(v);

  // Initial order: first layer by input rank, then each layer by its parents' mean position.
  const setOrder = (row: VNode[]) => row.forEach((v, i) => { v.order = i; });
  const bary = (v: VNode, nb: number[]) => nb.length ? nb.reduce((s, n) => s + vs[n].order, 0) / nb.length : v.order;
  rows[0].sort((a, b) => a.rank - b.rank); setOrder(rows[0]);
  for (let l = 1; l < L; l++) {
    rows[l].sort((a, b) => (a.up.length ? bary(a, a.up) : Infinity) - (b.up.length ? bary(b, b.up) : Infinity) || a.rank - b.rank);
    setOrder(rows[l]);
  }
  const total = () => { let c = 0; for (let l = 0; l + 1 < L; l++) c += crossings(rows[l].flatMap(v => v.down.map((d): [number, number] => [v.order, vs[d].order]))); return c; };
  let best = total(), bestOrder = vs.map(v => v.order);
  for (let s = 0; s < SWEEPS && best > 0; s++) {
    const down = s % 2 === 0;
    for (let i = 1; i < L; i++) {
      const row = rows[down ? i : L - 1 - i];
      const key = new Map(row.map(v => [v, bary(v, down ? v.up : v.down)]));
      row.sort((a, b) => key.get(a)! - key.get(b)! || a.order - b.order); setOrder(row);
    }
    const c = total();
    if (c < best) { best = c; bestOrder = vs.map(v => v.order); }
  }
  vs.forEach((v, i) => { v.order = bestOrder[i]; });
  for (const row of rows) row.sort((a, b) => a.order - b.order);

  // y: stack each column, then pull every node toward its neighbours' mean without breaking the order or overlapping.
  const sepOf = (row: VNode[]) => row.slice(1).map((v, i) => (row[i].size + v.size) / 2 + (row[i].real && v.real ? o.gapY : DUMMY_GAP));
  for (const row of rows) { const sep = sepOf(row); let y = 0; row.forEach((v, i) => { if (i) y += sep[i - 1]; v.y = y; }); }
  const center = (row: VNode[], nb: (v: VNode) => number[]) => {
    const t = row.map(v => { const n = nb(v); return n.length ? n.reduce((s, x) => s + vs[x].y, 0) / n.length : v.y; });
    const w = row.map(v => v.real ? 1 : 2);   // dummies hold long edges straight
    placeColumn(t, sepOf(row), w).forEach((y, i) => { row[i].y = y; });
  };
  for (let r = 0; r < PLACE_ROUNDS; r++) {
    const last = r >= PLACE_ROUNDS - 2;
    if (r % 2 === 0) for (let l = 1; l < L; l++) center(rows[l], v => last ? [...v.up, ...v.down] : v.up);
    else for (let l = L - 2; l >= 0; l--) center(rows[l], v => last ? [...v.up, ...v.down] : v.down);
  }
  let top = Infinity, bottom = -Infinity;
  for (const v of vs) { top = Math.min(top, v.y - v.size / 2); bottom = Math.max(bottom, v.y + v.size / 2); }
  const X = (l: number) => l * (o.nodeW + o.gapX);

  const nodes = rows.flatMap(row => row.filter(v => v.real).map(v => ({ id: v.real!, x: X(v.layer), y: v.y - top - o.nodeH / 2 })));
  const edges = links.map((l, i): PlacedEdge => {
    const chain = chains[i], pts: [number, number][] = [];
    chain.forEach((n, k) => {
      const v = vs[n], y = v.y - top;
      if (k === 0) pts.push([X(v.layer) + o.nodeW, y]);
      else if (k === chain.length - 1) pts.push([X(v.layer), y]);
      else pts.push([X(v.layer), y], [X(v.layer) + o.nodeW, y]);   // straight through the column, curves in the gaps
    });
    return { parent: l.parent, child: l.child, back: back.has(i), points: pts };
  });
  return { nodes, edges, w: X(L - 1) + o.nodeW, h: bottom - top };
}

const shift = (c: Comp, dx: number, dy: number) => {
  for (const n of c.nodes) { n.x += dx; n.y += dy; }
  for (const e of c.edges) for (const p of e.points) { p[0] += dx; p[1] += dy; }
};

// The whole view. `ids` sets the stable order (e.g. status, then priority); links to unknown ids are ignored.
export function layoutGraph(ids: string[], links: Link[], opts: Partial<LayoutOptions> = {}): GraphLayout {
  const o = { ...DEFAULTS, ...opts };
  const clean = cleanLinks(ids, links);
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (c !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  for (const l of clean) for (const x of [l.parent, l.child]) if (!parent.has(x)) parent.set(x, x);
  for (const l of clean) { const a = find(l.parent), b = find(l.child); if (a !== b) parent.set(b, a); }

  const groups = new Map<string, string[]>();
  for (const id of ids) if (parent.has(id)) { const r = find(id); (groups.get(r) ?? groups.set(r, []).get(r)!).push(id); }
  const byRoot = new Map<string, Link[]>();
  for (const l of clean) { const r = find(l.parent); (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(l); }
  const comps = [...groups].map(([r, g]) => layoutComponent(g, byRoot.get(r) ?? [], o))
    .sort((a, b) => b.nodes.length - a.nodes.length || b.h - a.h);

  // Shelf packing toward a landscape canvas: rows no wider than the widest component or the area's ~16:10 width.
  const area = comps.reduce((s, c) => s + (c.w + o.compGapX) * (c.h + o.compGapY), 0);
  const limit = Math.max(...comps.map(c => c.w), Math.sqrt(area * 1.6), 0);
  let x = 0, y = 0, rowH = 0, width = 0;
  for (const c of comps) {
    if (x > 0 && x + c.w > limit) { y += rowH + o.compGapY; x = 0; rowH = 0; }
    shift(c, x, y);
    x += c.w + o.compGapX; rowH = Math.max(rowH, c.h); width = Math.max(width, x - o.compGapX);
  }
  let height = comps.length ? y + rowH : 0;

  const lone = ids.filter(id => !parent.has(id));
  let looseTop: number | null = null;
  const loose: PlacedNode[] = [];
  if (lone.length) {
    const fit = Math.floor((width + o.gapX) / (o.nodeW + o.gapX));
    const cols = Math.max(1, Math.min(lone.length, comps.length ? Math.max(2, Math.min(8, fit)) : Math.min(8, Math.ceil(Math.sqrt(lone.length * 1.6)))));
    looseTop = comps.length ? height + o.compGapY * 1.5 : 0;
    const y0 = looseTop + o.looseLabel;
    lone.forEach((id, i) => loose.push({ id, x: (i % cols) * (o.nodeW + o.gapX / 2), y: y0 + Math.floor(i / cols) * (o.nodeH + o.gapY) }));
    width = Math.max(width, cols * (o.nodeW + o.gapX / 2) - o.gapX / 2);
    height = y0 + Math.ceil(lone.length / cols) * (o.nodeH + o.gapY) - o.gapY;
  }
  return { nodes: comps.flatMap(c => c.nodes), loose, edges: comps.flatMap(c => c.edges), looseTop, width, height };
}

// SVG path through an edge's points: horizontal-tangent curves between columns, straight runs through them.
export function edgePath(points: [number, number][]): string {
  let d = `M${r(points[0][0])} ${r(points[0][1])}`;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    if (ay === by) { d += `L${r(bx)} ${r(by)}`; continue; }
    const dx = Math.max(16, Math.abs(bx - ax) / 2);
    d += `C${r(ax + dx)} ${r(ay)} ${r(bx - dx)} ${r(by)} ${r(bx)} ${r(by)}`;
  }
  return d;
}
const r = (n: number) => Math.round(n * 10) / 10;

// Everything a hovered task depends on (up) and everything waiting on it (down), itself included.
export function lineage(id: string, links: Link[]): Set<string> {
  const ups = new Map<string, string[]>(), downs = new Map<string, string[]>();
  for (const l of links) { (ups.get(l.child) ?? ups.set(l.child, []).get(l.child)!).push(l.parent); (downs.get(l.parent) ?? downs.set(l.parent, []).get(l.parent)!).push(l.child); }
  const out = new Set([id]);
  for (const m of [ups, downs]) {
    const q = [id], seen = new Set([id]);
    while (q.length) for (const n of m.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); out.add(n); q.push(n); }
  }
  return out;
}

// Which tasks the graph shows. "Hide done" keeps done tasks that sit right next to open work (the context of
// what just unblocked it) and drops finished chains.
export function graphTasks<T extends { id: string; status: string }>(tasks: T[], links: Link[], hideDone: boolean): T[] {
  if (!hideDone) return tasks;
  const open = new Set(tasks.filter(t => t.status !== 'done').map(t => t.id)), keep = new Set<string>();
  for (const l of links) { if (open.has(l.child)) keep.add(l.parent); if (open.has(l.parent)) keep.add(l.child); }
  return tasks.filter(t => open.has(t.id) || keep.has(t.id));
}
