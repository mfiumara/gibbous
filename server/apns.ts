// Apple Push (APNs) for the iOS shell: token-based auth (ES256 JWT from a .p8 key) over HTTP/2.
// Config lives in GIBBOUS_HOME/apns.json: { keyId, teamId, bundleId, keyPath, production? }.
// No (valid) config → APNs is silently off. Nothing in here ever throws into notify().
import fs from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { GIBBOUS_HOME } from './store.ts';

export type ApnsEnv = 'sandbox' | 'production';
export interface ApnsDevice { token: string; env: ApnsEnv; at: number }
export interface ApnsConfig { keyId: string; teamId: string; bundleId: string; keyPath: string; production?: boolean }
export interface SendResult { ok: boolean; status: number; reason?: string }
export interface SendOpts { collapseId?: string; threadId?: string }
export type Sender = (token: string, env: ApnsEnv, payload: ApnsPayload, opts?: SendOpts) => Promise<SendResult>;
// A badge-only payload (`{aps:{badge}}`) updates the icon count without showing anything.
export interface ApnsPayload { aps: { alert?: { title: string; body: string }; sound?: string; 'thread-id'?: string; 'mutable-content'?: 0 | 1; badge?: number }; url?: string }

const HOSTS: Record<ApnsEnv, string> = { sandbox: 'api.sandbox.push.apple.com', production: 'api.push.apple.com' };
const TIMEOUT_MS = 10_000, IDLE_MS = 5 * 60_000, JWT_TTL_MS = 50 * 60_000, EXPIRATION_S = 3600;

// ── validation ──────────────────────────────────────────────────────────
export const validToken = (t: unknown): t is string => typeof t === 'string' && /^[0-9a-fA-F]{64,200}$/.test(t);
export const validEnv = (e: unknown): e is ApnsEnv => e === 'sandbox' || e === 'production';
export function parseDevice(b: any): { token: string; env: ApnsEnv } | null {
  return validToken(b?.token) && validEnv(b?.env) ? { token: b.token.toLowerCase(), env: b.env } : null;
}

// ── config ──────────────────────────────────────────────────────────────
interface Loaded { cfg: ApnsConfig; key: KeyObject }
let configHome = GIBBOUS_HOME;
let cache: { file: string; stamp: string; loaded: Loaded | null } | undefined;
// Re-read when apns.json (or the key) changes, so adding a key needs no restart.
export function loadConfig(home = configHome): Loaded | null {
  const file = path.join(home, 'apns.json');
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) { cache = { file, stamp: '', loaded: null }; return null; }
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return remember(file, `${st.mtimeMs}`, null, 'apns.json is not valid JSON'); }
  const keyPath = typeof raw?.keyPath === 'string' ? path.resolve(home, raw.keyPath.replace(/^~(?=\/)/, process.env.HOME ?? '~')) : '';
  const kst = keyPath ? fs.statSync(keyPath, { throwIfNoEntry: false }) : undefined;
  const stamp = `${st.mtimeMs}:${keyPath}:${kst?.mtimeMs ?? 0}`;
  if (cache?.file === file && cache.stamp === stamp) return cache.loaded;
  for (const k of ['keyId', 'teamId', 'bundleId', 'keyPath'] as const) if (typeof raw?.[k] !== 'string' || !raw[k]) return remember(file, stamp, null, `apns.json: missing ${k}`);
  if (!kst) return remember(file, stamp, null, 'apns.json: keyPath not found');
  try {
    const key = createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
    if (key.asymmetricKeyType !== 'ec') return remember(file, stamp, null, 'apns.json: key is not an EC (.p8) key');
    const cfg: ApnsConfig = { keyId: raw.keyId, teamId: raw.teamId, bundleId: raw.bundleId, keyPath, ...(typeof raw.production === 'boolean' ? { production: raw.production } : {}) };
    return remember(file, stamp, { cfg, key });
  } catch { return remember(file, stamp, null, 'apns.json: could not read the .p8 key'); }
}
let warned = '';
function remember(file: string, stamp: string, loaded: Loaded | null, why?: string) {
  if (why && why !== warned) console.warn(`[apns] disabled: ${why}`);
  warned = why ?? '';
  if (cache?.loaded?.key !== loaded?.key) jwt = undefined;
  cache = { file, stamp, loaded };
  return loaded;
}
export const configured = () => { try { return !!loadConfig(); } catch { return false; } };

