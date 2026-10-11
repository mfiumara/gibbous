import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAPTICS, hapticStyle, hapticDue, HAPTIC_GAP, openPath, isExternal, pushResult, shellPlatform, androidMessage, pushRegistration } from './mobileshell.ts';

const O = 'https://mac.tail1234.ts.net:8444';

test('haptics: app moments map to contract styles, raw styles pass, anything else is dropped', () => {
  assert.equal(hapticStyle('send'), 'light');
  assert.equal(hapticStyle('menu'), 'selection');
  assert.equal(hapticStyle('allow'), 'success');
  assert.equal(hapticStyle('deny'), 'warning');
  assert.equal(hapticStyle('done'), 'soft');
  assert.equal(hapticStyle('longPress'), 'medium');
  assert.equal(hapticStyle('rigid'), 'rigid');
  assert.equal(hapticStyle('boom'), null);
  assert.equal(hapticStyle('toString'), null); // not an inherited key
  const contract = ['light', 'medium', 'heavy', 'soft', 'rigid', 'selection', 'success', 'warning', 'error'];
  for (const s of Object.values(HAPTICS)) assert.ok(contract.includes(s), s);
});

test('haptics: two ticks inside the gap read as one', () => {
  assert.equal(hapticDue(0, 1000), true);
  assert.equal(hapticDue(1000, 1000 + HAPTIC_GAP - 1), false);
  assert.equal(hapticDue(1000, 1000 + HAPTIC_GAP), true);
});

test("'open' urls: hash, /#, same-origin absolute; never another site or a non-route", () => {
  assert.equal(openPath('#/t/th_1', O), '/t/th_1');
  assert.equal(openPath('/#/t/th_1', O), '/t/th_1');
  assert.equal(openPath(`${O}/#/inbox`, O), '/inbox');
  assert.equal(openPath('/#/settings/notifications?x=1', O), '/settings/notifications?x=1');
  assert.equal(openPath('https://evil.example/#/t/th_1', O), null);
  assert.equal(openPath(`${O}/api/media?path=/x#/t/1`, O), null);
  assert.equal(openPath('#/t/<script>', O), null);
  assert.equal(openPath('/', O), null);
  assert.equal(openPath(undefined, O), null);
});

test('external links: other origins and mailto/tel; same-origin and hash links stay', () => {
  assert.equal(isExternal('https://github.com/x/y/pull/1', O), true);
  assert.equal(isExternal('http://example.com', O), true);
  assert.equal(isExternal('mailto:a@b.c', O), true);
  assert.equal(isExternal('tel:+311234', O), true);
  assert.equal(isExternal(`${O}/#/t/1`, O), false);
  assert.equal(isExternal('/api/media?path=/a.png', O), false);
  assert.equal(isExternal('#/inbox', O), false);
  assert.equal(isExternal('javascript:alert(1)', O), false);
});

test('push registration answers → Settings status', () => {
  assert.deepEqual(pushResult(200, { ok: true, configured: true }), { state: 'on' });
  assert.deepEqual(pushResult(200, { ok: true }), { state: 'on' });
  assert.equal(pushResult(200, { ok: true, configured: false }).state, 'unconfigured');
  assert.match(pushResult(200, { ok: true, configured: false }).message!, /APNs key/);
  assert.equal(pushResult(404, { error: 'not found' }).state, 'outdated');
  assert.match(pushResult(404, undefined).message!, /Update the Gibbous server/);
  assert.deepEqual(pushResult(500, { error: 'boom' }), { state: 'error', message: 'boom' });
});

test('push registration on Android: the Firebase message, 404 still means an outdated server', () => {
  assert.deepEqual(pushResult(200, { ok: true, configured: true }, 'android'), { state: 'on' });
  assert.deepEqual(pushResult(200, { ok: true, configured: false }, 'android'), { state: 'unconfigured', message: 'Push needs a Firebase service account on the server' });
  assert.match(pushResult(200, { ok: true, configured: false }, 'ios').message!, /APNs key/);
  assert.equal(pushResult(404, undefined, 'android').state, 'outdated');
  assert.deepEqual(pushResult(400, { error: 'bad token' }, 'android'), { state: 'error', message: 'bad token' });
});

test('shell platform: from __gibbousShell first, then data-shell; Mac/desktop shells are not phones', () => {
  assert.equal(shellPlatform({ platform: 'ios' }), 'ios');
  assert.equal(shellPlatform({ platform: 'android' }), 'android');
  assert.equal(shellPlatform(undefined, 'android'), 'android');
  assert.equal(shellPlatform(undefined, 'ios'), 'ios');
  assert.equal(shellPlatform({ platform: 'android' }, 'ios'), 'android');
  assert.equal(shellPlatform({ platform: 'windows' }), undefined);
  assert.equal(shellPlatform({ platform: 'linux' }, 'android'), undefined);
  assert.equal(shellPlatform({}, 'mac'), undefined); // Gibbous.app's shell values have no platform
  assert.equal(shellPlatform(undefined, undefined), undefined);
  assert.equal(shellPlatform(null, ''), undefined);
});

test('Android messages: one JSON string with the iOS handler name and body', () => {
  const s = androidMessage('gibbousNotify', { title: 'T', body: 'B', url: '#/t/th_1' });
  assert.equal(typeof s, 'string');
  assert.deepEqual(JSON.parse(s), { name: 'gibbousNotify', body: { title: 'T', body: 'B', url: '#/t/th_1' } });
  assert.deepEqual(JSON.parse(androidMessage('gibbousPush', {})), { name: 'gibbousPush', body: {} });
});

test('push token endpoint per platform', () => {
  const t = 'x'.repeat(40);
  assert.deepEqual(pushRegistration('android', t, 'fcm'), { path: '/api/push/fcm', body: { token: t } });
  assert.deepEqual(pushRegistration('android', t), { path: '/api/push/fcm', body: { token: t } });
  assert.deepEqual(pushRegistration('ios', t, 'fcm'), { path: '/api/push/fcm', body: { token: t } });
  assert.deepEqual(pushRegistration('ios', t, 'production'), { path: '/api/push/apns', body: { token: t, env: 'production' } });
  assert.deepEqual(pushRegistration('ios', t, 'sandbox'), { path: '/api/push/apns', body: { token: t, env: 'sandbox' } });
  assert.deepEqual(pushRegistration('ios', t, undefined), { path: '/api/push/apns', body: { token: t, env: 'sandbox' } });
});
