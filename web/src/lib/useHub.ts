import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, type HubSnapshot } from './api';
import type { Automation, Device, HubEvent, LogRecord, Scene } from './types';

export type Connection = 'connecting' | 'live' | 'offline' | 'unauthorized';

export interface Toast {
  id: number;
  kind: 'ok' | 'error';
  message: string;
}

export interface HubStore {
  connection: Connection;
  hub: HubSnapshot['hub'] | null;
  devices: Device[];
  scenes: Scene[];
  automations: Automation[];
  events: HubEvent[];
  logs: LogRecord[];
  toasts: Toast[];
  notify(kind: Toast['kind'], message: string): void;
  dismiss(id: number): void;
  /** Run a command and surface the result (or the error) as a toast. */
  run(deviceId: string, command: string, params?: Record<string, unknown>): Promise<boolean>;
  reload(): Promise<void>;
  setScenes(scenes: Scene[]): void;
  setAutomations(automations: Automation[]): void;
}

const MAX_LOGS = 200;
const MAX_EVENTS = 60;

/**
 * Single source of truth for the dashboard. State arrives over a WebSocket so
 * several tablets stay in sync and nothing polls; the REST API is only used
 * for the initial load and for actions.
 */
export function useHub(): HubStore {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [hub, setHub] = useState<HubSnapshot['hub'] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const socket = useRef<WebSocket | null>(null);
  const retry = useRef<number>(0);

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current, { id, kind, message }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const reload = useCallback(async () => {
    try {
      const snapshot = await api.state();
      setHub(snapshot.hub);
      setDevices(snapshot.devices);
      setScenes(snapshot.scenes);
      setAutomations(snapshot.automations);
      setEvents(snapshot.events);
      setConnection((current) => (current === 'live' ? current : 'offline'));
    } catch (err) {
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 401) {
        setConnection('unauthorized');
        return;
      }
      setConnection('offline');
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void reload();
  }, [reload]);

  // Live updates, with reconnect backoff so a Pi reboot heals on its own.
  useEffect(() => {
    let closed = false;
    let timer: number | undefined;

    const connect = (): void => {
      if (closed) return;
      const token = getToken();
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${scheme}://${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const ws = new WebSocket(url);
      socket.current = ws;

      ws.onopen = () => {
        retry.current = 0;
        setConnection('live');
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        const frame = JSON.parse(event.data) as { type: string; payload: unknown };
        switch (frame.type) {
          case 'hello': {
            const payload = frame.payload as Pick<HubSnapshot, 'devices' | 'scenes' | 'automations' | 'events'>;
            setDevices(payload.devices);
            setScenes(payload.scenes);
            setAutomations(payload.automations);
            setEvents(payload.events);
            break;
          }
          case 'device.state': {
            const payload = frame.payload as { id: string; state: Device['state'] };
            setDevices((current) =>
              current.map((device) =>
                device.descriptor.id === payload.id ? { ...device, state: payload.state } : device,
              ),
            );
            break;
          }
          case 'event': {
            const payload = frame.payload as HubEvent;
            setEvents((current) => [payload, ...current].slice(0, MAX_EVENTS));
            break;
          }
          case 'log': {
            const payload = frame.payload as LogRecord;
            setLogs((current) => [payload, ...current].slice(0, MAX_LOGS));
            break;
          }
          default:
            break;
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setConnection('offline');
        retry.current = Math.min(retry.current + 1, 6);
        timer = window.setTimeout(connect, 500 * 2 ** (retry.current - 1));
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket.current?.close();
    };
  }, []);

  // Refresh everything when a tablet wakes up: the socket may have died while
  // the screen was off and the cached state could be minutes stale.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const run = useCallback(
    async (deviceId: string, command: string, params: Record<string, unknown> = {}): Promise<boolean> => {
      try {
        const result = await api.command(deviceId, command, params);
        if (result.message) notify('ok', result.message);
        return true;
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [notify],
  );

  useEffect(() => {
    void api.logs('info').then(setLogs).catch(() => undefined);
  }, []);

  return {
    connection,
    hub,
    devices,
    scenes,
    automations,
    events,
    logs,
    toasts,
    notify,
    dismiss,
    run,
    reload,
    setScenes,
    setAutomations,
  };
}
