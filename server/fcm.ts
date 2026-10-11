// Firebase Cloud Messaging (HTTP v1) for the Android shell: service-account OAuth (RS256 JWT → access token) + fetch.
// Config is GIBBOUS_HOME/fcm.json = the Firebase service-account JSON as downloaded
// ({ type, project_id, private_key, client_email, token_uri, … }). No (valid) config → FCM is silently off.
// Messages are data-only and high priority: the app builds every notification itself. Nothing here throws into notify().
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { GIBBOUS_HOME } from './store.ts';

export interface FcmDevice { token: string; at: number }
export interface FcmConfig { project_id: string; client_email: string; private_key: string; token_uri: string; private_key_id?: string }
export interface SendResult { ok: boolean; status: number; reason?: string }
// FCM requires every data value to be a string.
export type FcmData = Record<string, string>;
export type Sender = (token: string, data: FcmData) => Promise<SendResult>;

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000, JWT_TTL_S = 3600, EARLY_MS = 5 * 60_000, TTL = '3600s';

// ── validation ──────────────────────────────────────────────────────────
// Keep in sync with migrate() in store.ts (which can't import this module: it would be a cycle).
export const validToken = (t: unknown): t is string => typeof t === 'string' && /^[A-Za-z0-9_:\-]{20,4096}$/.test(t);

// ── config ──────────────────────────────────────────────────────────────
interface Loaded { cfg: FcmConfig; key: KeyObject }
let configHome = GIBBOUS_HOME;
let cache: { file: string; stamp: string; loaded: Loaded | null } | undefined;
// Re-read when fcm.json changes, so adding the service account needs no restart.
export function loadConfig(home = configHome): Loaded | null {
  const file = path.join(home, 'fcm.json');
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) { if (cache?.loaded) access = undefined; cache = { file, stamp: '', loaded: null }; return null; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  if (cache?.file === file && cache.stamp === stamp) return cache.loaded;
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return remember(file, stamp, null, 'fcm.json is not valid JSON'); }
  if (raw?.type !== undefined && raw.type !== 'service_account') return remember(file, stamp, null, 'fcm.json: not a service-account key');
  for (const k of ['project_id', 'client_email', 'private_key', 'token_uri'] as const) if (typeof raw?.[k] !== 'string' || !raw[k]) return remember(file, stamp, null, `fcm.json: missing ${k}`);
  if (!/^https?:\/\//.test(raw.token_uri)) return remember(file, stamp, null, 'fcm.json: token_uri is not a URL');
  try {
    const key = createPrivateKey(raw.private_key);
    if (key.asymmetricKeyType !== 'rsa') return remember(file, stamp, null, 'fcm.json: private_key is not an RSA key');
    const cfg: FcmConfig = { project_id: raw.project_id, client_email: raw.client_email, private_key: raw.private_key, token_uri: raw.token_uri, ...(typeof raw.private_key_id === 'string' && raw.private_key_id ? { private_key_id: raw.private_key_id } : {}) };
    return remember(file, stamp, { cfg, key });
  } catch { return remember(file, stamp, null, 'fcm.json: could not read private_key'); }
}
let warned = '';
function remember(file: string, stamp: string, loaded: Loaded | null, why?: string) {
  if (why && why !== warned) console.warn(`[fcm] disabled: ${why}`);
  warned = why ?? '';
  access = undefined; // a new (or no) service account: never reuse the old access token
  cache = { file, stamp, loaded };
  return loaded;
}
export const configured = () => { try { return !!loadConfig(); } catch { return false; } };

