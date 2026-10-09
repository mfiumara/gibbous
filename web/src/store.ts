// App state: a mirror of the server's Gibbous state, kept fresh by gibbous.event frames.
import { create } from 'zustand';
import { api, ApiError, type PrBadge, type Project, type Thread, type Task, type Settings, type OpenRequest, type Playbook, type PlanDraft, type Schedule, type Host } from './api';
import { rpc } from './rpc';

interface Toast { id: number; title: string; body?: string; url?: string; tone?: 'error' | 'info'; action?: { label: string; run(): void } }

interface S {
  loaded: boolean; authed: boolean | null; connected: boolean;
  projects: Project[]; threads: Thread[]; tasks: Task[]; requests: OpenRequest[];
  playbooks: Playbook[]; plans: PlanDraft[]; schedules: Schedule[];
  settings?: Settings; hermesReady: boolean; hermes?: { ready: boolean; version?: string; updateAvailable?: boolean; gatewayRunning?: boolean }; gatewayReplies?: boolean;
  hosts: (Host & { connected: boolean })[]; tailnetUrl: string | null; tailnetLogin: string | null; vapidPublicKey: string;
  build?: string | null; // web build the server serves now (see LOADED_BUILD)
  prs: Record<string, PrBadge>; // thread id → its GitHub PR (worktree threads only)
  toasts: Toast[];
  seen: Record<string, number>;   // thread id → when you last looked (per device)
  markSeen(id: string): void;
  sidebar: boolean; // mobile drawer
  palette: boolean;
  load(): Promise<void>;
  toast(t: Omit<Toast, 'id'>): void;
  dismiss(id: number): void;
}

const upsert = <T extends { id: string }>(list: T[], item: T, front = false) => {
  const i = list.findIndex(x => x.id === item.id);
  if (i < 0) return front ? [item, ...list] : [...list, item];
  const next = list.slice(); next[i] = item; return next;
};

let toastId = 0;
export const useStore = create<S>((set, get) => ({
  loaded: false, authed: null, connected: false,
  projects: [], threads: [], tasks: [], requests: [], playbooks: [], plans: [], schedules: [], hosts: [], hermesReady: false, tailnetUrl: null, tailnetLogin: null, vapidPublicKey: '', prs: {},
  toasts: [], sidebar: false, palette: false,
  // First run: everything counts as seen, so the sidebar doesn't light up all at once.
  seen: JSON.parse(localStorage.getItem('gibbous.seen') ?? 'null') ?? { '*': Date.now() },
  markSeen(id) {
    const seen = { ...get().seen, [id]: Date.now() };
    localStorage.setItem('gibbous.seen', JSON.stringify(seen));
    set({ seen });
  },
  async load() {
    try {
      const s = await api.get<any>('/api/state');
      set({ ...s, hermesReady: s.hermes.ready, loaded: true, authed: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) set({ authed: false, loaded: true });
      else throw e;
    }
  },
  toast(t) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { ...t, id }].slice(-4) });
    setTimeout(() => get().dismiss(id), t.tone === 'error' ? 9000 : t.action ? 6500 : 5000);
  },
  dismiss(id) { set({ toasts: get().toasts.filter(t => t.id !== id) }); },
}));

// The hashed entry script this tab is running; null under the vite dev server, which hot-reloads on its own.
export const LOADED_BUILD = document.querySelector<HTMLScriptElement>('script[type=module][src*="/assets/"]')?.getAttribute('src') ?? null;
export const useStaleBuild = () => useStore(s => !!LOADED_BUILD && !!s.build && s.build !== LOADED_BUILD);

export const toastError = (e: unknown) => useStore.getState().toast({ title: (e as Error)?.message ?? String(e), tone: 'error' });

