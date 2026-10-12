// Incremental, read-only PR provenance from session transcripts. Never infer ownership from prose.
import type { DatabaseSync } from 'node:sqlite';
export interface PrRef { url: string; owner: string; repo: string; number: number; created: boolean }
export function prUrls(text: string): Omit<PrRef, 'created'>[] {
  const refs = new Map<string, Omit<PrRef, 'created'>>();
  for (const m of text.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?![\w-])/g)) {
    const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
    refs.set(url, { url, owner: m[1], repo: m[2], number: Number(m[3]) });
  }
  return [...refs.values()];
}
// Normalize argv arrays as well as shell commands; execute_code often uses subprocess.run([...]).
const commandWords = (s: string) => s.replace(/[\\"',\[\]]+/g, ' ');
export function readsPr(command: string) {
  const words = commandWords(command);
  return /state\.db|state\.json|sqlite3|openStateDb|PrHistory|prsByBranch|fetchPrs|\/api\/state/.test(command)
    || /\bgh\s+pr\s+(view|list|diff|checks|review|edit|comment)\b/.test(words) && !createsPr(command)
    || /(?:read_file|web_search|web_extract|browser_|search_files)/.test(command)
    || (/\bgh\s+api\b/.test(words) && !createsPr(command))
    || /\b(?:head|cat|grep)\s|\bgit\s+log\b/.test(words) && !createsPr(command);
}
export function createsPr(command: string) {
  command = commandWords(command);
  return /\bgh\s+pr\s+create\b/.test(command) || /create_pull_request/.test(command) || (/\bgh\s+api\b/.test(command) && /\/pulls(?=\s|$|[?})])/.test(command) && !/(?:-X|--method)\s+GET\b/.test(command) && /\bPOST\b|(?:-[fF]|--(?:raw-)?field)\s/.test(command));
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
interface Scan { last: number; calls: Map<string, string>; refs: Map<string, PrRef> }
export class PrHistory {
  private sessions = new Map<string, Scan>();
  // Cursors and call correlation survive ticks, including an assistant call whose result lands on the next tick.
  scan(db: DatabaseSync, root: string): { refs: PrRef[]; scanned: number } {
    const refs = new Map<string, PrRef>(); let scanned = 0;
    for (const id of sessionLineage(db, root)) {
      let s = this.sessions.get(id);
      if (!s) { s = { last: 0, calls: new Map(), refs: new Map() }; this.sessions.set(id, s); }
      const rows = db.prepare('SELECT id, role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? AND id > ? ORDER BY id').all(id, s.last) as any[];
      for (const r of rows) {
        scanned++; s.last = r.id;
        if (r.tool_calls) {
          try { for (const c of JSON.parse(r.tool_calls)) { const f = c.function ?? c; let args = f.arguments; try { args = JSON.parse(args); } catch {} s.calls.set(c.id ?? c.call_id, `${f.name ?? ''} ${typeof args === 'string' ? args : JSON.stringify(args)}`); } } catch { /* malformed historical tool call */ }
        }
        if (r.role !== 'tool') continue;
        const cmd = s.calls.get(r.tool_call_id) ?? '';
        // Transcript inspection, reviews and list/view commands can echo creation commands and owned URLs.
        if (readsPr(cmd)) { s.calls.delete(r.tool_call_id); continue; }
        // Only successful tool results are provenance; failed create commands may echo the requested URL.
        let output = r.content ?? '', ok = true;
        try { const j = JSON.parse(output); ok = j.exit_code == null || j.exit_code === 0; if (j.error) ok = false; } catch { /* raw output */ }
        if (!ok) continue;
        for (const ref of prUrls(output)) {
          const created = createsPr(cmd) || s.refs.get(ref.url)?.created || false;
          s.refs.set(ref.url, { ...ref, created });
        }
        s.calls.delete(r.tool_call_id);
      }
      for (const ref of s.refs.values()) refs.set(ref.url, { ...ref, created: ref.created || refs.get(ref.url)?.created || false });
    }
    return { refs: [...refs.values()], scanned };
  }
}
export function ownsPr(ref: PrRef, author: string | undefined, login: string | undefined) {
  return ref.created || (!!login && author?.toLowerCase() === login.toLowerCase());
}
