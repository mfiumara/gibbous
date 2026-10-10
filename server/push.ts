// Web Push to installed PWAs (phone via Tailscale HTTPS, desktop browsers).
import webpush from 'web-push';
import { EventEmitter } from 'node:events';
import { state, save } from './store.ts';
import * as apns from './apns.ts';

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
    const devices = [...state.push.apns];
    if (!devices.length || (apnsSender === apns.send && !apns.configured())) return;
    const dead = await apns.deliver(devices, apns.buildPayload(n), apnsSender);
    if (dead.length) { state.push.apns = state.push.apns.filter(d => !dead.includes(d.token)); save(); }
  } catch (e) { console.warn('[apns] send failed', e); }
}
