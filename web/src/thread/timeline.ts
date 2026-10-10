// Turns Hermes transcript rows + live events into timeline items. Pure, so it can be tested in isolation.
import type { HermesEvent } from '../rpc';
import type { TranscriptMessage, Usage, SessionLiveInfo, RollbackCheckpoint } from '../hermes/contract';

export type Item =
  | { kind: 'user'; id: string; text: string; rowId?: number; at?: number }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming?: boolean }
  | { kind: 'tool'; id: string; name: string; context?: string; args?: Record<string, unknown>; status: 'running' | 'done' | 'error';
      duration?: number; result?: unknown; resultText?: string; diff?: string; summary?: string }
  | { kind: 'subagent'; id: string; goal: string; status: string; summary?: string; tools: string[]; model?: string;
      childSessionId?: string; tokens?: number; duration?: number; index: number; count: number; parentId?: string; depth?: number }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' }
  | { kind: 'side'; id: string; mode: 'btw' | 'background'; question: string; text?: string }
  | { kind: 'turn'; id: string; ms?: number; tokens?: number; cost?: number; at?: number };   // footer under a finished reply; at = end (ms)

export interface Timeline {
  items: Item[]; running: boolean; status?: string; turnStartedAt?: number;
  usage?: Usage; info?: SessionLiveInfo; todos?: Record<string, unknown>[];
  compacting?: boolean; // Hermes is summarizing earlier context (auto-compaction or /compress)
}

let n = 0;
const uid = (p: string) => `${p}-${++n}`;

// A finished turn gets a duration footer: its first row to its last (the in-flight turn, if running, does not).
export function fromHistory(messages: TranscriptMessage[], running = false): Item[] {
  const items: Item[] = [];
  let start: number | undefined, end: number | undefined;
  const footer = () => { if (start && end && end > start) items.push({ kind: 'turn', id: uid('tn'), ms: (end - start) * 1000, at: end * 1000 }); };
  for (const m of messages) {
    if (m.display_kind === 'hidden') continue;
    // A queued prompt Hermes stored at accept time but never ran (a Stop drops the queue and leaves the row behind);
    // once it runs, its row loses the flag. Waiting ones show in the composer's queue box instead.
    if (m.role === 'user' && (m.display_metadata as { _queued_prompt?: boolean } | undefined)?._queued_prompt) continue;
    if (m.role === 'user') {
      footer(); start = m.timestamp ?? undefined; end = undefined;
      const meta = m.display_metadata as { display_text?: string } | undefined;
      items.push({ kind: 'user', id: `r${m.row_id ?? uid('u')}`, text: meta?.display_text ?? String(m.text ?? ''), rowId: m.row_id ?? undefined, at: m.timestamp ? m.timestamp * 1000 : undefined });
      continue;
    }
    end = m.timestamp ?? end;
    if (m.role === 'assistant') {
      if (m.reasoning) items.push({ kind: 'reasoning', id: uid('rs'), text: String(m.reasoning) });
      if (m.text) items.push({ kind: 'assistant', id: `r${m.row_id ?? uid('a')}`, text: String(m.text) });
    } else if (m.role === 'tool') {
      items.push({
        kind: 'tool', id: String(m.tool_call_id ?? uid('t')), name: String(m.name ?? 'tool'), context: m.context ?? undefined,
        args: m.args ?? undefined, status: 'done',
      });
    }
  }
  if (!running) footer();
  return items;
}

// Attaching mid-turn: add the in-flight turn's user prompt and partial reply. Hermes persists the user row when the
// turn starts, so history usually has it already, but with attachment refs (@image:…) the in-flight copy lacks; compare bodies.
export function withInflight(items: Item[], fl: { user?: string | null; assistant?: string | null; display_kind?: string | null; streaming?: boolean } | null | undefined, running: boolean): Item[] {
  if (!fl || !(fl.streaming || running)) return items;
  const lastUser = items.findLast(i => i.kind === 'user');
  const body = (s: string) => parseUserText(s).body;
  if (fl.user && fl.display_kind !== 'hidden' && (!lastUser || body(lastUser.text) !== body(fl.user))) items = [...items, { kind: 'user', id: 'inflight-u', text: fl.user }];
  if (fl.assistant) items = [...items, { kind: 'assistant', id: 'inflight-a', text: fl.assistant, streaming: true }];
  return items;
}

