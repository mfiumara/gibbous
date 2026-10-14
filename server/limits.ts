// Account limits (the 5-hour session and weekly windows a ChatGPT/Codex or Claude login has), the same numbers
// CodexBar shows. Hermes already fetches them for `/usage` (agent/account_usage.py, fetch_account_usage); Gibbous asks
// it through Hermes' own Python, read-only (never refreshes or rotates a credential), cached for two minutes.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hermesHome } from './platform.ts';

export interface LimitWindow { label: string; usedPercent: number | null; resetAt: number | null; scope: string; detail: string | null }
export interface AccountLimits { provider: string; label: string; plan: string | null; windows: LimitWindow[]; details: string[]; unavailable: string | null; fetchedAt: number }

// The logins worth asking about: subscription providers Hermes knows how to read. Unknown/unused ones answer nothing.
export const LIMIT_PROVIDERS: Record<string, string> = { 'openai-codex': 'Codex', anthropic: 'Claude', nous: 'Nous' };

const PY = `import json,sys
from agent.account_usage import fetch_account_usage
out=[]
for p in json.load(sys.stdin):
    try: s=fetch_account_usage(p, read_only=True)
    except Exception as e: s=None
    if not s: continue
    out.append({'provider':p,'plan':s.plan,'details':list(s.details or ()),'unavailable':s.unavailable_reason,
      'windows':[{'label':w.label,'usedPercent':w.used_percent,'resetAt':w.reset_at.timestamp()*1000 if w.reset_at else None,'scope':w.scope,'detail':w.detail} for w in s.windows]})
print(json.dumps(out))`;

export function hermesPython(): string | undefined {
  const root = path.join(hermesHome(), 'hermes-agent');
  return [path.join(root, 'venv', 'bin', 'python'), path.join(root, '.venv', 'bin', 'python'), path.join(root, 'venv', 'Scripts', 'python.exe')].find(f => fs.existsSync(f));
}

export function parseLimits(out: string, now = Date.now()): AccountLimits[] {
  const rows = JSON.parse(out.trim().split('\n').pop() || '[]') as any[];
  return rows.filter(r => r && LIMIT_PROVIDERS[r.provider] && (r.windows?.length || r.unavailable)).map(r => ({
    provider: r.provider, label: LIMIT_PROVIDERS[r.provider], plan: r.plan ?? null, details: (r.details ?? []).map(String), unavailable: r.unavailable ?? null, fetchedAt: now,
    windows: (r.windows ?? []).map((w: any) => ({ label: String(w.label), usedPercent: typeof w.usedPercent === 'number' ? w.usedPercent : null, resetAt: typeof w.resetAt === 'number' ? w.resetAt : null, scope: String(w.scope ?? 'account'), detail: w.detail ?? null })),
  }));
}

let cache: { at: number; v: AccountLimits[] } | undefined, inflight: Promise<AccountLimits[]> | undefined;
export function accountLimits(fresh = false, now = Date.now()): Promise<AccountLimits[]> {
  if (cache && now - cache.at < (fresh ? 20_000 : 120_000)) return Promise.resolve(cache.v);
  if (inflight) return inflight;
  const py = hermesPython();
  if (!py) return Promise.resolve([]);
  inflight = new Promise<AccountLimits[]>(resolve => {
    const p = execFile(py, ['-c', PY], { cwd: path.dirname(path.dirname(path.dirname(py))), timeout: 45_000, maxBuffer: 1 << 20 }, (err, out) => {
      let v: AccountLimits[] = cache?.v ?? [];
      if (!err) try { v = parseLimits(out); cache = { at: Date.now(), v }; } catch { /* keep the last answer */ }
      resolve(v);
    });
    p.stdin?.end(JSON.stringify(Object.keys(LIMIT_PROVIDERS)));
  }).finally(() => { inflight = undefined; });
  return inflight;
}
