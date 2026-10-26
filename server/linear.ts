// Linear tickets a thread works on, for its rail card and a sidebar mark. Found in the transcript (never guessed):
//   - linear.app issue links the user or the agent wrote,
//   - issues the agent created, updated or opened through the Linear connector,
//   - bare identifiers ("SCH-123") the user typed, once that team key is known,
//   - the worktree branch, when it follows Linear's naming ("mattia/sch-123-fix-leds").
// Details come from the user's Linear connection in Hermes (one GraphQL query for every ticket on screen), so nothing
// here needs its own Linear login; without that connection the card simply stays empty.
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { state } from './store.ts';
import { sessionLineage } from './prHistory.ts';
import { openStateDb } from './subagents.ts';
import { hermesPython } from './limits.ts';

export interface LinearIssue {
  identifier: string; title: string; url: string;
  state: { name: string; type: string; color: string };
  assignee: string | null; priority: number; priorityLabel: string;
  labels: { name: string; color: string }[]; project: string | null;
}

const ID = /\b([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,6})\b/g;
const URL = /https:\/\/linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]{1,9}-[1-9]\d{0,6})/g;
// Connector calls about one issue. Lists and searches return many and say nothing about this thread.
const ONE_ISSUE = /connectors__linear__(?:CREATE|UPDATE|GET)_LINEAR_ISSUE\b|connectors__linear__CREATE_A_COMMENT|issueCreate|issueUpdate/;

/** Identifiers in text: issue links always; bare ones only for known team keys. */
export function linearIds(text: string, keys: Set<string>, bare: boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL)) out.push(m[1].toUpperCase());
  if (bare) for (const m of text.matchAll(ID)) if (keys.has(m[1])) out.push(m[0]);
  return out;
}
/** Linear's branch names: "<user>/sch-123-title" or "sch-123-title". */
export function branchIssue(branch: string, keys: Set<string>): string | undefined {
  const m = /(?:^|\/)([a-z][a-z0-9]{1,9})-([1-9]\d{0,6})(?:-|$)/i.exec(branch);
  return m && keys.has(m[1].toUpperCase()) ? `${m[1].toUpperCase()}-${m[2]}` : undefined;
}

