import { useMemo, useState } from 'react';
import { Copy, Smartphone } from 'lucide-react';
import { renderSVG } from 'uqr';
import { api, type Settings } from '../api';
import { useStore, toastError } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { Button, Switch } from '../ui';
import { Section, Row } from './common';

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
  const mac = !!(window as any).webkit?.messageHandlers?.gibbousNotify; // inside Gibbous.app: native macOS banners, no web push
  return <>
    {mac ? <Section title="This Mac" description="Gibbous.app shows macOS notifications while its window isn't focused. If a test doesn't appear, allow Gibbous in System Settings → Notifications."
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

export function PhoneTab() {
  const { tailnetUrl, tailnetLogin, toast } = useStore(useShallow(s => ({ tailnetUrl: s.tailnetUrl, tailnetLogin: s.tailnetLogin, toast: s.toast })));
  // QR encodes the sign-in link (token inside): scan with the phone camera, it opens Safari signed in.
  const qr = useMemo(() => tailnetLogin ? renderSVG(tailnetLogin, { border: 1, pixelSize: 6, blackColor: 'currentColor', whiteColor: 'transparent' }) : '', [tailnetLogin]);
  if (!tailnetUrl) return <Section title="Phone" description="Tailscale isn't running on this Mac, so Gibbous is only reachable locally. Install Tailscale on the Mac and your phone, then run scripts/tailscale.sh." />;
  return <>
    <Section title="Sign in on your phone" description={<>Scan with your phone's camera. Only your Tailscale devices can open it.</>}>
      <div className="flex flex-col sm:flex-row items-center gap-6">
        <div className="rounded-2xl bg-white p-3 text-[#111] shadow-[var(--shadow)] [&>svg]:size-48" aria-label="Sign-in QR code" role="img" dangerouslySetInnerHTML={{ __html: qr }} />
        <div className="space-y-3 text-[13px] text-dust">
          <p className="flex gap-2"><Smartphone size={15} className="flex-none mt-0.5 text-moon" /><span>To install: open the link, then <b className="text-moon">Share → Add to Home Screen</b>. The installed app keeps its own sign-in: on its sign-in screen, tap <b className="text-moon">Paste link</b> after copying the link below.</span></p>
          <p>Then turn on notifications in Settings, inside the installed app.</p>
          <Button onClick={() => { navigator.clipboard.writeText(tailnetLogin!); toast({ title: 'Sign-in link copied', body: 'It contains your access token: treat it like a password.' }); }}><Copy size={14} />Copy sign-in link</Button>
        </div>
      </div>
    </Section>
  </>;
}