// Stored rows from Hermes' read-only REST transcript (used for sessions Gibbous doesn't own, e.g. Discord).
export interface StoredRow {
  id: number; role: string; content?: unknown; tool_calls?: { id?: string; call_id?: string; function?: { name?: string; arguments?: string } }[] | null;
  tool_call_id?: string | null; tool_name?: string | null; reasoning?: string | null; display_kind?: string | null; display_metadata?: any;
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p?.type === 'text' ? p.text : p?.type?.includes('image') ? '[image]' : '').filter(Boolean).join('\n') : '';

export function fromStored(rows: StoredRow[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  for (const m of rows) {
    if (m.display_kind === 'hidden') continue;
    if (m.display_kind === 'internal_notification') {
      items.push({ kind: 'notice', id: `s${m.id}`, text: textOf(m.content).replace(/^\[IMPORTANT:\s*/, '').split('\n')[0].slice(0, 200), tone: 'info' });
    } else if (m.role === 'user') {
      items.push({ kind: 'user', id: `s${m.id}`, text: m.display_metadata?.display_text ?? textOf(m.content) });
    } else if (m.role === 'assistant') {
      if (m.reasoning) items.push({ kind: 'reasoning', id: `sr${m.id}`, text: m.reasoning });
      const text = textOf(m.content);
      if (text.trim()) items.push({ kind: 'assistant', id: `s${m.id}`, text });
      for (const c of m.tool_calls ?? []) {
        let args: Record<string, unknown> | undefined;
        try { args = JSON.parse(c.function?.arguments ?? 'null') ?? undefined; } catch { args = undefined; }
        const tool: Extract<Item, { kind: 'tool' }> = { kind: 'tool', id: c.id ?? c.call_id ?? `st${m.id}`, name: c.function?.name ?? 'tool', args, status: 'done' };
        tools.set(tool.id, tool);
        items.push(tool);
      }
    } else if (m.role === 'tool') {
      const t = m.tool_call_id ? tools.get(m.tool_call_id) : undefined;
      let result: unknown = textOf(m.content);
      try { result = JSON.parse(result as string); } catch { /* plain text result */ }
      if (t) Object.assign(t, { result, status: result && typeof result === 'object' && ((result as any).error || ((result as any).exit_code ?? 0) !== 0) ? 'error' : 'done' });
      else items.push({ kind: 'tool', id: `s${m.id}`, name: m.tool_name ?? 'tool', status: 'done', result });
    }
  }
  return items;
}

// Strip ANSI colouring Hermes adds to inline diffs for the terminal.
export const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

// Hermes' spinner sends "(⊙_⊙) pondering..." (agent/display.py THINKING_VERBS). Gibbous drops the kaomoji and
// renames the idle verb to a moon word, stable per Hermes verb so it doesn't flicker. Real statuses
// ("Reading files") pass through untouched.
export const MOON_VERBS = ['Waxing', 'Waning', 'Orbiting', 'Eclipsing', 'Librating', 'Reflecting', 'Cresting', 'Rising', 'Transiting', 'Tiding', 'Moonlighting', 'Phasing'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);   // every status line starts with a capital
export function moonStatus(text: string): string | undefined {
  const s = text.replace(/^.*\s(?=\p{L}+(\.\.\.|…)$)/u, '');
  const m = /^(\p{L}+)(?:\.\.\.|…)$/u.exec(s);
  if (!m) return cap(s) || undefined;
  let h = 0; for (const c of m[1].toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${MOON_VERBS[h % MOON_VERBS.length]}…`;
}

const last = (items: Item[]) => items[items.length - 1];

function appendStream(items: Item[], kind: 'assistant' | 'reasoning', text: string): Item[] {
  const l = last(items);
  if (l && l.kind === kind && l.streaming) return [...items.slice(0, -1), { ...l, text: l.text + text }];
  if (!text.trim()) return items;
  return [...items, { kind, id: uid(kind[0]), text: text.replace(/^\n+/, ''), streaming: true }];
}

const seal = (items: Item[]) => items.map(i => (i.kind === 'assistant' || i.kind === 'reasoning') && i.streaming ? { ...i, streaming: false } : i);

// Status kinds Hermes uses while compaction runs: auto ("compacting") and manual /compress ("compressing").
// The next status of any other kind ("compacted", a tool, …) or the end of the turn means it finished.
export const isCompacting = (kind: unknown) => kind === 'compacting' || kind === 'compressing';

export function reduce(t: Timeline, ev: HermesEvent): Timeline {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case 'message.start':
      return { ...t, running: true, status: undefined, turnStartedAt: t.running ? t.turnStartedAt : Date.now() };
    case 'thinking.delta':
      return { ...t, status: moonStatus(String(p.text ?? '')) };
    case 'status.update':
      return { ...t, status: p.text ? cap(p.text) : undefined, compacting: isCompacting(p.kind) };
    case 'reasoning.delta':
      return { ...t, items: appendStream(t.items, 'reasoning', p.text ?? '') };
    case 'reasoning.available': {
      // Non-streaming providers send the whole block; streaming ones repeat it (or the reply), so only add if nothing streamed.
      const streamedThisTurn = t.items.some(i => (i.kind === 'reasoning' || i.kind === 'assistant') && i.streaming);
      return streamedThisTurn ? t : { ...t, items: [...t.items, { kind: 'reasoning', id: uid('rs'), text: p.text ?? '' }] };
    }
    case 'message.delta': {
      const items = last(t.items)?.kind === 'reasoning' ? seal(t.items) : t.items;
      return { ...t, items: appendStream(items, 'assistant', p.text ?? '') };
    }
    case 'message.interim': {
      if (p.already_streamed) return { ...t, items: seal(t.items) };
      return { ...t, items: [...seal(t.items), { kind: 'assistant', id: uid('a'), text: p.text }] };
    }
    case 'tool.generating':
      return { ...t, status: `Preparing ${String(p.name ?? 'tool').replace(/^mcp__/, '')}…` };
    case 'tool.start':
      return {
        ...t, status: undefined,
        items: [...seal(t.items), { kind: 'tool', id: p.tool_id, name: p.name, context: p.context ?? undefined, args: p.args ?? undefined, status: 'running' }],
      };
    case 'tool.complete': {
      const err = (p.result && typeof p.result === 'object' && ((p.result as any).error || ((p.result as any).exit_code ?? 0) !== 0));
      const patch = {
        status: err ? 'error' : 'done', duration: p.duration_s ?? undefined, result: p.result, resultText: p.result_text ?? undefined,
        diff: p.inline_diff ? stripAnsi(p.inline_diff) : undefined, summary: p.summary ?? undefined,
      } as const;
      const found = t.items.some(i => i.kind === 'tool' && i.id === p.tool_id);
      return {
        ...t,
        items: found ? t.items.map(i => i.kind === 'tool' && i.id === p.tool_id ? { ...i, ...patch } : i)
          : [...t.items, { kind: 'tool', id: p.tool_id, name: p.name, args: p.args ?? undefined, ...patch }],
      };
    }
    case 'subagent.start': case 'subagent.progress': case 'subagent.tool': case 'subagent.thinking': case 'subagent.complete': {
      const id = p.subagent_id ?? `${p.delegation_id ?? 'd'}-${p.task_index}`;
      const prev = t.items.find(i => i.kind === 'subagent' && i.id === id) as Extract<Item, { kind: 'subagent' }> | undefined;
      const next: Item = {
        kind: 'subagent', id, goal: p.goal ?? prev?.goal ?? '', index: p.task_index ?? prev?.index ?? 0, count: p.task_count ?? prev?.count ?? 1,
        status: ev.type === 'subagent.complete' ? (p.status ?? 'completed') : (p.status ?? prev?.status ?? 'running'),
        summary: p.summary ?? prev?.summary, model: p.model ?? prev?.model, childSessionId: p.child_session_id ?? prev?.childSessionId,
        tools: ev.type === 'subagent.tool' && p.tool_name ? [...(prev?.tools ?? []), `${p.tool_name}${p.tool_preview ? ` · ${p.tool_preview}` : ''}`].slice(-8) : (prev?.tools ?? []),
        tokens: (p.input_tokens ?? 0) + (p.output_tokens ?? 0) || prev?.tokens, duration: p.duration_seconds ?? prev?.duration,
        parentId: p.parent_id ?? prev?.parentId, depth: p.depth ?? prev?.depth,
      };
      return { ...t, items: prev ? t.items.map(i => i === prev ? next : i) : [...t.items, next] };
    }
    case 'message.complete': {
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      let items = t.items;
      const l = [...items].reverse().find(i => i.kind === 'assistant');
      const streaming = l && l.kind === 'assistant' && l.streaming;
      if (streaming && text) items = items.map(i => i === l ? { ...l, text } : i);
      else if (!streaming && text && !(l && l.kind === 'assistant' && l.text.trim() === text)) items = [...items, { kind: 'assistant', id: uid('a'), text }];
      items = seal(items).map(i => i.kind === 'tool' && i.status === 'running' ? { ...i, status: 'done' as const } : i);
      if (p.status === 'error') items = [...items, { kind: 'notice', id: uid('n'), text: p.error || p.failure_reason || 'The turn failed.', tone: 'error' }];
      if (p.status === 'interrupted') items = [...items, { kind: 'notice', id: uid('n'), text: 'Stopped.', tone: 'info' }];
      if (p.warning) items = [...items, { kind: 'notice', id: uid('n'), text: p.warning, tone: 'info' }];
      // Usage is the session's running total; the turn's share is the difference.
      const u = p.usage as Usage | undefined, was = t.usage;
      const tokens = u?.total != null && was?.total != null ? u.total - was.total : undefined;
      const cost = u?.cost_usd != null && was?.cost_usd != null ? u.cost_usd - was.cost_usd : undefined;
      if (t.turnStartedAt || tokens) items = [...items, { kind: 'turn', id: uid('tn'), at: Date.now(), ms: t.turnStartedAt ? Date.now() - t.turnStartedAt : undefined, tokens: tokens && tokens > 0 ? tokens : undefined, cost: cost && cost > 0 ? cost : undefined }];
      return { ...t, items, running: false, status: undefined, usage: p.usage ?? t.usage, turnStartedAt: undefined, compacting: false };
    }
    case 'error':
      return { ...t, running: false, items: [...seal(t.items), { kind: 'notice', id: uid('n'), text: p.message ?? 'Error', tone: 'error' }] };
    case 'notice':
      return p.text ? { ...t, items: [...t.items, { kind: 'notice', id: uid('n'), text: p.text, tone: 'info' }] } : t;
    case 'btw.complete': case 'background.complete': {
      const id = `side-${p.task_id}`;
      const mode = ev.type === 'btw.complete' ? 'btw' : 'background';
      const done = { kind: 'side' as const, id, mode: mode as 'btw' | 'background', question: p.question ?? '', text: p.text ?? '' };
      const has = t.items.some(i => i.id === id);
      return { ...t, items: has ? t.items.map(i => i.id === id ? { ...done, question: (i as any).question || done.question } : i) : [...t.items, done] };
    }
    case 'session.usage':
      return { ...t, usage: p.usage ?? t.usage };
    case 'session.info':
      return { ...t, info: p };
    case 'todo.updated':
      return { ...t, todos: p.todos ?? p.state?.todos ?? t.todos };
    default:
      return t;
  }
}

// The checkpoint Hermes took during a turn is the first one after that turn's user message.
export function checkpointFor(turnAt: number | undefined, nextAt: number | undefined, cps: RollbackCheckpoint[]) {
  if (!turnAt) return undefined;
  return cps.map(c => ({ c, t: Date.parse(c.timestamp ?? '') })).filter(x => x.t >= turnAt - 2000 && (!nextAt || x.t < nextAt)).sort((a, b) => a.t - b.t)[0]?.c;
}

// What you wrote, split from what came along: attached images and files become chips, and the file contents Hermes
// appends for the model ("--- Attached Context ---") are dropped from the bubble.
export function parseUserText(text: string) {
  const images: string[] = [], files: string[] = [];
  const [mine, context = ''] = text.split(/\n-{3} Attached Context -{3}\n/);
  for (const m of context.matchAll(/^@image:(\S+)/gm)) images.push(m[1]);
  const body = mine.split('\n').filter(l => {
    const t = l.trim();
    const img = /^@image:(\S+)$/.exec(t); if (img) { images.push(img[1]); return false; }
    const file = /^@file:(\S+)$/.exec(t); if (file) { files.push(file[1]); return false; }   // a ref on its own line is an attachment
    return t !== '[screenshot]';
  }).join('\n').replace(/@file:(\S+)/g, (_, p) => p.split('/').pop()!).trim();   // inline mentions read as names
  return { images, files, body };
}

// A queued message the Gibbous server just handed to Hermes (its `queueSent` event): show it as sent, once. A resume
// that landed first already has it as the in-flight user row (after the last reply), so that one isn't doubled.
export function withQueuedBubble(items: Item[], m: { id: string; shown: string; at?: number }): Item[] {
  const id = `sent-${m.id}`;
  if (items.some(i => i.id === id)) return items;
  const lastUser = items.findLastIndex(i => i.kind === 'user'), lastReply = items.findLastIndex(i => i.kind === 'assistant' || i.kind === 'turn');
  const u = items[lastUser];
  if (u?.kind === 'user' && lastUser > lastReply && parseUserText(u.text).body === parseUserText(m.shown).body) return items;
  return [...items, { kind: 'user', id, text: m.shown, at: m.at ?? Date.now() }];
}

// Turn-footer tooltip: just the time for today's turns, the day too for older ones, the year only when it differs.
export function endedLabel(at: number, now = Date.now()): string {
  const d = new Date(at), n = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === n.toDateString()) return `Ended at ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) });
  return `Ended ${day}, ${time}`;
}
