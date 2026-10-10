// Web Push to installed PWAs (phone via Tailscale HTTPS, desktop browsers).
import webpush from 'web-push';
import { EventEmitter } from 'node:events';
import { state, save } from './store.ts';

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
  for (const sub of state.push.subs) {
    webpush.sendNotification(sub, JSON.stringify(n), { TTL: 3600 }).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        state.push.subs = state.push.subs.filter(s => s.endpoint !== sub.endpoint);
        save();
      }
    });
  }
}
