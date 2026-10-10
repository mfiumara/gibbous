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
    loadUsage(range).then(d => live && setR({ range, data: d }), () => live && setR({ range, data: null }));
    return () => { live = false; };
  }, [range]);
  return r?.range === range ? r.data : undefined;
}

