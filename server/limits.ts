// Account limits (the 5-hour session and weekly windows a ChatGPT/Codex or Claude login has), the same numbers
// CodexBar shows. Hermes already fetches them for `/usage` (agent/account_usage.py, fetch_account_usage); Gibbous asks
// it through Hermes' own Python, read-only (never refreshes or rotates a credential), cached for two minutes.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hermesHome } from './platform.ts';

export interface LimitWindow { label: string; usedPercent: number | null; resetAt: number | null; scope: string; detail: string | null; windowSeconds: number | null }
export interface AccountLimits { provider: string; label: string; plan: string | null; windows: LimitWindow[]; details: string[]; unavailable: string | null; fetchedAt: number; resets: number | null }

// The logins worth asking about: subscription providers Hermes knows how to read. Unknown/unused ones answer nothing.
export const LIMIT_PROVIDERS: Record<string, string> = { 'openai-codex': 'Codex', anthropic: 'Claude', nous: 'Nous' };

const PY = `import json,sys
from agent.account_usage import fetch_account_usage
out=[]
for p in json.load(sys.stdin):
    try: s=fetch_account_usage(p, read_only=True)
    except Exception as e: s=None
    if not s: continue
    raw=s.raw or {}
    rl=raw.get('rate_limit') or {}
    rawwins=[x for x in (rl.get('primary_window'),rl.get('secondary_window')) if isinstance(x,dict)]
    def secs(w):
        # The window's length: Codex says it (limit_window_seconds, matched by reset time); else None.
        t=w.reset_at.timestamp() if w.reset_at else None
        for x in rawwins:
            if t is not None and isinstance(x.get('reset_at'),(int,float)) and abs(x['reset_at']-t)<120: return x.get('limit_window_seconds')
        return None
    credits=(raw.get('rate_limit_reset_credits') or {}).get('available_count')
    out.append({'provider':p,'plan':s.plan,'details':list(s.details or ()),'unavailable':s.unavailable_reason,'resets':credits if isinstance(credits,int) else None,
      'windows':[{'label':w.label,'usedPercent':w.used_percent,'resetAt':w.reset_at.timestamp()*1000 if w.reset_at else None,'scope':w.scope,'detail':w.detail,'windowSeconds':secs(w)} for w in s.windows]})
print(json.dumps(out))`;

export function hermesPython(): string | undefined {
  const root = path.join(hermesHome(), 'hermes-agent');
  return [path.join(root, 'venv', 'bin', 'python'), path.join(root, '.venv', 'bin', 'python'), path.join(root, 'venv', 'Scripts', 'python.exe')].find(f => fs.existsSync(f));
}

export function parseLimits(out: string, now = Date.now()): AccountLimits[] {
  const rows = JSON.parse(out.trim().split('\n').pop() || '[]') as any[];
  return rows.filter(r => r && LIMIT_PROVIDERS[r.provider] && (r.windows?.length || r.unavailable)).map(r => ({
    provider: r.provider, label: LIMIT_PROVIDERS[r.provider], plan: r.plan ?? null, unavailable: r.unavailable ?? null, fetchedAt: now,
    resets: typeof r.resets === 'number' ? r.resets : null,
    // The banked-resets line is shown as a count with its own button; Hermes' CLI wording ("use /usage reset") isn't.
    details: (r.details ?? []).map(String).filter((d: string) => !(typeof r.resets === 'number' && /resets? banked/i.test(d))),
    windows: (r.windows ?? []).map((w: any) => ({ label: String(w.label), usedPercent: typeof w.usedPercent === 'number' ? w.usedPercent : null, resetAt: typeof w.resetAt === 'number' ? w.resetAt : null, scope: String(w.scope ?? 'account'), detail: w.detail ?? null,
      windowSeconds: typeof w.windowSeconds === 'number' ? w.windowSeconds : /session|5.?h/i.test(String(w.label)) ? 5 * 3600 : /week/i.test(String(w.label)) ? 7 * 86400 : null })),
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

// Redeem one banked Codex reset (Hermes' redeem_codex_reset_credit, the `/usage reset` path). Hermes refuses unless a
// window is fully used (a reset restores the whole allowance); `force` redeems anyway. The UI confirms both steps.
const RESET_PY = `import json,sys
from agent.account_usage import redeem_codex_reset_credit
a=json.load(sys.stdin)
r=redeem_codex_reset_credit(force=bool(a.get('force')))
print(json.dumps({'status':r.status,'available':getattr(r,'available_count',None),'windowsReset':getattr(r,'windows_reset',None)}))`;
export interface ResetResult { status: string; available: number | null; windowsReset: number | null }
export function redeemCodexReset(force: boolean): Promise<ResetResult> {
  const py = hermesPython();
  if (!py) return Promise.reject(new Error('Hermes is not installed here'));
  return new Promise((resolve, reject) => {
    const p = execFile(py, ['-c', RESET_PY], { cwd: path.dirname(path.dirname(path.dirname(py))), timeout: 60_000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) return reject(new Error('Could not reach Hermes to redeem the reset'));
      try { const r = JSON.parse(out.trim().split('\n').pop() ?? '{}'); cache = undefined; resolve({ status: String(r.status), available: r.available ?? null, windowsReset: r.windowsReset ?? null }); }
      catch { reject(new Error('Unexpected answer from Hermes')); }
    });
    p.stdin?.end(JSON.stringify({ force }));
  });
}
