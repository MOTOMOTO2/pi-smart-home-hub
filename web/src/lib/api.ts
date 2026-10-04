import type { Device, Discovered, HubEvent, LogRecord, Scene, Automation } from './types';

const TOKEN_KEY = 'hub.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export interface HubSnapshot {
  hub: { version: string; demo: boolean; startedAt: number; logLevel: string };
  devices: Device[];
  scenes: Scene[];
  automations: Automation[];
  events: HubEvent[];
}

export interface CommandResult {
  ok: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export interface PairResult {
  paired: boolean;
  needsCode?: boolean;
  pin?: string;
  message?: string;
}

export const api = {
  state: () => request<HubSnapshot>('/state'),
  devices: () => request<Device[]>('/devices'),
  device: (id: string) => request<Device>(`/devices/${encodeURIComponent(id)}`),
  refresh: (id: string) => request<{ state: Device['state'] }>(`/devices/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  refreshAll: () => request<{ devices: Device[] }>('/refresh', { method: 'POST' }),
  command: (id: string, command: string, params: Record<string, unknown> = {}) =>
    request<CommandResult>(`/devices/${encodeURIComponent(id)}/command`, { method: 'POST', body: { command, params } }),
  pair: (id: string, body: Record<string, unknown> = {}) =>
    request<PairResult>(`/devices/${encodeURIComponent(id)}/pair`, { method: 'POST', body }),
  scenes: () => request<Scene[]>('/scenes'),
  runScene: (id: string) =>
    request<{ ok: boolean; ran: number; failed: Array<{ device: string; error: string }> }>(
      `/scenes/${encodeURIComponent(id)}/run`,
      { method: 'POST' },
    ),
  deleteScene: (id: string) => request<{ ok: boolean }>(`/scenes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  automations: () => request<Automation[]>('/automations'),
  setAutomation: (id: string, enabled: boolean) =>
    request<{ ok: boolean }>(`/automations/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: { enabled } }),
  events: (limit = 50) => request<HubEvent[]>(`/events?limit=${limit}`),
  logs: (level = 'info', limit = 150) => request<LogRecord[]>(`/logs?level=${level}&limit=${limit}`),
  discover: () => request<Discovered[]>('/discover', { method: 'POST' }),
  demoDoorbell: (kind: 'ding' | 'motion') => request<{ ok: boolean }>('/demo/doorbell', { method: 'POST', body: { kind } }),
};

/** Snapshot URL with a cache-buster, since the image is always "now". */
export function snapshotUrl(deviceId: string, nonce: number): string {
  const token = getToken();
  const auth = token ? `&token=${encodeURIComponent(token)}` : '';
  return `/api/devices/${encodeURIComponent(deviceId)}/snapshot?t=${nonce}${auth}`;
}
