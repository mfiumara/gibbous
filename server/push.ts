// Web Push to installed PWAs (phone via Tailscale HTTPS, desktop browsers).
import webpush from 'web-push';
import { EventEmitter } from 'node:events';
import { state, save } from './store.ts';
import * as apns from './apns.ts';
import * as fcm from './fcm.ts';

if (!state.push.vapid) { state.push.vapid = webpush.generateVAPIDKeys(); save(); }
webpush.setVapidDetails('mailto:gibbous@localhost', state.push.vapid.publicKey, state.push.vapid.privateKey);

export const vapidPublicKey = () => state.push.vapid!.publicKey;
// In-app toasts for connected browsers ride the same notifications.
export const notifications = new EventEmitter();

export function subscribe(sub: any) {
  if (!sub?.endpoint) throw new Error('bad subscription');
  state.push.subs = state.push.subs.filter(s => s.endpoint !== sub.endpoint);
  state.push.subs.push(sub);
  save();
}

import type { NotifyKind } from './store.ts';
export type { NotifyKind };

// In-app toasts always fire; push respects the per-kind preferences in Settings.
export function notify(n: { title: string; body: string; url?: string; tag?: string; kind: NotifyKind; test?: boolean }) {
  notifications.emit('notify', n);
  if (state.settings.notify?.[n.kind] === false) return;
  void sendApns(n);
  void sendFcm(n);
  for (const sub of state.push.subs) {
    webpush.sendNotification(sub, JSON.stringify(n), { TTL: 3600 }).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        state.push.subs = state.push.subs.filter(s => s.endpoint !== sub.endpoint);
        save();
      }
    });
  }
}

// ── iOS shell (APNs) ────────────────────────────────────────────────────
export function registerApns(d: { token: string; env: 'sandbox' | 'production' }) {
  state.push.apns = state.push.apns.filter(x => x.token !== d.token);
  state.push.apns.push({ token: d.token, env: d.env, at: Date.now() });
  save();
}
export function unregisterApns(token: string) {
  const before = state.push.apns.length;
  state.push.apns = state.push.apns.filter(x => x.token !== token.toLowerCase());
  if (state.push.apns.length !== before) save();
  return before !== state.push.apns.length;
}
export const apnsStatus = () => ({ configured: apns.configured(), devices: state.push.apns.length });

let apnsSender: apns.Sender = apns.send;
export const setApnsSender = (s: apns.Sender | undefined) => { apnsSender = s ?? apns.send; }; // tests

// Fire-and-forget; dead tokens (410 / BadDeviceToken / DeviceTokenNotForTopic) are dropped.
export async function sendApns(n: { title: string; body: string; url?: string; tag?: string; kind: NotifyKind }) {
  try {
    const devices = apnsTargets();
    if (!devices.length) return;
    const badge = badgeSource();
    lastBadge = badge;
    dropApns(await apns.deliver(devices, apns.buildPayload(n, badge), apnsSender));
  } catch (e) { console.warn('[apns] send failed', e); }
}
const apnsTargets = () => (state.push.apns.length && (apnsSender !== apns.send || apns.configured()) ? [...state.push.apns] : []);
function dropApns(dead: string[]) { if (dead.length) { state.push.apns = state.push.apns.filter(d => !dead.includes(d.token)); save(); } }

// ── Android shell (FCM) ─────────────────────────────────────────────────
export function registerFcm(token: string) {
  state.push.fcm = state.push.fcm.filter(x => x.token !== token);
  state.push.fcm.push({ token, at: Date.now() });
  save();
}
export function unregisterFcm(token: string) {
  const before = state.push.fcm.length;
  state.push.fcm = state.push.fcm.filter(x => x.token !== token);
  if (state.push.fcm.length !== before) save();
  return before !== state.push.fcm.length;
}
export const fcmStatus = () => ({ configured: fcm.configured(), devices: state.push.fcm.length });

let fcmSender: fcm.Sender = fcm.send;
export const setFcmSender = (s: fcm.Sender | undefined) => { fcmSender = s ?? fcm.send; }; // tests

// Fire-and-forget; dead tokens (404 / UNREGISTERED / SENDER_ID_MISMATCH) are dropped.
export async function sendFcm(n: { title: string; body: string; url?: string; tag?: string; kind: NotifyKind }) {
  try {
    const devices = fcmTargets();
    if (!devices.length) return;
    const badge = badgeSource();
    lastBadge = badge;
    dropFcm(await fcm.deliver(devices, fcm.alertData(n, badge), fcmSender));
  } catch (e) { console.warn('[fcm] send failed', e); }
}
const fcmTargets = () => (state.push.fcm.length && (fcmSender !== fcm.send || fcm.configured()) ? [...state.push.fcm] : []);
function dropFcm(dead: string[]) { if (dead.length) { state.push.fcm = state.push.fcm.filter(d => !dead.includes(d.token)); save(); } }

// The app icon badge = agents waiting on you (same count as the tab title). Every alert carries it, and when the
// count changes without an alert (answered on the Mac, a request expired) a silent badge-only push keeps the closed
// apps right (iPhone via APNs, Android via FCM; one shared last-sent count).
let badgeSource = () => 0, lastBadge = -1, badgeTimer: ReturnType<typeof setTimeout> | undefined;
export const setBadgeSource = (f: () => number) => { badgeSource = f; };
export function badgeChanged(delayMs = 2000) {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const badge = badgeSource(), ios = apnsTargets(), android = fcmTargets();
      if (badge === lastBadge || (!ios.length && !android.length)) return;
      lastBadge = badge;
      await Promise.all([
        ios.length ? apns.deliver(ios, { aps: { badge } }, apnsSender).then(dropApns) : undefined,
        android.length ? fcm.deliver(android, fcm.badgeData(badge), fcmSender).then(dropFcm) : undefined,
      ]);
    } catch (e) { console.warn('[push] badge failed', e); }
  }, delayMs);
  badgeTimer.unref?.();
}
