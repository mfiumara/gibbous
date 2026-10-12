// Incremental, read-only PR provenance from session transcripts. Never infer ownership from prose.
import type { DatabaseSync } from 'node:sqlite';
export interface PrRef { url: string; owner: string; repo: string; number: number; created: boolean }
export function prUrls(text: string): Omit<PrRef, 'created'>[] {
  const refs = new Map<string, Omit<PrRef, 'created'>>();
  for (const m of text.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?!\d)/g)) {
    const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
    refs.set(url, { url, owner: m[1], repo: m[2], number: Number(m[3]) });
  }
  return [...refs.values()];
}
export function createsPr(command: string) {
  return /\bgh\s+pr\s+create\b/.test(command) || /create_pull_request/.test(command) || (/\bgh\s+api\b/.test(command) && /\/pulls\b/.test(command) && /\bPOST\b|(?:-f|--field)\s/.test(command));
}
export function sessionLineage(db: DatabaseSync, root: string): string[] {
  return (db.prepare(`WITH RECURSIVE ancestors(id) AS (
    SELECT ? UNION SELECT s.parent_session_id FROM sessions s JOIN ancestors a ON s.id = a.id
    WHERE s.parent_session_id IS NOT NULL AND json_extract(s.model_config, '$._branched_from') IS NULL
      AND json_extract(s.model_config, '$._delegate_from') IS NULL
  ), lineage(id) AS (
    SELECT id FROM ancestors UNION SELECT s.id FROM sessions s JOIN lineage l
    ON (s.parent_session_id = l.id AND json_extract(s.model_config, '$._branched_from') IS NULL)
      OR json_extract(s.model_config, '$._delegate_from') = l.id
  ) SELECT id FROM lineage`).all(root) as { id: string }[]).map(r => r.id);
}
interface Scan { last: number; calls: Map<string, string>; refs: Map<string, PrRef>; pushes: Set<string> }
export class PrHistory {
  private sessions = new Map<string, Scan>();
  // Cursors and call correlation survive ticks, including an assistant call whose result lands on the next tick.
  scan(db: DatabaseSync, root: string): { refs: PrRef[]; pushes: Set<string>; scanned: number } {
    const refs = new Map<string, PrRef>(), pushes = new Set<string>(); let scanned = 0;
    for (const id of sessionLineage(db, root)) {
      let s = this.sessions.get(id);
      if (!s) { s = { last: 0, calls: new Map(), refs: new Map(), pushes: new Set() }; this.sessions.set(id, s); }
      const rows = db.prepare('SELECT id, role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? AND id > ? ORDER BY id').all(id, s.last) as any[];
      for (const r of rows) {
        scanned++; s.last = r.id;
        if (r.tool_calls) {
          try { for (const c of JSON.parse(r.tool_calls)) s.calls.set(c.id ?? c.call_id, JSON.stringify(c.function ?? c)); } catch { /* malformed historical tool call */ }
        }
        if (r.role !== 'tool') continue;
        const cmd = s.calls.get(r.tool_call_id) ?? '';
        // Only successful tool results are provenance; failed create commands may echo the requested URL.
        let output = r.content ?? '', ok = true;
        try { const j = JSON.parse(output); ok = j.exit_code == null || j.exit_code === 0; if (j.error) ok = false; } catch { /* raw output */ }
        if (!ok) continue;
        if (/\bgit\s+push\b/.test(cmd)) {
          // An explicit branch in a successful push is the conservative fallback for old/incomplete create traces.
          for (const m of cmd.matchAll(/\bgit\s+push\s+(?:-[\w-]+\s+)*(?:origin|upstream)\s+([\w./-]+)/g)) s.pushes.add(m[1]);
          for (const m of output.matchAll(/(?:->\s*|branch\s+['"])([\w./-]+)/g)) s.pushes.add(m[1]);
        }
        for (const ref of prUrls(output)) {
          const created = createsPr(cmd) || s.refs.get(ref.url)?.created || false;
          s.refs.set(ref.url, { ...ref, created });
        }
        s.calls.delete(r.tool_call_id);
      }
      for (const ref of s.refs.values()) refs.set(ref.url, { ...ref, created: ref.created || refs.get(ref.url)?.created || false });
      for (const b of s.pushes) pushes.add(b);
    }
    return { refs: [...refs.values()], pushes, scanned };
  }
}
export function ownsPr(ref: PrRef, author: string | undefined, login: string | undefined) {
  return ref.created || (!!login && author?.toLowerCase() === login.toLowerCase());
}