// ── JWT (ES256, raw r||s signature) ─────────────────────────────────────
const b64u = (x: string | Buffer) => Buffer.from(x).toString('base64url');
export function makeJwt(keyId: string, teamId: string, key: KeyObject, iat = Math.floor(Date.now() / 1000)) {
  const input = `${b64u(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64u(JSON.stringify({ iss: teamId, iat }))}`;
  const sig = createSign('SHA256').update(input).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64u(sig)}`;
}
let jwt: { token: string; at: number; kid: string } | undefined;
function bearer(l: Loaded, now = Date.now()) {
  if (!jwt || jwt.kid !== `${l.cfg.teamId}/${l.cfg.keyId}` || now - jwt.at > JWT_TTL_MS)
    jwt = { token: makeJwt(l.cfg.keyId, l.cfg.teamId, l.key, Math.floor(now / 1000)), at: now, kid: `${l.cfg.teamId}/${l.cfg.keyId}` };
  return jwt.token;
}

// ── payload ─────────────────────────────────────────────────────────────
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export function buildPayload(n: { title: string; body: string; url?: string; tag?: string; kind: string }, badge?: number): ApnsPayload {
  return {
    aps: { alert: { title: clip(String(n.title ?? ''), 200), body: clip(String(n.body ?? ''), 1500) }, sound: 'default', 'thread-id': n.tag ?? n.kind, 'mutable-content': 0, ...(badge != null ? { badge } : {}) },
    ...(n.url ? { url: n.url } : {}),
  };
}

// 410 Unregistered, or a token that can never work for this app.
export const shouldDrop = (r: SendResult) =>
  r.status === 410 || (r.status === 400 && (r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic'));

// ── HTTP/2 ──────────────────────────────────────────────────────────────
// Testing-only override: route every request to one host (e.g. a local http2 server) with an extra CA.
let override: { host: string; ca?: string | Buffer } | undefined =
  process.env.GIBBOUS_APNS_HOST ? { host: process.env.GIBBOUS_APNS_HOST, ca: process.env.GIBBOUS_APNS_CA ? fs.readFileSync(process.env.GIBBOUS_APNS_CA) : undefined } : undefined;
export const testing = {
  setEndpoint(o: { host: string; ca?: string | Buffer } | undefined) { override = o; closeAll(); },
  resetJwt() { jwt = undefined; },
  setHome(dir: string | undefined) { configHome = dir ?? GIBBOUS_HOME; },
  closeAll: () => closeAll(),
};

const sessions = new Map<string, http2.ClientHttp2Session>();
function closeAll() { for (const s of sessions.values()) s.close(); sessions.clear(); }
function session(host: string): http2.ClientHttp2Session {
  const have = sessions.get(host);
  if (have && !have.closed && !have.destroyed) return have;
  const s = http2.connect(`https://${host}`, override?.ca ? { ca: override.ca } : {});
  const drop = () => { if (sessions.get(host) === s) sessions.delete(host); };
  s.on('error', err => { console.warn('[apns] connection error', err.message); drop(); s.destroy(); });
  s.on('goaway', () => { drop(); s.close(); });
  s.on('close', drop);
  s.setTimeout(IDLE_MS, () => { drop(); s.close(); });
  s.unref();
  sessions.set(host, s);
  return s;
}

export const send: Sender = (token, env, payload, opts = {}) => new Promise<SendResult>(resolve => {
  let done = false;
  const finish = (r: SendResult) => { if (!done) { done = true; resolve(r); } };
  try {
    const l = loadConfig();
    if (!l) return finish({ ok: false, status: 0, reason: 'NotConfigured' });
    if (!validToken(token)) return finish({ ok: false, status: 400, reason: 'BadDeviceToken' });
    const realEnv: ApnsEnv = l.cfg.production === undefined ? env : l.cfg.production ? 'production' : 'sandbox';
    const host = override?.host ?? HOSTS[realEnv];
    const body = JSON.stringify(opts.threadId ? { ...payload, aps: { ...payload.aps, 'thread-id': opts.threadId } } : payload);
    const s = session(host);
    s.ref();
    const req = s.request({
      ':method': 'POST', ':path': `/3/device/${token}`,
      authorization: `bearer ${bearer(l)}`,
      'apns-topic': l.cfg.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + EXPIRATION_S),
      ...(opts.collapseId ? { 'apns-collapse-id': opts.collapseId.slice(0, 64) } : {}),
      'content-type': 'application/json',
    });
    let status = 0; const chunks: Buffer[] = [];
    const settle = (r: SendResult) => { s.unref(); finish(r); };
    req.setTimeout(TIMEOUT_MS, () => { req.close(http2.constants.NGHTTP2_CANCEL); settle({ ok: false, status: 0, reason: 'Timeout' }); });
    req.on('response', h => { status = Number(h[':status']) || 0; });
    req.on('data', (c: Buffer | string) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      let reason: string | undefined;
      try { reason = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()).reason : undefined; } catch { /* empty or non-JSON body */ }
      // A rejected/expired provider token: mint a fresh one next time.
      if (status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) jwt = undefined;
      settle({ ok: status === 200, status, ...(reason ? { reason } : {}) });
    });
    req.on('error', err => settle({ ok: false, status: 0, reason: err.message }));
    req.end(body);
  } catch (err: any) { finish({ ok: false, status: 0, reason: String(err?.message ?? err) }); }
});

// Send one payload to every device; resolves with the tokens APNs says are dead. Never rejects.
export async function deliver(devices: ApnsDevice[], payload: ApnsPayload, sender: Sender = send, opts?: SendOpts): Promise<string[]> {
  const results = await Promise.all(devices.map(d => sender(d.token, d.env, payload, opts).catch((e): SendResult => ({ ok: false, status: 0, reason: String(e?.message ?? e) }))));
  results.forEach((r, i) => { if (!r.ok && r.reason !== 'NotConfigured') console.warn(`[apns] ${devices[i].token.slice(0, 8)}… → ${r.status} ${r.reason ?? ''}`); });
  return devices.filter((_, i) => shouldDrop(results[i])).map(d => d.token);
}
