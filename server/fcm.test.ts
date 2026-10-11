import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { generateKeyPairSync, createVerify, createPrivateKey } from 'node:crypto';
import * as fcm from './fcm.ts';
import { state, migrate } from './store.ts';
import { notify, sendFcm, setFcmSender, registerFcm, unregisterFcm, fcmStatus, setBadgeSource, badgeChanged, setApnsSender } from './push.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gib-fcm-'));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
// Wait for fire-and-forget sends (token exchange + HTTP) instead of a fixed sleep: a loaded machine takes seconds.
async function until(ok: () => boolean, ms = 10_000) { const end = Date.now() + ms; while (!ok() && Date.now() < end) await tick(20); }
const TOK = (c: string) => `${c}`.repeat(24) + ':APA91b_x-y';

// One local server standing in for both Google's token endpoint and FCM.
interface Hit { path: string; headers: http.IncomingHttpHeaders; body: string }
const hits: Hit[] = [];
const replies: Record<string, { status: number; body: unknown }> = {}; // per device token
let tokenN = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    hits.push({ path: req.url ?? '', headers: req.headers, body });
    const json = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/token') return json(200, { access_token: `at-${++tokenN}`, expires_in: 3599, token_type: 'Bearer' });
    const t = JSON.parse(body).message.token as string;
    const r = replies[t];
    return r ? json(r.status, r.body) : json(200, { name: `projects/demo-proj/messages/${hits.length}` });
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(server.address() as any).port}`;
const SA = { type: 'service_account', project_id: 'demo-proj', private_key_id: 'kid1', private_key: pem, client_email: 'push@demo-proj.iam.gserviceaccount.com', token_uri: `${BASE}/token` };

function home(name: string, cfg?: object | string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (cfg !== undefined) fs.writeFileSync(path.join(dir, 'fcm.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return dir;
}
const sends = () => hits.filter(h => h.path.startsWith('/v1/'));
const tokenHits = () => hits.filter(h => h.path === '/token');

after(async () => {
  state.push.fcm = [];
  setFcmSender(undefined); setApnsSender(undefined); setBadgeSource(() => 0);
  fcm.testing.setBase(undefined); fcm.testing.setHome(undefined); fcm.testing.reset();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('JWT: RS256 header, OAuth claims for the FCM scope, signature verifies with the public key', () => {
  const jwt = fcm.makeJwt(SA, createPrivateKey(pem), 1_700_000_000);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT', kid: 'kid1' });
  assert.deepEqual(decode(c), { iss: SA.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: SA.token_uri, iat: 1_700_000_000, exp: 1_700_003_600 });
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')));
  assert.ok(!createVerify('RSA-SHA256').update(`${h}.x${c}`).verify(publicKey, Buffer.from(sig, 'base64url')));
});

test('token validation, data shapes (all strings), drop rule', () => {
  assert.ok(fcm.validToken('a'.repeat(20)) && fcm.validToken(TOK('b')) && fcm.validToken('x'.repeat(4096)));
  for (const bad of ['a'.repeat(19), 'x'.repeat(4097), 'abc def ghi jkl mno pqr', 'a/'.repeat(20), 5, undefined, null]) assert.ok(!fcm.validToken(bad), String(bad));
  const d = fcm.alertData({ title: 'T', body: 'x'.repeat(5000), kind: 'input' }, 3);
  assert.deepEqual({ ...d, body: d.body.length }, { type: 'notify', title: 'T', body: 1500, url: '', tag: 'input', kind: 'input', badge: '3' });
  assert.ok(d.body.endsWith('…'));
  assert.deepEqual(fcm.alertData({ title: 'T', body: 'B', kind: 'done', tag: 'th_1', url: '#/t/th_1' }),
    { type: 'notify', title: 'T', body: 'B', url: '#/t/th_1', tag: 'th_1', kind: 'done', badge: '0' });
  assert.deepEqual(fcm.badgeData(0), { type: 'badge', badge: '0' });
  assert.ok(fcm.shouldDrop({ ok: false, status: 404, reason: 'NOT_FOUND' }));
  assert.ok(fcm.shouldDrop({ ok: false, status: 400, reason: 'UNREGISTERED' }));
  assert.ok(fcm.shouldDrop({ ok: false, status: 403, reason: 'SENDER_ID_MISMATCH' }));
  assert.ok(!fcm.shouldDrop({ ok: false, status: 400, reason: 'INVALID_ARGUMENT' }));
  assert.ok(!fcm.shouldDrop({ ok: false, status: 401, reason: 'UNAUTHENTICATED' }));
  assert.ok(!fcm.shouldDrop({ ok: false, status: 503, reason: 'UNAVAILABLE' }));
  assert.ok(!fcm.shouldDrop({ ok: true, status: 200 }));
});

test('config: absent / bad JSON / missing fields / non-RSA key → off; valid → on; reloads on change', async () => {
  assert.equal(fcm.loadConfig(home('none')), null);
  assert.equal(fcm.loadConfig(home('badjson', '{nope')), null);
  assert.equal(fcm.loadConfig(home('partial', { ...SA, client_email: undefined })), null);
  assert.equal(fcm.loadConfig(home('wrongtype', { ...SA, type: 'authorized_user' })), null);
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(fcm.loadConfig(home('eckey', { ...SA, private_key: ec })), null);
  assert.equal(fcm.loadConfig(home('ok', SA))?.cfg.project_id, 'demo-proj');

  const dir = home('reload');
  fcm.testing.setHome(dir);
  assert.equal(fcm.configured(), false);
  assert.deepEqual(await fcm.send(TOK('a'), fcm.badgeData(1)), { ok: false, status: 0, reason: 'NotConfigured' });
  fs.writeFileSync(path.join(dir, 'fcm.json'), JSON.stringify(SA));
  assert.equal(fcm.configured(), true);
  fs.writeFileSync(path.join(dir, 'fcm.json'), JSON.stringify({ ...SA, project_id: 'other-project' }));
  fs.utimesSync(path.join(dir, 'fcm.json'), new Date(), new Date(Date.now() + 5000)); // a distinct mtime on coarse clocks
  assert.equal(fcm.loadConfig()?.cfg.project_id, 'other-project');
  fs.rmSync(path.join(dir, 'fcm.json'));
  assert.equal(fcm.configured(), false);
});

test('HTTP: token exchange, bearer, exact message JSON, token cached, 401 refetches', async () => {
  fcm.testing.setHome(home('http', SA));
  fcm.testing.setBase(BASE);
  hits.length = 0; tokenN = 0;
  const data = fcm.alertData({ title: 'Needs you', body: 'b', kind: 'input', tag: 'th_1', url: '#/t/th_1' }, 2);
  // Two concurrent sends share one token request.
  const [a, b] = await Promise.all([fcm.send(TOK('a'), data), fcm.send(TOK('b'), fcm.badgeData(2))]);
  assert.deepEqual([a, b], [{ ok: true, status: 200 }, { ok: true, status: 200 }]);
  assert.equal(tokenHits().length, 1);
  const form = new URLSearchParams(tokenHits()[0].body);
  assert.equal(tokenHits()[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, c, s] = form.get('assertion')!.split('.');
  assert.equal(decode(h).alg, 'RS256');
  assert.equal(decode(c).aud, `${BASE}/token`);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')));

  assert.equal(sends().length, 2);
  for (const x of sends()) {
    assert.equal(x.path, '/v1/projects/demo-proj/messages:send');
    assert.equal(x.headers.authorization, 'Bearer at-1');
    assert.equal(x.headers['content-type'], 'application/json');
  }
  const alert = JSON.parse(sends().find(x => x.body.includes('notify'))!.body);
  assert.deepEqual(alert, { message: { token: TOK('a'), data: { type: 'notify', title: 'Needs you', body: 'b', url: '#/t/th_1', tag: 'th_1', kind: 'input', badge: '2' }, android: { priority: 'HIGH', ttl: '3600s' } } });
  assert.ok(Object.values(alert.message.data).every(v => typeof v === 'string'));
  assert.deepEqual(JSON.parse(sends().find(x => x.body.includes('"badge"}') || x.body.includes('"type":"badge"'))!.body),
    { message: { token: TOK('b'), data: { type: 'badge', badge: '2' }, android: { priority: 'HIGH', ttl: '3600s' } } });

  // Cached: another send, still one token request.
  await fcm.send(TOK('a'), data);
  assert.equal(tokenHits().length, 1);
  // FCM rejects the access token once → the next send mints a new one.
  replies[TOK('a')] = { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'expired' } } };
  assert.deepEqual(await fcm.send(TOK('a'), data), { ok: false, status: 401, reason: 'UNAUTHENTICATED' });
  delete replies[TOK('a')];
  assert.deepEqual(await fcm.send(TOK('a'), data), { ok: true, status: 200 });
  assert.equal(tokenHits().length, 2);
  assert.equal(sends().at(-1)!.headers.authorization, 'Bearer at-2');
});

test('notify fan-out over HTTP: dead tokens dropped, per-kind settings respected, register/unregister', async () => {
  fcm.testing.setHome(home('fanout', SA));
  fcm.testing.setBase(BASE);
  const live = TOK('l'), gone = TOK('g'), unreg = TOK('u'), other = TOK('o'), flaky = TOK('f');
  replies[gone] = { status: 404, body: { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.' } } };
  replies[unreg] = { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } };
  replies[other] = { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'SENDER_ID_MISMATCH' }] } } };
  replies[flaky] = { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } };
  state.push.fcm = []; state.push.apns = []; state.push.subs = [];
  for (const t of [live, gone, unreg, other, flaky]) registerFcm(t);
  registerFcm(live); // re-register = refresh, not a duplicate
  assert.deepEqual(fcmStatus(), { configured: true, devices: 5 });
  let n = 1; setBadgeSource(() => n);

  hits.length = 0;
  notify({ kind: 'done', title: 'Done', body: 'b', tag: 'th_9', url: '#/t/th_9' });
  await until(() => sends().length >= 5 && state.push.fcm.length === 2);
  assert.equal(sends().length, 5);
  assert.deepEqual(JSON.parse(sends().find(x => x.body.includes(live))!.body).message.data,
    { type: 'notify', title: 'Done', body: 'b', url: '#/t/th_9', tag: 'th_9', kind: 'done', badge: '1' });
  assert.deepEqual(state.push.fcm.map(d => d.token).sort(), [live, flaky].sort());

  hits.length = 0;
  state.settings.notify.input = false;
  notify({ kind: 'input', title: 'q', body: 'b' });
  await tick(150);
  assert.equal(sends().length, 0, 'disabled kind does not push');
  state.settings.notify.input = true;

  // Badge-only to Android when the count changed (alerts already sent badge 1).
  badgeChanged(0); await tick(150);
  assert.equal(sends().length, 0, 'unchanged count sends nothing');
  n = 0; badgeChanged(0); await until(() => sends().length >= 2);
  assert.equal(sends().length, 2);
  for (const x of sends()) assert.deepEqual(JSON.parse(x.body).message.data, { type: 'badge', badge: '0' });

  assert.ok(unregisterFcm(flaky));
  assert.ok(!unregisterFcm(flaky));
  for (const t of Object.keys(replies)) delete replies[t];
  state.push.fcm = []; setBadgeSource(() => 0);
});

test('a fake sender sees the same payloads; a throwing sender never escapes', async () => {
  const seen: [string, fcm.FcmData][] = [];
  state.push.fcm = []; state.push.apns = []; state.push.subs = [];
  registerFcm(TOK('a')); registerFcm(TOK('e'));
  setFcmSender(async (t, d) => { seen.push([t, d]); if (t === TOK('e')) throw new Error('boom'); return { ok: true, status: 200 }; });
  setBadgeSource(() => 4);
  await sendFcm({ title: 'T', body: 'B', kind: 'failure' });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0][1], fcm.alertData({ title: 'T', body: 'B', kind: 'failure' }, 4));
  assert.equal(state.push.fcm.length, 2);
  setFcmSender(undefined); state.push.fcm = []; setBadgeSource(() => 0);
});

test('badgeChanged: one shared count, badge-only to iPhone and Android devices alike', async () => {
  const ios: unknown[] = [], android: fcm.FcmData[] = [];
  state.push.fcm = []; state.push.apns = []; state.push.subs = [];
  registerFcm(TOK('a'));
  state.push.apns = [{ token: 'ab'.repeat(32), env: 'sandbox', at: 0 }];
  setApnsSender(async (_t, _e, p) => { ios.push(p); return { ok: true, status: 200 }; });
  setFcmSender(async (_t, d) => { android.push(d); return { ok: true, status: 200 }; });
  setBadgeSource(() => 7);
  badgeChanged(0); await tick();
  assert.deepEqual(ios, [{ aps: { badge: 7 } }]);
  assert.deepEqual(android, [{ type: 'badge', badge: '7' }]);
  badgeChanged(0); await tick();
  assert.equal(ios.length + android.length, 2, 'unchanged count sends nothing');
  setApnsSender(undefined); setFcmSender(undefined); state.push.fcm = []; state.push.apns = []; setBadgeSource(() => 0);
});

test('state migration: push.fcm defaults to [] and keeps only valid tokens', () => {
  assert.deepEqual(migrate({}).push.fcm, []);
  const m = migrate({ push: { subs: [], fcm: [{ token: TOK('a'), at: 5 }, { token: 'short' }, { token: 7 }, null, { token: TOK('b') }] } });
  assert.deepEqual(m.push.fcm, [{ token: TOK('a'), at: 5 }, { token: TOK('b'), at: 0 }]);
});
