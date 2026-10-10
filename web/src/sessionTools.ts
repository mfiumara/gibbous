// The Sessions screen's taxonomy (pure, tested in sessionTools.test.ts): which tool ran a session, its sub-app chip
// (Discord vs Telegram, Codex Desktop vs Codex CLI vs T3 Code…), and the one line saying what importing does there.
// Shared by Sessions (Inbox.tsx) and the import picker (Welcome.tsx).

export type ToolId = 'gibbous' | 'cli' | 'desktop' | 'acp' | 'messaging' | 'api' | 'claude' | 'codex' | 'other' | 'opencode';
export interface Tool { id: ToolId; label: string; tip: string; blurb: string }

// What importing does, per kind of session.
export const SAME_LIVE = 'Opens the same session: full history and context, keeps going here.';
export const SAME_READ = 'Opens the same session with its full history, read-only: the tool that ran it keeps the conversation.';
export const SAME_CHAT = 'Opens the same chat with its full history. Replies go out through the app it came from.';
export const COPY = "Copies the conversation (your messages and the replies) so you can continue here; tool output from the original isn't copied.";

export const TOOLS: Tool[] = [
  { id: 'gibbous', label: 'Gibbous', tip: 'Threads started here', blurb: 'Threads you started here, archived ones too.' },
  { id: 'cli', label: 'Agent CLI', tip: 'Sessions from the agent in a terminal', blurb: SAME_LIVE },
  { id: 'desktop', label: 'Desktop app', tip: 'Sessions from the agent’s desktop app', blurb: SAME_LIVE },
  { id: 'acp', label: 'Paseo & editors', tip: 'Sessions driven over ACP by Paseo, Zed or an IDE', blurb: SAME_READ },
  { id: 'messaging', label: 'Messaging', tip: 'Chats from Discord, Telegram, Slack and other apps', blurb: SAME_CHAT },
  { id: 'api', label: 'API', tip: 'Sessions started through the API or a webhook', blurb: SAME_READ },
  { id: 'other', label: 'Other', tip: 'Sessions from other sources', blurb: SAME_READ },
  { id: 'claude', label: 'Claude Code', tip: 'Claude Code sessions on this Mac', blurb: COPY },
  { id: 'codex', label: 'Codex', tip: 'Codex sessions on this Mac: Codex app, CLI, T3 Code…', blurb: COPY },
  { id: 'opencode', label: 'OpenCode', tip: "OpenCode sessions on this Mac; import isn't supported yet", blurb: "Import isn't supported yet: these sessions can't be opened or copied here." },
];
export const toolInfo = (id: string) => TOOLS.find(t => t.id === id);

export const MESSAGING_SOURCES = new Set(['discord', 'telegram', 'slack', 'whatsapp', 'signal', 'matrix', 'mattermost', 'email', 'sms', 'homeassistant', 'dingtalk', 'feishu', 'wecom', 'weixin', 'qq', 'yuanbao']);

// A session source (session.list `source`) → the tool that ran it.
export function toolOf(source: string): ToolId {
  if (source === 'cli' || source === 'tui') return 'cli';
  if (source === 'desktop') return 'desktop';
  if (source === 'acp') return 'acp';
  if (MESSAGING_SOURCES.has(source)) return 'messaging';
  if (source === 'api_server' || source === 'webhook') return 'api';
  if (source === 'claude_code') return 'claude';
  if (source === 'codex') return 'codex';
  return 'other';
}

export interface App { key: string; label: string }
// Codex logs name the program that wrote them (`originator`).
export function codexApp(originator?: string): App {
  const o = (originator ?? '').trim();
  if (o === 'Codex Desktop') return { key: 'desktop', label: 'Codex app' };
  if (o === 'codex-tui' || o === 'codex_cli_rs') return { key: 'cli', label: 'Codex CLI' };
  if (o === 'codex_exec') return { key: 'exec', label: 'codex exec' };
  if (/^t3code/i.test(o)) return { key: 't3', label: 'T3 Code' };
  if (/vscode|ide/i.test(o)) return { key: 'ide', label: 'Editor extension' };
  return { key: 'other', label: o ? 'Other apps' : 'Unknown app' };
}
// Claude Code logs carry an `entrypoint`: the CLI itself, or the Agent SDK (Paseo and other apps drive it that way).
export function claudeApp(entrypoint?: string): App {
  const e = (entrypoint ?? '').trim();
  if (e === 'cli') return { key: 'cli', label: 'Claude Code CLI' };
  if (e.startsWith('sdk')) return { key: 'sdk', label: 'Via SDK (Paseo, apps)' };
  if (/desktop/.test(e)) return { key: 'desktop', label: 'Claude desktop' };
  if (/vscode|jetbrains|ide/.test(e)) return { key: 'ide', label: 'Editor extension' };
  return { key: 'other', label: e ? 'Other apps' : 'Unknown app' };
}

// Chips under a tool: [key, label, count], most used first; the raw names behind "Other apps" go in `raw`.
export interface Chip { key: string; label: string; n: number; raw: string[] }
export function chipsOf<T>(xs: T[], app: (x: T) => App & { raw?: string }): Chip[] {
  const m = new Map<string, Chip>();
  for (const x of xs) {
    const a = app(x), c = m.get(a.key) ?? { key: a.key, label: a.label, n: 0, raw: [] };
    c.n++; if (a.raw && !c.raw.includes(a.raw)) c.raw.push(a.raw);
    m.set(a.key, c);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

// "120" or "300+" when a list stopped at its page cap.
export const countLabel = (n: number, more?: boolean) => `${n}${more ? '+' : ''}`;