// ── OAuth: RS256 JWT → access token ─────────────────────────────────────
const b64u = (x: string | Buffer) => Buffer.from(x).toString('base64url');
export function makeJwt(cfg: FcmConfig, key: KeyObject, iat = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT', ...(cfg.private_key_id ? { kid: cfg.private_key_id } : {}) };
  const claims = { iss: cfg.client_email, scope: SCOPE, aud: cfg.token_uri, iat, exp: iat + JWT_TTL_S };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(createSign('RSA-SHA256').update(input).sign(key))}`;
}

// One access token per service account, shared by concurrent sends (one in-flight request).
let access: { id: string; token?: string; until: number; pending?: Promise<string> } | undefined;
async function accessToken(l: Loaded): Promise<string> {
  const id = `${l.cfg.client_email}|${l.cfg.token_uri}`, now = Date.now();
  if (access?.id === id && access.token && now < access.until) return access.token;
  if (access?.id === id && access.pending) return access.pending;
  const entry: NonNullable<typeof access> = { id, until: 0 };
  entry.pending = (async () => {
    const res = await fetch(l.cfg.token_uri, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: makeJwt(l.cfg, l.key) }).toString(),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof j?.access_token !== 'string') throw new Error(`token ${res.status} ${j?.error ?? ''}`.trim());
    entry.token = j.access_token;
    entry.until = Date.now() + (Number(j.expires_in) || 3600) * 1000 - EARLY_MS;
    return j.access_token as string;
  })().finally(() => { entry.pending = undefined; });
  access = entry;
  try { return await entry.pending; } catch (e) { if (access === entry) access = undefined; throw e; }
}

// ── messages ────────────────────────────────────────────────────────────
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export function alertData(n: { title: string; body: string; url?: string; tag?: string; kind: string }, badge = 0): FcmData {
  return {
    type: 'notify', title: clip(String(n.title ?? ''), 200), body: clip(String(n.body ?? ''), 1500),
    url: String(n.url ?? ''), tag: String(n.tag ?? n.kind), kind: String(n.kind), badge: String(badge),
  };
}
export const badgeData = (badge: number): FcmData => ({ type: 'badge', badge: String(badge) });
export const message = (token: string, data: FcmData) => ({ message: { token, data, android: { priority: 'HIGH', ttl: TTL } } });

// 404 / UNREGISTERED: the app was uninstalled or the token rotated. SENDER_ID_MISMATCH: a token for another project.
export const shouldDrop = (r: SendResult) =>
  r.status === 404 || r.reason === 'UNREGISTERED' || (r.status === 403 && r.reason === 'SENDER_ID_MISMATCH');

// ── HTTP ────────────────────────────────────────────────────────────────
// Testing-only override of https://fcm.googleapis.com (e.g. a local http server).
let base = process.env.GIBBOUS_FCM_URL || 'https://fcm.googleapis.com';
export const testing = {
  setBase(url: string | undefined) { base = url || process.env.GIBBOUS_FCM_URL || 'https://fcm.googleapis.com'; },
  setHome(dir: string | undefined) { configHome = dir ?? GIBBOUS_HOME; cache = undefined; access = undefined; },
  reset() { access = undefined; cache = undefined; warned = ''; },
};

export const send: Sender = async (token, data) => {
  try {
    const l = loadConfig();
    if (!l) return { ok: false, status: 0, reason: 'NotConfigured' };
    if (!validToken(token)) return { ok: false, status: 400, reason: 'INVALID_ARGUMENT' };
    let bearer: string;
    try { bearer = await accessToken(l); } catch (e: any) { return { ok: false, status: 0, reason: `OAuth: ${e?.message ?? e}` }; }
    const res = await fetch(`${base.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(l.cfg.project_id)}/messages:send`, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(message(token, data)),
    });
    const j: any = await res.json().catch(() => undefined);
    // A rejected access token: fetch a fresh one next time.
    if (res.status === 401 && access?.token === bearer) access = undefined;
    if (res.ok) return { ok: true, status: res.status };
    const err = j?.error;
    const code = Array.isArray(err?.details) ? err.details.find((d: any) => typeof d?.errorCode === 'string')?.errorCode : undefined;
    const reason = code ?? (typeof err?.status === 'string' ? err.status : undefined);
    return { ok: false, status: res.status, ...(reason ? { reason } : {}) };
  } catch (e: any) { return { ok: false, status: 0, reason: e?.name === 'TimeoutError' ? 'Timeout' : String(e?.message ?? e) }; }
};

// Send one data message to every device; resolves with the tokens FCM says are dead. Never rejects.
export async function deliver(devices: FcmDevice[], data: FcmData, sender: Sender = send): Promise<string[]> {
  const results = await Promise.all(devices.map(d => sender(d.token, data).catch((e): SendResult => ({ ok: false, status: 0, reason: String(e?.message ?? e) }))));
  results.forEach((r, i) => { if (!r.ok && r.reason !== 'NotConfigured') console.warn(`[fcm] ${devices[i].token.slice(0, 8)}… → ${r.status} ${r.reason ?? ''}`); });
  return devices.filter((_, i) => shouldDrop(results[i])).map(d => d.token);
}
