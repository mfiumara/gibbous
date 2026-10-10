// One list of a thread's subagents, merged from two sources:
//  - stored: every child session Hermes wrote to state.db (/api/threads/:id/subagents), which survives reloads and
//    includes background delegations;
//  - live: subagent.* events seen while this tab was open (tool stream, status, the subagent_id needed to steer/stop).
import type { Item } from './timeline.ts';

export type LiveSub = Extract<Item, { kind: 'subagent' }>;

export interface StoredSub {
  sessionId: string; parentSessionId: string; depth: number;
  goal: string; title?: string; model?: string;
  startedAt?: number; endedAt?: number; endReason?: string;
  lastActivityAt?: number; activity?: string;
  messages: number; toolCalls: number; tokens: number; lastText?: string;
}

export type AgentState = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'quiet';

export interface Agent {
  key: string;              // stable: the child session id when known, else the live subagent id
  sessionId?: string;       // child session (transcript)
  liveId?: string;          // subagent_id for subagent.steer / subagent.interrupt
  goal: string; model?: string; depth: number;
  state: AgentState; status: string;   // normalized state + Hermes' own words
  activity?: string;        // what it is doing right now
  tools: string[]; summary?: string; lastText?: string;
  startedAt?: number; endedAt?: number; tokens?: number; toolCalls?: number;
}

// A child with no recorded end that has been silent this long is probably gone (crashed parent, killed process).
export const QUIET_MS = 5 * 60_000;

export function liveState(status: string): AgentState {
  const s = status.toLowerCase();
  if (/queue|pending|spawn/.test(s)) return 'queued';
  if (/complete|done|success/.test(s)) return 'done';
  if (/fail|error|timeout/.test(s)) return 'failed';
  if (/interrupt|cancel|stop/.test(s)) return 'stopped';
  return 'running';
}

function storedState(r: StoredSub, now: number): AgentState {
  if (r.endedAt) return /fail|error|timeout|crash/i.test(r.endReason ?? '') ? 'failed' : /interrupt|cancel|kill/i.test(r.endReason ?? '') ? 'stopped' : 'done';
  const last = r.lastActivityAt ?? r.startedAt ?? 0;
  return now - last > QUIET_MS ? 'quiet' : 'running';
}

const goalKey = (g: string) => g.replace(/\s+/g, ' ').trim().slice(0, 160);

export function mergeAgents(stored: StoredSub[], live: LiveSub[], now = Date.now()): Agent[] {
  const byChild = new Map(live.filter(l => l.childSessionId).map(l => [l.childSessionId!, l]));
  const byGoal = new Map(live.map(l => [goalKey(l.goal), l]));
  const used = new Set<LiveSub>();
  const out: Agent[] = stored.map(r => {
    const l = byChild.get(r.sessionId) ?? byGoal.get(goalKey(r.goal));
    if (l) used.add(l);
    // Live events win while they say something; a finished child is finished whatever the stream last said.
    const state = r.endedAt ? storedState(r, now) : l ? liveState(l.status) : storedState(r, now);
    return {
      key: r.sessionId, sessionId: r.sessionId, liveId: l?.id, goal: r.goal, model: r.model ?? l?.model, depth: r.depth,
      state, status: l?.status ?? r.endReason ?? (state === 'running' ? 'running' : state),
      activity: state === 'running' ? (l?.tools.at(-1) ?? r.activity) : undefined,
      tools: l?.tools ?? [], summary: l?.summary, lastText: r.lastText,
      startedAt: r.startedAt, endedAt: r.endedAt, tokens: r.tokens || l?.tokens, toolCalls: r.toolCalls,
    };
  });
  for (const l of live) {
    if (used.has(l)) continue;
    const state = liveState(l.status);
    out.push({
      key: l.childSessionId ?? l.id, sessionId: l.childSessionId, liveId: l.id, goal: l.goal, model: l.model, depth: l.depth ?? 0,
      state, status: l.status, activity: state === 'running' ? l.tools.at(-1) : undefined, tools: l.tools, summary: l.summary, tokens: l.tokens,
    });
  }
  // Siblings start within milliseconds of each other, so start order is noise: "Worker 2" before "Worker 10".
  const parentOf = new Map(stored.map(r => [r.sessionId, r.parentSessionId]));
  return out.map((a, i) => ({ a, i })).sort((x, y) =>
    (x.a.depth - y.a.depth) || String(parentOf.get(x.a.key) ?? '').localeCompare(String(parentOf.get(y.a.key) ?? ''))
    || x.a.goal.localeCompare(y.a.goal, undefined, { numeric: true }) || x.i - y.i).map(x => x.a);
}

export const isLive = (a: Agent) => a.state === 'running' || a.state === 'queued';

export function agentCounts(agents: Agent[]) {
  const c = { total: agents.length, running: 0, queued: 0, done: 0, failed: 0, other: 0 };
  for (const a of agents) {
    if (a.state === 'running') c.running++; else if (a.state === 'queued') c.queued++;
    else if (a.state === 'done') c.done++; else if (a.state === 'failed') c.failed++; else c.other++;
  }
  return c;
}

// A short, readable name. "Worker 4: rebuild …" keeps "Worker 4"; otherwise the goal's first clause, minus a leading
// "Project:" / "Project area:" label (every sibling shares it, so it says nothing): "Gibbous: make switching threads
// instant (no blank …)" → "Make switching threads instant".
export function agentName(a: Agent, i: number) {
  const goal = a.goal.replace(/\s+/g, ' ').trim();
  const worker = goal.match(/^([A-Z][\w-]*(?: [\w-]+)?\s+\d+)\s*:/);
  if (worker) return worker[1].trim();
  const body = goal.replace(/^[^:]{1,32}:\s+(?=\S)/, '');
  const clause = body.split(/\s[(—–]|[.;:!?](?:\s|$)|,\s/)[0].trim();
  const words = clause.split(' ').slice(0, 7).join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : `Subagent ${i + 1}`;
}

// The first meaningful line of a finished subagent's report, for the overview card.
export function firstLine(text?: string) {
  const line = (text ?? '').split('\n').map(l => l.replace(/^[#>*\-\s]+|\*\*|`/g, '').trim()).find(l => l.length > 3);
  return line ? line.slice(0, 220) : undefined;
}
