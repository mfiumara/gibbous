// Short thread titles: Gibbous asks Hermes' title model (llm.oneshot, the `title_generation` aux task) for a 2–4 word
// name based on the thread's opening message. Hermes' own titles run 3–7 words, too long for the sidebar.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHORT_TITLE_PROMPT = [
  'You name chat threads for a narrow sidebar. Given the user\'s opening message, reply with a title of 2 to 4 words.',
  'Rules: name what the user wants done; keep exact technical names (products, files, error codes); sentence case;',
  'no filler words (the, a, my, this, please); no quotes, no trailing punctuation, no prefix.',
  'Examples: "Subscription model picker", "Fix mobile layout", "Disk cleanup", "Explain weird PCB colors".',
  'Reply with the title only.',
].join(' ');

// The model's reply → a sidebar title, or undefined when it answered instead of naming.
export function cleanTitle(raw: string): string | undefined {
  let t = raw.replace(/```\w*/g, '').trim().split('\n').find(l => l.trim())?.trim() ?? '';
  try { const j = JSON.parse(t); if (j && typeof j.title === 'string') t = j.title; } catch { /* plain text */ }
  t = t.replace(/^(title|thread)\s*:\s*/i, '').replace(/^["'“‘`*]+|["'”’`*.!?:;,]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 6 || t.length > 48) return undefined;
  return t[0].toUpperCase() + t.slice(1);
}

const dbs = new Map<string, DatabaseSync>();
function open(profile?: string) {
  const home = process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes');
  const file = profile && profile !== 'default' ? path.join(home, 'profiles', profile, 'state.db') : path.join(home, 'state.db');
  if (!fs.existsSync(file)) return undefined;
  let db = dbs.get(file);
  if (!db) { db = new DatabaseSync(file, { readOnly: true }); db.exec('PRAGMA busy_timeout = 2000'); dbs.set(file, db); }
  return db;
}

// The first real user message of a stored session (state.db, read-only); attachment lines are dropped.
export function openingMessage(sessionId: string, profile?: string): string | undefined {
  const row = open(profile)?.prepare(`SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND COALESCE(content, '') != ''
    AND COALESCE(display_kind, '') NOT IN ('hidden', 'internal_notification') ORDER BY id LIMIT 1`).get(sessionId) as { content?: string } | undefined;
  const text = typeof row?.content === 'string' ? row.content : '';
  const body = text.split('\n').filter(l => !/^@(image|file|folder):|^\[screenshot\]/.test(l.trim())).join('\n').trim();
  return body ? body.slice(0, 2000) : undefined;
}
