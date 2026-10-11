import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http2 from 'node:http2';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createVerify, createPrivateKey } from 'node:crypto';
import * as apns from './apns.ts';
import { state, migrate } from './store.ts';
import { notify, sendApns, setApnsSender, registerApns, unregisterApns, setBadgeSource, badgeChanged } from './push.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gib-apns-'));
after(() => { apns.testing.closeAll(); apns.testing.setEndpoint(undefined); apns.testing.setHome(undefined); setApnsSender(undefined); fs.rmSync(tmp, { recursive: true, force: true }); });

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TOKEN = 'ab'.repeat(32);
const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());

function home(name: string, cfg?: object) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AuthKey_TEST.p8'), pem);
  if (cfg) fs.writeFileSync(path.join(dir, 'apns.json'), JSON.stringify(cfg));
  return dir;
}
const CFG = { keyId: 'KEY123', teamId: 'TEAM456', bundleId: 'dev.gibbous.ios', keyPath: 'AuthKey_TEST.p8' };

test('JWT: ES256 header with kid, iss/iat claims, verifiable raw r||s signature', () => {
  const jwt = apns.makeJwt('KEY123', 'TEAM456', createPrivateKey(pem), 1_700_000_000);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'ES256', kid: 'KEY123' });
  assert.deepEqual(decode(c), { iss: 'TEAM456', iat: 1_700_000_000 });
  const raw = Buffer.from(sig, 'base64url');
  assert.equal(raw.length, 64); // ieee-p1363, not DER
  assert.ok(createVerify('SHA256').update(`${h}.${c}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
  assert.ok(!createVerify('SHA256').update(`${h}.x${c}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, raw));
});

test('payload shape: alert, sound, thread-id from tag else kind, url', () => {
  assert.deepEqual(apns.buildPayload({ title: 'T', body: 'B', url: '#/t/x', tag: 'th_1', kind: 'done' }),
    { aps: { alert: { title: 'T', body: 'B' }, sound: 'default', 'thread-id': 'th_1', 'mutable-content': 0 }, url: '#/t/x' });
  const p = apns.buildPayload({ title: 'T', body: 'x'.repeat(5000), kind: 'input' });
  assert.equal(p.aps['thread-id'], 'input');
  assert.ok(!('url' in p));
  assert.ok(JSON.stringify(p).length < 4096);
});

test('token + env validation', () => {
  assert.ok(apns.validToken('a'.repeat(64)) && apns.validToken('F'.repeat(200)));
  for (const bad of ['a'.repeat(63), 'a'.repeat(201), 'g'.repeat(64), 123, undefined, `${'a'.repeat(64)} `]) assert.ok(!apns.validToken(bad), String(bad));
  assert.deepEqual(apns.parseDevice({ token: 'AB'.repeat(32), env: 'production' }), { token: 'ab'.repeat(32), env: 'production' });
  assert.equal(apns.parseDevice({ token: TOKEN, env: 'dev' }), null);
  assert.equal(apns.parseDevice({ env: 'sandbox' }), null);
});

test('drop rule: 410, 400 BadDeviceToken / DeviceTokenNotForTopic only', () => {
  assert.ok(apns.shouldDrop({ ok: false, status: 410, reason: 'Unregistered' }));
  assert.ok(apns.shouldDrop({ ok: false, status: 400, reason: 'BadDeviceToken' }));
  assert.ok(apns.shouldDrop({ ok: false, status: 400, reason: 'DeviceTokenNotForTopic' }));
  assert.ok(!apns.shouldDrop({ ok: false, status: 400, reason: 'PayloadTooLarge' }));
  assert.ok(!apns.shouldDrop({ ok: false, status: 403, reason: 'ExpiredProviderToken' }));
  assert.ok(!apns.shouldDrop({ ok: false, status: 0, reason: 'Timeout' }));
  assert.ok(!apns.shouldDrop({ ok: true, status: 200 }));
});

