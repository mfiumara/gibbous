// One quiet strip above the content when something about the connection to Hermes needs attention.
import { useEffect, useState } from 'react';
import { WifiOff, ArrowUpCircle, RotateCw, X, Download, TriangleAlert, KeyRound } from 'lucide-react';
import { MoonLoader } from './ui';
import { useStore, useStaleBuild } from './store';
import { useShallow } from 'zustand/react/shallow';

export function HealthBanner() {
  const { connected, hermesReady, hermes } = useStore(useShallow(s => ({ connected: s.serverUp || s.connected, hermesReady: s.hermesReady, hermes: s.hermes })));
  const stale = useStaleBuild();
  const [hidden, setHidden] = useState<string | null>(() => sessionStorage.getItem('gibbous.bannerHidden'));
  // A new Gibbous build: reload on its own while you're away (drafts live in localStorage); in front of you, ask.
  useEffect(() => {
    if (!stale) return;
    const away = () => { if (document.visibilityState === 'hidden') location.reload(); };
    away();
    document.addEventListener('visibilitychange', away);
    return () => document.removeEventListener('visibilitychange', away);
  }, [stale]);
  if (connected && stale) return (
    <button onClick={() => location.reload()} className="press w-full flex items-center gap-2.5 px-4 py-1.5 border-b text-left text-[12.5px] animate-fade text-tide bg-tide/8 border-tide/25 hover:bg-tide/15">
      <RotateCw size={14} />
      <span className="flex-1 min-w-0 truncate text-moon/85">Gibbous was updated. <span className="underline underline-offset-2">Reload</span> for the latest.</span>
    </button>
  );
  const issue = !connected ? { id: 'offline', tone: 'oxide', icon: WifiOff, text: 'Lost the connection to Gibbous. Reconnecting…' }
    : !hermesReady && hermes?.installed === false ? { id: 'missing', tone: 'halo', icon: Download, text: "Hermes, the agent Gibbous runs on, isn't installed yet.", short: "Hermes isn't installed.", href: '#/setup', link: ['Set it up', 'Set up'] }
    : !hermesReady && hermes?.error ? { id: 'broken', tone: 'oxide', icon: TriangleAlert, text: "Hermes won't start. Gibbous keeps trying.", short: "Hermes won't start.", href: '#/setup', link: ['See why', 'Why'] }
    : !hermesReady ? { id: 'starting', tone: 'halo', icon: null, text: 'Hermes is starting or restarting. Threads will reattach on their own.' }
    : hermes?.configured === false ? { id: 'model', tone: 'halo', icon: KeyRound, text: 'The agent has no model to work with yet.', short: 'No model set up yet.', href: '#/setup', link: ['Choose a model', 'Choose'] }
    : hermes?.updateAvailable ? { id: `update-${hermes.version}`, tone: 'tide', icon: ArrowUpCircle, text: `A Hermes update is available (you're on ${hermes.version}).`, short: 'Hermes update available.', href: '#/settings/update', link: ['Review and update', 'Update'] }
    : null;
  if (!issue || hidden === issue.id) return null;
  const Icon = issue.icon;
  const tone = { oxide: 'text-oxide bg-oxide/8 border-oxide/25', halo: 'text-halo bg-halo/8 border-halo/25', tide: 'text-tide bg-tide/8 border-tide/25' }[issue.tone];
  return (
    <div role="status" className={`flex items-center gap-2.5 px-4 py-1.5 border-b text-[12.5px] animate-fade ${tone}`}>
      {Icon ? <Icon size={14} /> : <MoonLoader size={16} label="Hermes is starting" />}
      <span className="flex-1 min-w-0 truncate text-moon/85">{'short' in issue ? <><span className="hidden sm:inline">{issue.text}</span><span className="sm:hidden">{issue.short}</span></> : issue.text} {'href' in issue && issue.link && <a href={issue.href} className="underline underline-offset-2 hover:text-moon"><span className="hidden sm:inline">{issue.link[0]}</span><span className="sm:hidden">{issue.link[1]}</span></a>}</span>
      {issue.id.startsWith('update') && <button aria-label="Hide" onClick={() => { sessionStorage.setItem('gibbous.bannerHidden', issue.id); setHidden(issue.id); }} className="press -mr-2 -my-1 grid place-items-center size-9 text-dust hover:text-moon"><X size={14} /></button>}
    </div>
  );
}
