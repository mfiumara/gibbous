// Gibbous REST + shared types (straight from the server's store, so they never drift).
import type { Project, Thread, Settings, ThreadStatus, Usage, Host } from '../../server/store.ts';
import type { OpenRequest } from '../../server/orchestrator.ts';
import type { FileChange, PrBadge } from '../../server/git.ts';

import type { KanbanBoard, KanbanCard, KanbanColumn, KanbanStatus, BoardMatch } from '../../server/kanban.ts';

export type { Project, Thread, Settings, ThreadStatus, OpenRequest, FileChange, PrBadge, Usage, Host, KanbanBoard, KanbanCard, KanbanColumn, KanbanStatus, BoardMatch };

export class ApiError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  const data = await r.json().catch(() => ({}));
  const detail = typeof data.detail === 'string' ? data.detail : data.detail?.message ?? (data.detail ? JSON.stringify(data.detail) : undefined);
  if (!r.ok) throw new ApiError(r.status, data.error ?? detail ?? data.message ?? r.statusText);
  return data as T;
}

// Hermes' own REST, proxied through the Gibbous server (which holds the backend token).
export const hermes = {
  get: <T>(p: string) => req<T>('GET', `/api/hermes/${p}`),
  post: <T>(p: string, body?: unknown) => req<T>('POST', `/api/hermes/${p}`, body),
  put: <T>(p: string, body: unknown) => req<T>('PUT', `/api/hermes/${p}`, body),
  patch: <T>(p: string, body: unknown) => req<T>('PATCH', `/api/hermes/${p}`, body),
  del: <T>(p: string, body?: unknown) => req<T>('DELETE', `/api/hermes/${p}`, body),
};

export const api = {
  get: <T>(url: string) => req<T>('GET', url),
  post: <T>(url: string, body?: unknown) => req<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => req<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => req<T>('PUT', url, body),
  del: <T>(url: string) => req<T>('DELETE', url),
};
