// Layered left→right layout of a task DAG, plus its critical path (longest chain of unfinished work).
import type { Task } from '../api';

export const W = 236, H = 64;
const GX = 84, GY = 22, PAD = 24;

// Longest-path layering; tasks in a cycle (shouldn't happen) fall back to layer 0.
export function layout(tasks: Task[]) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const depth = new Map<string, number>();
  const visit = (t: Task, seen = new Set<string>()): number => {
    if (depth.has(t.id)) return depth.get(t.id)!;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const d = Math.max(-1, ...t.deps.map(id => byId.get(id)).filter(Boolean).map(p => visit(p!, seen))) + 1;
    depth.set(t.id, d);
    return d;
  };
  tasks.forEach(t => visit(t));
  const layers: Task[][] = [];
  for (const t of tasks) (layers[depth.get(t.id)!] ??= []).push(t);
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((col, i) => col.forEach((t, j) => pos.set(t.id, { x: PAD + i * (W + GX), y: PAD + j * (H + GY) })));
  // Critical path: the longest chain of unfinished work.
  const memo = new Map<string, number>();
  const remaining = (t: Task): number => memo.get(t.id) ?? (memo.set(t.id, (t.status === 'done' ? 0 : 1) + Math.max(0, ...tasks.filter(o => o.deps.includes(t.id)).map(remaining))), memo.get(t.id)!);
  const critical = new Set<string>();
  let cur = [...tasks].filter(t => !t.deps.some(d => byId.has(d))).sort((a, b) => remaining(b) - remaining(a))[0];
  while (cur && remaining(cur) > 0) { if (cur.status !== 'done') critical.add(cur.id); cur = tasks.filter(o => o.deps.includes(cur!.id)).sort((a, b) => remaining(b) - remaining(a))[0]; }
  const width = PAD * 2 + layers.length * (W + GX) - GX, height = PAD * 2 + Math.max(1, ...layers.map(l => l.length)) * (H + GY) - GY;
  return { pos, critical, width, height };
}

