// The Hermes gateway (the process that owns Discord/Telegram/… sessions) has its own API server. Replying to
// those conversations goes through it, so the owning process runs the turn and the session stays consistent.
import fs from 'node:fs';
import path from 'node:path';
import { hermesHome } from './platform.ts';

const ENV = path.join(hermesHome(), '.env');

function gatewayEnv(): { key?: string; base: string } {
  const env: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env */ }
  return { key: env.API_SERVER_KEY || process.env.API_SERVER_KEY, base: `http://${env.API_SERVER_HOST || '127.0.0.1'}:${env.API_SERVER_PORT || 8642}` };
}

export async function gatewayChat(sessionId: string, text: string): Promise<{ reply: string }> {
  const { key, base } = gatewayEnv();
  if (!key) throw new Error('the Hermes gateway API is not configured (API_SERVER_KEY in ~/.hermes/.env)');
  const r = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: 'POST', signal: AbortSignal.timeout(15 * 60_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text }),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message ?? data?.error ?? `gateway answered ${r.status}`);
  // Reply shape: { message: { role, content }, runtime: { provider, model }, usage }.
  const content = data.message?.content;
  return { reply: typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c.text ?? '').join('') : '' };
}

export const gatewayAvailable = () => !!gatewayEnv().key;
