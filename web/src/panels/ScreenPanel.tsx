// What the agent sees: its browser connection and, when Hermes runs a sandbox desktop, a live view of it.
import { useEffect, useState } from 'react';
import { Globe, Monitor, Play, Square, Plug, Unplug } from 'lucide-react';
import { useRpc } from '../rpc';
import { toastError } from '../store';
import { Button, Empty } from '../ui';
import type { DisplayStatus, BrowserManageResult } from '../hermes/contract';

export function ScreenPanel({ sid }: { sid?: string }) {
  const rpc = useRpc();
  const [browser, setBrowser] = useState<BrowserManageResult>();
  const [display, setDisplay] = useState<DisplayStatus>();
  const [shot, setShot] = useState<string>();
  const loadBrowser = () => sid && rpc.call('browser.manage', { action: 'status', session_id: sid }).then(setBrowser, () => {});
  const loadDisplay = () => rpc.call('display.status', {}).then(setDisplay, () => {});
  useEffect(() => { loadBrowser(); loadDisplay(); }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!display?.running) { setShot(undefined); return; }
    const tick = () => rpc.call('display.thumbnail', {}).then(r => r.data_url && setShot(r.data_url), () => {});
    tick();
    const h = setInterval(tick, 2000); // ponytail: thumbnail polling; a VNC view would need the display ticket flow
    return () => clearInterval(h);
  }, [display?.running]);
  const browserAct = (action: 'connect' | 'disconnect') => sid && rpc.call('browser.manage', { action, session_id: sid }).then(setBrowser, toastError);
  return (
    <div className="h-full overflow-y-auto p-4 space-y-6 text-sm">
      <section className="space-y-2">
        <h3 className="label flex items-center gap-1.5"><Globe size={12} />Browser</h3>
        <div className="flex items-center gap-3 rounded-xl border border-line p-3">
          <span className={`size-2 rounded-full ${browser?.connected ? 'bg-sprout' : 'bg-ash'}`} />
          <span className="flex-1 min-w-0 truncate">{browser?.connected ? browser.url ?? 'Connected' : 'Not connected'}</span>
          {browser?.connected ? <Button size="sm" onClick={() => browserAct('disconnect')}><Unplug size={12} />Disconnect</Button> : <Button size="sm" onClick={() => browserAct('connect')}><Plug size={12} />Connect</Button>}
        </div>
        {!!browser?.messages?.length && <ul className="text-[12px] text-dust space-y-0.5">{browser.messages.slice(-4).map((m, i) => <li key={i}>{m}</li>)}</ul>}
      </section>
      <section className="space-y-2">
        <h3 className="label flex items-center gap-1.5"><Monitor size={12} />Sandbox desktop</h3>
        {!display ? null : !display.supported ? <p className="text-dust">Hermes' sandbox desktop isn't supported on this machine{display.blocker ? ` (${display.blocker})` : ''}.</p>
          : !display.installed ? <p className="text-dust">Not installed. Missing: {display.missing.join(', ')}.{display.install_command ? ` Install with: ${display.install_command}` : ''}</p>
          : <>
            <div className="flex items-center gap-3">
              <span className={`size-2 rounded-full ${display.running ? 'bg-sprout animate-pulse' : 'bg-ash'}`} />
              <span className="flex-1">{display.running ? `Running · ${display.geometry}` : 'Stopped'}</span>
              {display.running ? <Button size="sm" onClick={() => rpc.call('display.stop', {}).then(loadDisplay, toastError)}><Square size={11} />Stop</Button>
                : <Button size="sm" onClick={() => rpc.call('display.start', {}).then(setDisplay, toastError)}><Play size={11} />Start</Button>}
            </div>
            {shot ? <img src={shot} alt="The agent's sandbox desktop" className="w-full rounded-xl border border-line" /> : display.running && <div className="skeleton aspect-video rounded-xl" />}
          </>}
      </section>
      {!browser && !display && <Empty title="Nothing on screen yet" />}
    </div>
  );
}