// Reversible actions get an Undo toast instead of a confirm dialog. One toast per action, however many threads.
const named = (ts: Thread[]) => ts.length === 1 ? `“${ts[0].title.slice(0, 60)}”` : `${ts.length} threads`;
export function archiveWithUndo(t: Thread | Thread[]) {
  const ts = Array.isArray(t) ? t : [t];
  // Archiving the thread you're in closes it; Undo takes you back.
  const open = ts.find(x => location.hash === `#/t/${x.id}`);
  if (open) location.hash = '/';
  Promise.all(ts.map(x => api.post(`/api/threads/${x.id}/archive`, { removeWorktree: false }))).then(() => useStore.getState().toast({
    title: `Archived ${named(ts)}`, action: { label: 'Undo', run: () => {
      for (const x of ts) api.patch(`/api/threads/${x.id}`, { status: 'idle' }).catch(toastError);
      if (open) location.hash = `/t/${open.id}`;
    } },
  }), e => { toastError(e); if (open) location.hash = `/t/${open.id}`; });
}
// Deleting waits out the Undo window before it reaches the server; until then the threads are only hidden here.
export function deleteWithUndo(t: Thread | Thread[], removeWorktree = false) {
  const ts = Array.isArray(t) ? t : [t], ids = new Set(ts.map(x => x.id));
  const s = useStore.getState();
  useStore.setState({ threads: s.threads.filter(x => !ids.has(x.id)) });
  if (ts.some(x => location.hash === `#/t/${x.id}`)) location.hash = '/';
  let undone = false;
  const timer = setTimeout(() => {
    if (undone) return;
    for (const x of ts) api.del(`/api/threads/${x.id}${removeWorktree ? '?removeWorktree=1' : ''}`).catch(e => { toastError(e); useStore.getState().load(); });
  }, 6500);
  s.toast({ title: `Deleted ${named(ts)}`, body: removeWorktree ? 'Its worktree goes too.' : 'Hermes keeps the sessions in Hermes history.', action: { label: 'Undo', run: () => {
    undone = true; clearTimeout(timer);
    useStore.setState({ threads: [...ts, ...useStore.getState().threads.filter(x => !ids.has(x.id))] });
  } } });
}

rpc.onGibbous = (kind, data) => {
  const s = useStore.getState();
  switch (kind) {
    case 'thread': useStore.setState({ threads: upsert(s.threads, data, true) }); break;
    case 'thread-deleted': useStore.setState({ threads: s.threads.filter(t => t.id !== data.id) }); break;
    case 'task': useStore.setState({ tasks: upsert(s.tasks, data) }); break;
    case 'task-deleted': useStore.setState({ tasks: s.tasks.filter(t => t.id !== data.id) }); break;
    case 'project': useStore.setState({ projects: upsert(s.projects, data) }); break;
    case 'requests': useStore.setState({ requests: data }); break;
    case 'plan': useStore.setState({ plans: data.status === 'drafting' || data.status === 'ready' ? upsert(s.plans, data) : s.plans.filter(p => p.id !== data.id) }); break;
    case 'schedule': useStore.setState({ schedules: upsert(s.schedules, data) }); break;
    case 'playbooks': useStore.setState({ playbooks: data }); break;
    case 'hosts': useStore.setState({ hosts: data }); break;
    case 'prs': useStore.setState({ prs: data }); break;
    case 'settings': useStore.setState({ settings: data }); break;
    case 'hermes': useStore.setState({ hermesReady: data.ready }); break;
    case 'health': useStore.setState({ hermes: { ...s.hermes, ready: s.hermesReady, ...data } }); break;
    case 'notify': {
      // Inside the macOS app: native notification whenever the window isn't focused.
      const bridge = (window as any).webkit?.messageHandlers?.gibbousNotify;
      if (bridge && (!document.hasFocus() || data.test)) bridge.postMessage(data); // the test always shows a real banner
      else if (document.visibilityState === 'visible') s.toast({ title: data.title, body: data.body, url: data.url });
      break;
    }
    case 'reload': s.load(); break;
    case 'build': useStore.setState({ build: data }); break;
  }
};
rpc.onStatus = connected => {
  useStore.setState({ connected });
  if (connected) useStore.getState().load(); // resync anything missed while offline
};

// A thread changed (finished, replied, asked) since you last looked at it.
export const isUnread = (t: Thread, seen: Record<string, number>) =>
  t.status !== 'archived' && t.status !== 'running' && t.updatedAt > (seen[t.id] ?? seen['*'] ?? 0);

// Stable empty list for selectors: `?? []` inside a selector is a new array every render (React #185 in zustand v5).
export const NONE: never[] = [];
