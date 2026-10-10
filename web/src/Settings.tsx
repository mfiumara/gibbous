// Settings shell: a tab list (left on desktop; its own page on phones) and one file per tab under settings/.
import { lazy, Suspense } from 'react';
import { SlidersHorizontal, Palette, Bell, Smartphone, Plug, Clock, Wrench, UsersRound, Sparkles, MessagesSquare, FileCog, Brain, BarChart3, KeyRound, ArrowUpCircle, Server, ChevronRight } from 'lucide-react';
import { Skeleton } from './ui';
import { PageHeader } from './Inbox';

const tab = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => lazy(() => load().then(m => ({ default: m[name] })));

const TABS: { id: string; label: string; group: string; icon: React.ComponentType<{ size?: number }>; C: React.ComponentType }[] = [
  { id: 'general', label: 'General', group: 'Gibbous', icon: SlidersHorizontal, C: tab(() => import('./settings/General'), 'GeneralTab') },
  { id: 'appearance', label: 'Appearance', group: 'Gibbous', icon: Palette, C: tab(() => import('./settings/General'), 'AppearanceTab') },
  { id: 'notifications', label: 'Notifications', group: 'Gibbous', icon: Bell, C: tab(() => import('./settings/Devices'), 'NotificationsTab') },
  { id: 'phone', label: 'Phone', group: 'Gibbous', icon: Smartphone, C: tab(() => import('./settings/Devices'), 'PhoneTab') },
  { id: 'maintenance', label: 'Maintenance', group: 'Gibbous', icon: Wrench, C: tab(() => import('./settings/Maintenance'), 'MaintenanceTab') },
  { id: 'usage', label: 'Usage', group: 'Agent', icon: BarChart3, C: tab(() => import('./settings/Usage'), 'UsageTab') },
  { id: 'profiles', label: 'Profiles', group: 'Agent', icon: UsersRound, C: tab(() => import('./settings/Profiles'), 'ProfilesTab') },
  { id: 'skills', label: 'Skills', group: 'Agent', icon: Sparkles, C: tab(() => import('./settings/Skills'), 'SkillsTab') },
  { id: 'mcp', label: 'MCP servers', group: 'Agent', icon: Plug, C: tab(() => import('./settings/Mcp'), 'McpTab') },
  { id: 'jobs', label: 'Scheduled jobs', group: 'Agent', icon: Clock, C: tab(() => import('./settings/Jobs'), 'JobsTab') },
  { id: 'platforms', label: 'Messaging', group: 'Agent', icon: MessagesSquare, C: tab(() => import('./settings/Platforms'), 'PlatformsTab') },
  { id: 'memory', label: 'Memory', group: 'Agent', icon: Brain, C: tab(() => import('./settings/Memory'), 'MemoryTab') },
  { id: 'vault', label: 'Vault', group: 'Agent', icon: KeyRound, C: tab(() => import('./settings/Vault'), 'VaultTab') },
  { id: 'config', label: 'Config', group: 'Agent', icon: FileCog, C: tab(() => import('./settings/Config'), 'ConfigTab') },
  { id: 'hosts', label: 'Hosts', group: 'Agent', icon: Server, C: tab(() => import('./settings/Hosts'), 'HostsTab') },
  { id: 'update', label: 'Update', group: 'Agent', icon: ArrowUpCircle, C: tab(() => import('./settings/Update'), 'UpdateTab') },
];

export function SettingsView({ tab: id }: { tab: string }) {
  const current = TABS.find(t => t.id === id) ?? TABS[0];
  const groups = [...new Set(TABS.map(t => t.group))];
  // Phones: the section list is its own page (#/settings), a section opens full screen with a back button.
  const listing = !id;
  return (
    <div className="h-full flex flex-col">
      <PageHeader title={listing ? 'Settings' : current.label} back={listing ? undefined : { href: '#/settings', label: 'Settings' }} />
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <nav aria-label="Settings sections" className={`${listing ? 'flex-1 overflow-y-auto' : 'hidden'} md:block md:flex-none md:w-56 md:border-r border-line md:py-4 md:px-2 md:overflow-y-auto`}>
          <div className="p-3 md:p-0 space-y-4 md:space-y-0">
            {groups.map(g => <div key={g} className="md:mb-4">
              <p className="label px-3 pb-1.5">{g}</p>
              <div className="surface md:[background:none] md:border-0 md:shadow-none rounded-2xl md:rounded-none divide-y divide-line md:divide-y-0 overflow-hidden">
              {TABS.filter(t => t.group === g).map(t => (
                <a key={t.id} href={`#/settings/${t.id}`} aria-current={t.id === current.id ? 'page' : undefined}
                  className={`press flex items-center gap-3 md:gap-2.5 whitespace-nowrap px-4 md:px-3 py-3 md:py-1.5 md:rounded-lg text-[15px] md:text-[13.5px] text-moon active:bg-ridge/55 ${t.id === current.id ? 'md:bg-ridge md:shadow-[inset_0_1px_0_var(--surface-hi)]' : 'md:text-dust md:hover:text-moon md:hover:bg-ridge/55'}`}>
                  <t.icon size={15} /><span className="flex-1">{t.label}</span><ChevronRight size={15} className="md:hidden text-ash" />
                </a>
              ))}
              </div>
            </div>)}
          </div>
        </nav>
        <div className={`${listing ? 'hidden md:block' : ''} flex-1 min-h-0 overflow-y-auto`}>
          <div key={current.id} className="mx-auto max-w-2xl p-4 sm:p-6 space-y-4 pb-16">
            <Suspense fallback={<Skeleton className="h-40 rounded-2xl" />}><current.C /></Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
