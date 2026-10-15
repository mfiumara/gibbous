// Fetches /api/usage, shared between Settings → Usage and the new-thread glance (one request per range a minute).
import { useEffect, useState } from 'react';
import { api } from './api';
import type { UsageReport, Range } from './usage';

const memo = new Map<Range, { at: number; p: Promise<UsageReport> }>();
export function loadUsage(range: Range): Promise<UsageReport> {
  const hit = memo.get(range);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = api.get<UsageReport>(`/api/usage?days=${range}`);
  memo.set(range, { at: Date.now(), p });
  p.catch(() => memo.delete(range));
  return p;
}

// undefined while loading, null when unavailable (older server, no state.db).
export function useUsage(range: Range): UsageReport | null | undefined {
  const [r, setR] = useState<{ range: Range; data: UsageReport | null }>();
  useEffect(() => {
    let live = true;
    const load = () => loadUsage(range).then(d => live && setR({ range, data: d }), () => live && setR(cur => cur?.range === range && cur.data ? cur : { range, data: null }));
    load();
    // Stays current while open: once a minute (the server re-reads at most that often) and when you come back to the app.
    const tick = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
    const back = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', back); addEventListener('focus', back);
    return () => { live = false; clearInterval(tick); document.removeEventListener('visibilitychange', back); removeEventListener('focus', back); };
  }, [range]);
  return r?.range === range ? r.data : undefined;
}