test('config: missing / incomplete / bad key → disabled; valid → enabled', async () => {
  assert.equal(apns.loadConfig(home('none')), null);
  assert.equal(apns.loadConfig(home('partial', { keyId: 'K', teamId: 'T', keyPath: 'AuthKey_TEST.p8' })), null);
  assert.equal(apns.loadConfig(home('nokey', { ...CFG, keyPath: 'missing.p8' })), null);
  const ok = apns.loadConfig(home('ok', { ...CFG, production: true }));
  assert.equal(ok?.cfg.bundleId, 'dev.gibbous.ios');
  assert.equal(ok?.cfg.production, true);
  apns.testing.setHome(path.join(tmp, 'none'));
  assert.equal(apns.configured(), false);
  assert.deepEqual(await apns.send(TOKEN, 'sandbox', apns.buildPayload({ title: 't', body: 'b', kind: 'input' })), { ok: false, status: 0, reason: 'NotConfigured' });
});

test('deliver + notify fan-out with a fake sender: dead tokens dropped, settings respected, never throws', async () => {
  const calls: [string, string, any][] = [];
  const replies: Record<string, apns.SendResult> = {};
  const fake: apns.Sender = async (token, env, payload) => { calls.push([token, env, payload]); if (token.startsWith('ee')) throw new Error('boom'); return replies[token] ?? { ok: true, status: 200 }; };
  const live = 'aa'.repeat(32), gone = 'bb'.repeat(32), bad = 'cc'.repeat(32), flaky = 'dd'.repeat(32), throws = 'ee'.repeat(32);
  replies[gone] = { ok: false, status: 410, reason: 'Unregistered' };
  replies[bad] = { ok: false, status: 400, reason: 'BadDeviceToken' };
  replies[flaky] = { ok: false, status: 503, reason: 'ServiceUnavailable' };
  state.push.apns = [];
  state.push.subs = [];
  for (const t of [live, gone, bad, flaky, throws]) registerApns({ token: t, env: 'sandbox' });
  registerApns({ token: live, env: 'production' }); // re-register = refresh, not a duplicate
  assert.equal(state.push.apns.length, 5);
  assert.equal(state.push.apns.find(d => d.token === live)?.env, 'production');
  setApnsSender(fake);
  await sendApns({ title: 'Done', body: 'b', kind: 'done', tag: 'th_9', url: '#/t/th_9' });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.find(c => c[0] === live)?.slice(1), ['production', apns.buildPayload({ title: 'Done', body: 'b', kind: 'done', tag: 'th_9', url: '#/t/th_9' }, 0)]);
  assert.deepEqual(state.push.apns.map(d => d.token).sort(), [live, flaky, throws].sort());

  calls.length = 0;
  state.settings.notify.input = false;
  notify({ kind: 'input', title: 'q', body: 'b' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 0, 'disabled kind does not push');
  state.settings.notify.input = true;
  notify({ kind: 'input', title: 'q', body: 'b' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 3);
  assert.ok(unregisterApns(flaky.toUpperCase()));
  assert.ok(!unregisterApns(flaky));
  setApnsSender(undefined);
});

// Real HTTP/2 round trip against a local TLS server standing in for APNs.
test('HTTP/2 sender: headers, path, JWT, 200 and 410 end to end', async t => {
  const certDir = path.join(tmp, 'tls');
  fs.mkdirSync(certDir);
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
  } catch { t.skip('openssl not available'); return; }
  const cert = fs.readFileSync(path.join(certDir, 'cert.pem'));
  const seen: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
  const server = http2.createSecureServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert });
  server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
    let body = '';
    stream.on('data', c => { body += c; });
    stream.on('end', () => {
      seen.push({ headers, body });
      const gone = String(headers[':path']).endsWith('bb'.repeat(32));
      stream.respond({ ':status': gone ? 410 : 200, 'apns-id': 'x' });
      stream.end(gone ? JSON.stringify({ reason: 'Unregistered', timestamp: 1 }) : '');
    });
  });
  // Every interface: `localhost` resolves to ::1 first on some Linux setups and to 127.0.0.1 on others.
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as any).port;
  apns.testing.setHome(home('h2', CFG));
  apns.testing.setEndpoint({ host: `localhost:${port}`, ca: cert });
  apns.testing.resetJwt();
  try {
    const payload = apns.buildPayload({ title: 'Hi', body: 'there', kind: 'done', url: '/' });
    const ok = await apns.send(TOKEN, 'sandbox', payload, { collapseId: 'c1' });
    assert.deepEqual(ok, { ok: true, status: 200 });
    const h = seen[0].headers;
    assert.equal(h[':method'], 'POST');
    assert.equal(h[':path'], `/3/device/${TOKEN}`);
    assert.equal(h['apns-topic'], 'dev.gibbous.ios');
    assert.equal(h['apns-push-type'], 'alert');
    assert.equal(h['apns-priority'], '10');
    assert.equal(h['apns-collapse-id'], 'c1');
    const exp = Number(h['apns-expiration']);
    assert.ok(exp > Date.now() / 1000 && exp < Date.now() / 1000 + 7200);
    const auth = String(h.authorization);
    assert.match(auth, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const [hh, cc, ss] = auth.slice(7).split('.');
    assert.deepEqual(decode(hh), { alg: 'ES256', kid: 'KEY123' });
    assert.equal(decode(cc).iss, 'TEAM456');
    assert.ok(createVerify('SHA256').update(`${hh}.${cc}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(ss, 'base64url')));
    assert.deepEqual(JSON.parse(seen[0].body), payload);

    // Same connection + cached JWT reused; 410 comes back with its reason and the token is dropped.
    const dead = await apns.deliver([{ token: TOKEN, env: 'sandbox', at: 0 }, { token: 'bb'.repeat(32), env: 'production', at: 0 }], payload);
    assert.deepEqual(dead, ['bb'.repeat(32)]);
    assert.equal(seen.length, 3);
    assert.equal(seen[1].headers.authorization, auth);
    assert.deepEqual(await apns.send('bb'.repeat(32), 'sandbox', payload), { ok: false, status: 410, reason: 'Unregistered' });
  } finally {
    apns.testing.setEndpoint(undefined);
    await new Promise(r => server.close(r));
  }
});

test('state migration: push.apns defaults to [] and drops malformed devices', () => {
  assert.deepEqual(migrate({}).push.apns, []);
  assert.deepEqual(migrate({ push: { subs: [{ endpoint: 'x' }] } }).push, { subs: [{ endpoint: 'x' }], apns: [], fcm: [] });
  const m = migrate({ push: { subs: [], apns: [{ token: TOKEN, env: 'sandbox', at: 1 }, { token: 5 }, { token: TOKEN, env: 'dev' }] } });
  assert.deepEqual(m.push.apns, [{ token: TOKEN, env: 'sandbox', at: 1 }]);
});

test('icon badge: alerts carry the waiting count; a change alone sends one badge-only push, unchanged sends none', async () => {
  const tok = 'ab'.repeat(32), sent: apns.ApnsPayload[] = [];
  state.push.apns = []; state.push.subs = [];
  registerApns({ token: tok, env: 'sandbox' });
  setApnsSender(async (_t, _e, p) => { sent.push(p); return { ok: true, status: 200 }; });
  let n = 2; setBadgeSource(() => n);
  await sendApns({ title: 'Needs you', body: 'b', kind: 'input' });
  assert.equal(sent.at(-1)?.aps.badge, 2);
  badgeChanged(0); await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 1); // still 2: nothing to send
  n = 0; badgeChanged(0); await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sent.at(-1), { aps: { badge: 0 } });
  setApnsSender(undefined); setBadgeSource(() => 0); state.push.apns = [];
});
