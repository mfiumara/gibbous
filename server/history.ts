// A thread's conversation, one page at a time, newest first. Hermes' `session.resume` projects the WHOLE lineage on
// every open (for a ~1.5k-message thread that took 10-20s of gateway CPU, mostly per-call shell-command previews, and
// shipped ~3MB). Hermes' own desktop instead hydrates from the REST transcript in pages and resumes with
// `omit_messages`; Gibbous does the same. This module turns stored REST rows into the compact display rows
// `session.resume` would send (same shape, so web/src/thread/timeline.ts `fromHistory` renders both) and cuts pages on
// turn starts, so a turn and its footer never straddle two pages. Pure (except `historyPage`), tested in history.test.ts.

export interface StoredMsg {
  id: number; role: string; content?: unknown; display_content?: string | null; timestamp?: number | null;
  tool_calls?: unknown; tool_call_id?: string | null; tool_name?: string | null;
  reasoning?: string | null; reasoning_content?: string | null; display_kind?: string | null; display_metadata?: unknown;
}
export interface DisplayMsg {
  role: string; text?: string; timestamp?: number; row_id?: number; display_kind?: string; display_metadata?: unknown;
  reasoning?: string; name?: string; context?: string; args?: Record<string, unknown>; tool_call_id?: string;
}
export interface HistoryPage { messages: DisplayMsg[]; next: number; more: boolean; first?: number }

const ARG_CAP = 4000; // a write_file's whole file as an argument: the row shows a preview, nobody reads 200KB in it

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => typeof p === 'string' ? p : p?.type === 'text' ? p.text : p?.type?.includes?.('image') ? '[image]' : '').filter(Boolean).join('\n') : '';
const json = (v: unknown) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return undefined; } };

