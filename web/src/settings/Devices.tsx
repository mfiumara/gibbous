import { useMemo, useState, useSyncExternalStore } from 'react';
import { Copy, Smartphone } from 'lucide-react';
import { renderSVG } from 'uqr';
import { api, type Settings } from '../api';
import { useStore, toastError } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { Button, Switch } from '../ui';
import { Section, Row } from './common';
import { changeServer, inIosApp, onPushStatus, pushStatus, requestPush, shellVersion } from '../iosBridge';
import { thisMachine } from '../paths';
import { inDesktopApp } from '../desktopBridge';

function b64ToBytes(b64: string) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

const KINDS: { key: keyof Settings['notify']; title: string; description: string }[] = [
  { key: 'input', title: 'Needs you', description: 'Approvals, questions, passwords.' },
  { key: 'done', title: 'Thread finished', description: 'A thread completed its turn.' },
  { key: 'failure', title: 'Failures', description: 'Alerts such as the monthly budget passing.' },
];

export function NotificationsTab() {
  const { vapidPublicKey, toast, settings } = useStore(useShallow(s => ({ vapidPublicKey: s.vapidPublicKey, toast: s.toast, settings: s.settings })));
  const [perm, setPerm] = useState<string>(() => !('Notification' in window) ? 'unsupported' : Notification.permission);
  const enable = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error(/iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, first add Gibbous to your Home Screen (Share → Add to Home Screen), then open it from there.' : 'This browser does not support push notifications.');
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidPublicKey) });
      await api.post('/api/push/subscribe', sub.toJSON());
      toast({ title: 'Notifications are on for this device' });
    } catch (e) { toastError(e); }
  };
  const ios = inIosApp(); // the iPhone app: native push (APNs) instead of Web Push
  const mac = !ios && !!(window as any).webkit?.messageHandlers?.gibbousNotify; // inside Gibbous.app: native macOS banners, no web push
  const desktop = inDesktopApp(); // the Windows/Linux app: native notifications, no web push
  return <>
    {ios ? <IphoneNotifications /> : desktop ? <Section title="This computer" description="The Gibbous app shows system notifications for every thread except the one on screen. If a test doesn't appear, check the system's notification settings (Focus Assist / Do Not Disturb)."
      aside={<Button onClick={() => api.post('/api/push/test').catch(toastError)}>Send a test</Button>} /> : mac ? <Section title="This Mac" description="Gibbous.app shows macOS notifications while its window isn't focused. If a test doesn't appear, allow Gibbous in System Settings → Notifications."
      aside={<Button onClick={() => api.post('/api/push/test').catch(toastError)}>Send a test</Button>} /> :
    <Section title="This device" description="Turn on separately on each device."
      aside={<div className="flex gap-2"><Button onClick={() => api.post('/api/push/test').catch(toastError)}>Send a test</Button><Button tone="primary" onClick={enable} disabled={perm === 'unsupported'}>{perm === 'granted' ? 'Re-register' : 'Turn on'}</Button></div>}>
      {perm === 'denied' && <p className="text-sm text-oxide">Notifications are blocked in this browser's site settings.</p>}
    </Section>}
    <Section title="What to send" description="For all devices.">
      {settings && KINDS.map(k => <Row key={k.key} title={k.title} description={k.description}>
        <Switch label={k.title} checked={settings.notify?.[k.key] !== false} onChange={v => api.patch('/api/settings', { notify: { [k.key]: v } }).catch(toastError)} />
      </Row>)}
    </Section>
  </>;
}

// The iPhone app: APNs registration (iosBridge.ts posts the token to /api/push/apns) and the way back to its
// connect screen.
function IphoneNotifications() {
  const push = useSyncExternalStore(onPushStatus, pushStatus);
  const label = push.state === 'on' ? 'On' : push.state === 'asking' ? 'Turning on…' : push.state === 'off' ? 'Off' : push.message;
  return <Section title="This iPhone" description={`Gibbous for iPhone${shellVersion() ? ` ${shellVersion()}` : ''}.`}>
    <div>
      <Row title="Notifications on this iPhone" description={<span className={push.state === 'on' || push.state === 'off' || push.state === 'asking' ? '' : 'text-oxide select-text'}>{label}</span>}>
        <div className="flex gap-2">
          {push.state === 'on' && <Button onClick={() => api.post('/api/push/test').catch(toastError)}>Send a test</Button>}
          <Button tone={push.state === 'on' ? undefined : 'primary'} onClick={requestPush} disabled={push.state === 'asking'}>{push.state === 'off' || push.state === 'asking' ? 'Turn on' : push.state === 'on' ? 'Re-register' : 'Try again'}</Button>
        </div>
      </Row>
      <ServerRow />
    </div>
  </Section>;
}

const ServerRow = () => <Row title="Server" description={location.host}><Button onClick={changeServer}>Change server</Button></Row>;

export function PhoneTab() {
  const { tailnetUrl, tailnetLogin, toast, service } = useStore(useShallow(s => ({ tailnetUrl: s.tailnetUrl, tailnetLogin: s.tailnetLogin, toast: s.toast, service: s.service })));
  // QR encodes the sign-in link (token inside): scan with the phone camera, it opens Safari signed in.
  const qr = useMemo(() => tailnetLogin ? renderSVG(tailnetLogin, { border: 1, pixelSize: 6, blackColor: 'currentColor', whiteColor: 'transparent' }) : '', [tailnetLogin]);
  const ios = inIosApp();
  if (!tailnetUrl) return <>{ios && <Section title="This iPhone"><div><ServerRow /></div></Section>}<Section title="Phone" description={`Tailscale isn't running on ${thisMachine(service)}, so Gibbous is only reachable locally. Install Tailscale here and on your phone, then run scripts/tailscale.sh.`} /></>;
  return <>
    {ios && <Section title="This iPhone"><div><ServerRow /></div></Section>}
    <Section title="Sign in on your phone" description={<>Scan with your phone's camera. Only your Tailscale devices can open it.</>}>
      <div className="flex flex-col sm:flex-row items-center gap-6">
        <div className="rounded-2xl bg-white p-3 text-[#111] shadow-[var(--shadow)] [&>svg]:size-48" aria-label="Sign-in QR code" role="img" dangerouslySetInnerHTML={{ __html: qr }} />
        <div className="space-y-3 text-[13px] text-dust">
          {ios ? <p className="flex gap-2"><Smartphone size={15} className="flex-none mt-0.5 text-moon" /><span>Signs in another phone: scan with its camera to open Gibbous in Safari, or copy the link below and paste it into the Gibbous app's connect screen.</span></p> : <>
            <p className="flex gap-2"><Smartphone size={15} className="flex-none mt-0.5 text-moon" /><span>To install: open the link, then <b className="text-moon">Share → Add to Home Screen</b>. The installed app keeps its own sign-in: on its sign-in screen, tap <b className="text-moon">Paste link</b> after copying the link below.</span></p>
            <p>Then turn on notifications in Settings, inside the installed app.</p>
          </>}
          <Button onClick={() => { navigator.clipboard.writeText(tailnetLogin!); toast({ title: 'Sign-in link copied', body: 'It contains your access token: treat it like a password.' }); }}><Copy size={14} />Copy sign-in link</Button>
        </div>
      </div>
    </Section>
  </>;
}