interface Scan { last: number; calls: Map<string, string>; ids: Map<string, number> }
export class LinearHistory {
  private sessions = new Map<string, Scan>();
  // Most recent mention last-wins, so the card leads with what the thread touched last.
  scan(db: DatabaseSync, root: string, keys: Set<string>): Map<string, number> {
    const ids = new Map<string, number>();
    for (const id of sessionLineage(db, root)) {
      let s = this.sessions.get(id);
      // Team keys arrive later than the text that uses them: rescan from the start when they change.
      if (!s || (s as any).keys !== [...keys].join()) { s = { last: 0, calls: new Map(), ids: new Map() }; (s as any).keys = [...keys].join(); this.sessions.set(id, s); }
      const rows = db.prepare('SELECT id, role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? AND id > ? ORDER BY id').all(id, s.last) as any[];
      for (const r of rows) {
        s.last = r.id;
        if (r.tool_calls) {
          try { for (const c of JSON.parse(r.tool_calls)) { const f = c.function ?? c; s.calls.set(c.id ?? c.call_id, `${f.name ?? ''} ${typeof f.arguments === 'string' ? f.arguments : JSON.stringify(f.arguments)}`); } } catch { /* malformed */ }
        }
        const text = String(r.content ?? '');
        let found: string[] = [];
        if (r.role === 'user') found = linearIds(text, keys, true);
        else if (r.role === 'assistant') found = linearIds(text, keys, false);
        else if (r.role === 'tool') {
          const call = s.calls.get(r.tool_call_id) ?? '';
          s.calls.delete(r.tool_call_id);
          if (ONE_ISSUE.test(call) && !/"successful":\s*false|"error":\s*\{/.test(text.slice(0, 400))) found = [...text.matchAll(/"identifier":\s*"([A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6})"/g)].map(m => m[1]).slice(0, 3);
        }
        for (const f of found) s.ids.set(f, r.id);
      }
      for (const [k, at] of s.ids) ids.set(k, Math.max(at, ids.get(k) ?? 0));
    }
    return ids;
  }
}

const PY = `import json,sys
from tools.connectors.dispatch import dispatch_connector_call
ids=json.load(sys.stdin)
f='identifier title url state { name type color } assignee { displayName } priority priorityLabel labels { nodes { name color } } project { name }'
q='query { teams { nodes { key } } '+' '.join('i%d: issue(id: %s) { %s }'%(n,json.dumps(i),f) for n,i in enumerate(ids))+' }'
r=json.loads(dispatch_connector_call('connectors__linear__RUN_QUERY_OR_MUTATION',{'query_or_mutation':q,'variables':{}},'gibbous-linear'))
if r.get('error'): print(json.dumps({'error':r['error'].get('code')})); sys.exit()
d=((r.get('response') or {}).get('data') or {}).get('data') or {}
print(json.dumps({'keys':[t['key'] for t in (d.get('teams') or {}).get('nodes',[])],'issues':[v for k,v in d.items() if k.startswith('i') and v]}))`;

export function parseIssue(v: any): LinearIssue {
  return {
    identifier: String(v.identifier), title: String(v.title ?? ''), url: String(v.url ?? ''),
    state: { name: String(v.state?.name ?? ''), type: String(v.state?.type ?? ''), color: String(v.state?.color ?? '#95a2b3') },
    assignee: v.assignee?.displayName ?? null, priority: Number(v.priority ?? 0), priorityLabel: String(v.priorityLabel ?? ''),
    labels: (v.labels?.nodes ?? []).map((l: any) => ({ name: String(l.name), color: String(l.color) })), project: v.project?.name ?? null,
  };
}

function query(ids: string[]): Promise<{ keys: string[]; issues: LinearIssue[] } | null> {
  const py = hermesPython();
  if (!py) return Promise.resolve(null);
  return new Promise(resolve => {
    const p = execFile(py, ['-c', PY], { cwd: path.dirname(path.dirname(path.dirname(py))), timeout: 45_000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out.trim().split('\n').pop() || '{}');
        resolve(j.error ? null : { keys: j.keys ?? [], issues: (j.issues ?? []).map(parseIssue) });
      } catch { resolve(null); }
    });
    p.stdin?.end(JSON.stringify(ids));
  });
}

const history = new LinearHistory();
let keys = new Set<string>(), keysAt = 0;
let lists: Record<string, LinearIssue[]> = {};
let inflight: Promise<void> | undefined;
export const threadLinear = () => lists;

export function refreshLinear(onChange: (lists: Record<string, LinearIssue[]>) => void) {
  if (inflight) return inflight;
  return inflight = (async () => {
    // Team keys (for bare "SCH-123" and branch names): learned with the first query, refreshed hourly.
    if (!keysAt || Date.now() - keysAt > 3600_000) { const r = await query([]); if (r) { keys = new Set(r.keys); keysAt = Date.now(); } else if (!keysAt) return; }
    const db = openStateDb();
    if (!db) return;
    const per = new Map<string, string[]>();
    for (const t of state.threads) {
      if (t.host || !t.sessionId || t.status === 'archived') continue;
      const found = history.scan(db, t.sessionId, keys);
      const b = t.worktree && branchIssue(t.worktree.branch, keys);
      if (b && !found.has(b)) found.set(b, 0);
      if (found.size) per.set(t.id, [...found].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 8));
    }
    const all = [...new Set([...per.values()].flat())];
    const r = all.length ? await query(all) : { keys: [...keys], issues: [] };
    if (!r) return;
    const byId = new Map(r.issues.map(i => [i.identifier, i]));
    const next: Record<string, LinearIssue[]> = {};
    for (const [tid, ids] of per) { const is = ids.flatMap(i => byId.get(i) ?? []); if (is.length) next[tid] = is; }
    if (JSON.stringify(next) !== JSON.stringify(lists)) { lists = next; onChange(lists); }
  })().catch(e => console.error('[linear]', e)).finally(() => { inflight = undefined; });
}