// ── user-row projections session.resume applies (tui_gateway/session_history.py) ──
// Skill invocations: the model-facing body becomes what the user typed (`/work fix the leak`).
// Mirrors apps/shared/src/skill-scaffold.ts in the Hermes repo (MIT), which mirrors agent/skill_commands.py.
const INVOCATION_PREFIX = '[IMPORTANT: The user has invoked the ';
const SINGLE_MARKER = 'The full skill content is loaded below.]';
const SINGLE_INSTRUCTION = 'The user has provided the following instruction alongside the skill invocation: ';
const RUNTIME_NOTE = '\n\n[Runtime note:';
const BUNDLE_MARKER = ' skill bundle,';
const BUNDLE_INSTRUCTION = '\nUser instruction: ';
const BUNDLE_SKILL_BLOCK = '\n\n[Loaded as part of the ';
const NAME_RE = /^\[IMPORTANT: The user has invoked the "([^"]*)"/;
function between(text: string, marker: string, end: string, fromEnd = false) {
  const i = fromEnd ? text.lastIndexOf(marker) : text.indexOf(marker);
  if (i < 0) return '';
  const tail = text.slice(i + marker.length), stop = tail.indexOf(end);
  return (stop >= 0 ? tail.slice(0, stop) : tail).trim();
}
export function skillInvocation(text: string): string | null {
  if (text.startsWith('[/initiate-setup]')) return '/initiate-setup';
  if (!text.startsWith(INVOCATION_PREFIX)) return null;
  const name = (NAME_RE.exec(text)?.[1] ?? '').trim();
  if (!name) return null;
  const label = name.startsWith('/') ? name : `/${name}`;
  const instruction = text.includes(BUNDLE_MARKER) ? between(text, BUNDLE_INSTRUCTION, BUNDLE_SKILL_BLOCK)
    : text.includes(SINGLE_MARKER) ? between(text, SINGLE_INSTRUCTION, RUNTIME_NOTE, true) : '';
  return instruction ? `${label} ${instruction.replace(/\s+/g, ' ')}` : label;
}
const DISCORD_NOTE = /(^|\n)\[Triggering message id: `[^`\n]*` — use as `message_id` for reply\/react\/pin via the discord tools\.\]\n*/g;
const FIRST_TASK = '\n\n[/first-task]\n\n';
// Native-vision images are stored as "[Image attached at: /path]" hints after the caption; bubbles show @image refs.
function imageHints(text: string): string {
  const at = text.indexOf('\n\n[Image attached at: ');
  if (at <= 0) return text;
  const paths = [...text.slice(at + 2).matchAll(/^\[Image attached at: (.+?)\]$/gm)].map(m => m[1]);
  return paths.length ? `${text.slice(0, at)}\n\n${paths.map(p => `@image:${p}`).join('\n')}` : text;
}
export function userText(m: StoredMsg): string | null {
  let t = m.display_content ?? textOf(m.content);
  if (t.trimStart().startsWith('[System:')) return null; // gateway notices stored as user rows; never a bubble
  t = imageHints(t.replace(DISCORD_NOTE, '$1')).split(FIRST_TASK)[0];
  return skillInvocation(t) ?? t;
}

// The tool row's one-line detail when the args carry no command/path (ToolRow prefers those).
const PREVIEW_KEYS = ['command', 'path', 'query', 'url', 'pattern', 'goal', 'name', 'action', 'question', 'prompt', 'text'];
export function toolContext(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const k = PREVIEW_KEYS.find(k => typeof args[k] === 'string' && (args[k] as string).trim()) ?? Object.keys(args).find(k => typeof args[k] === 'string');
  const v = k ? String(args[k]).trim().split('\n')[0] : '';
  return v ? (v.length > 80 ? `${v.slice(0, 79)}…` : v) : undefined;
}
const capArgs = (a: Record<string, unknown>): Record<string, unknown> => {
  let out: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(a)) if (typeof v === 'string' && v.length > ARG_CAP) (out ??= { ...a })[k] = `${v.slice(0, ARG_CAP)}\n… (${v.length - ARG_CAP} more characters)`;
  return out ?? a;
};

// Stored rows (oldest → newest) as display rows. Tool rows take name/args from their assistant call, as resume does.
export function toDisplay(rows: StoredMsg[]): DisplayMsg[] {
  const calls = new Map<string, { name: string; args?: Record<string, unknown> }>();
  const out: DisplayMsg[] = [];
  for (const m of rows) {
    if (m.display_kind === 'hidden') continue;
    const base = { ...(m.timestamp ? { timestamp: m.timestamp } : {}), ...(m.display_kind ? { display_kind: m.display_kind } : {}) };
    if (m.role === 'assistant') {
      // REST sets display_content on an assistant row only for a compaction carrier, whose display copy (like
      // resume's) drops the internal fields: reasoning and inherited tool calls.
      const carrier = m.display_content != null;
      for (const c of carrier ? [] : (json(m.tool_calls) as any[] | undefined) ?? []) {
        const id = c?.id ?? c?.call_id, fn = c?.function;
        if (!id || !fn?.name) continue;
        const args = json(fn.arguments ?? '{}');
        calls.set(id, { name: fn.name, args: args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : undefined });
      }
      const text = m.display_content ?? textOf(m.content), reasoning = carrier ? undefined : m.reasoning ?? m.reasoning_content ?? undefined;
      if (!text.trim() && !reasoning) continue;
      out.push({ role: 'assistant', text, row_id: m.id, ...base, ...(reasoning ? { reasoning } : {}) });
    } else if (m.role === 'tool') {
      const c = m.tool_call_id ? calls.get(m.tool_call_id) : undefined;
      const args = c?.args && Object.keys(c.args).length ? capArgs(c.args) : undefined;
      out.push({ role: 'tool', name: c?.name ?? m.tool_name ?? 'tool', ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}), ...base,
        ...(args ? { args, context: toolContext(c!.args) } : {}) });
    } else if (m.role === 'user') {
      const text = userText(m);
      if (text == null || !text.trim()) continue;
      const meta = json(m.display_metadata);
      out.push({ role: 'user', text, row_id: m.id, ...base, ...(meta ? { display_metadata: meta } : {}) });
    } else if (m.role === 'system') {
      out.push({ role: 'system', ...base }); // only its time matters (turn footers)
    }
  }
  return out;
}

const visibleUser = (m: StoredMsg) => m.role === 'user' && m.display_kind !== 'hidden' && userText(m) != null && !(json(m.display_metadata) as any)?._queued_prompt;

// One page out of the REST window `rows` (oldest → newest, `limit` asked at `offset` rows from the newest).
// `before`: the oldest row the client already has; rows from it on (new rows shifted the offsets) are dropped.
// When older rows exist, the page starts at its first turn (a user row), so the turn's tool rows have their call and
// its footer its start; the rows cut off come back with the next (older) page. `next` is that page's offset.
export function cutPage(rows: StoredMsg[], offset: number, limit: number, before?: number): HistoryPage {
  const returned = rows.length;
  const more = returned >= limit;
  const cut = before != null ? rows.findIndex(r => r.id === before) : -1;
  let window = cut >= 0 ? rows.slice(0, cut) : rows;
  let skip = 0;
  if (more) {
    skip = window.findIndex(visibleUser);
    if (skip < 0) skip = Math.max(0, window.findIndex(r => r.role !== 'tool')); // one giant turn: at least keep calls with their results
    window = window.slice(skip);
  }
  return { messages: toDisplay(window), next: offset + returned - skip, more, first: window[0]?.id };
}

export interface RestBackend { port: number; token: string }
export async function historyPage(b: RestBackend, sessionId: string, o: { offset?: number; limit?: number; before?: number; profile?: string }): Promise<HistoryPage> {
  const limit = Math.min(500, Math.max(20, o.limit ?? 200)), offset = Math.max(0, o.offset ?? 0);
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset), order: 'latest', include_compacted: 'true', inline_images: 'false', ...(o.profile ? { profile: o.profile } : {}) });
  const r = await fetch(`http://127.0.0.1:${b.port}/api/sessions/${encodeURIComponent(sessionId)}/messages?${q}`, { headers: { 'X-Hermes-Session-Token': b.token }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`hermes history: ${r.status}`);
  const { messages } = await r.json() as { messages: StoredMsg[] };
  return cutPage(messages ?? [], offset, limit, o.before);
}
