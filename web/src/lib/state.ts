import type { Device, DeviceState } from './types';

/** The hub sends state as an open bag of unknowns; read it defensively. */
export function num(state: DeviceState, key: string): number | null {
  const value = state[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function bool(state: DeviceState, key: string): boolean | null {
  const value = state[key];
  return typeof value === 'boolean' ? value : null;
}

export function text(state: DeviceState, key: string): string | null {
  const value = state[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function list<T>(state: DeviceState, key: string): T[] {
  const value = state[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

export function obj(state: DeviceState, key: string): Record<string, unknown> | null {
  const value = state[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function formatTemp(value: number | null, scale: string | null): string {
  if (value === null) return '--';
  return `${Math.round(value * 10) / 10}°${scale ?? ''}`;
}

/**
 * One-line status for a device tile. Deliberately per-capability rather than
 * per-type so a new adapter gets a sensible tile for free.
 */
export function summarize(device: Device): string {
  const { descriptor, state } = device;
  if (state.needsSetup) return 'Needs setup';
  if (!state.online) return state.error ? 'Unreachable' : 'Offline';

  const caps = descriptor.capabilities;

  if (caps.includes('thermostat')) {
    const temp = formatTemp(num(state, 'temperature'), text(state, 'scale'));
    const running = text(state, 'running') ?? 'idle';
    const mode = text(state, 'hvacMode') ?? '';
    return `${temp} · ${running === 'idle' ? mode : running}`;
  }

  if (caps.includes('camera') || caps.includes('events')) {
    if (bool(state, 'ringing')) return 'Someone is at the door';
    const battery = num(state, 'battery');
    const last = list<{ kind: string; at: string }>(state, 'events')[0];
    const parts: string[] = [];
    if (last) parts.push(last.kind === 'ding' ? 'Last: doorbell' : `Last: ${last.kind}`);
    if (battery !== null) parts.push(`${Math.round(battery)}%`);
    return parts.join(' · ') || 'Idle';
  }

  if (caps.includes('brightness')) {
    if (bool(state, 'on') === false) return 'Off';
    const brightness = num(state, 'brightness');
    const effect = text(state, 'effect');
    const parts: string[] = [];
    if (brightness !== null) parts.push(`${Math.round(brightness)}%`);
    if (effect && effect !== '*Solid*') parts.push(effect);
    return parts.join(' · ') || 'On';
  }

  if (caps.includes('inputs') || caps.includes('apps')) {
    if (bool(state, 'on') === false) return 'Standby';
    const app = text(state, 'activeApp');
    const volume = num(state, 'volume');
    const parts: string[] = [];
    if (app) parts.push(app);
    if (bool(state, 'muted')) parts.push('muted');
    else if (volume !== null) parts.push(`vol ${volume}`);
    return parts.join(' · ') || 'On';
  }

  const on = bool(state, 'on');
  if (on === true) {
    const hostname = text(state, 'hostname') ?? text(state, 'consoleName');
    return hostname ? `On · ${hostname}` : 'On';
  }
  if (on === false) return bool(state, 'canWake') ? 'Off · can wake' : 'Off';
  return 'Ready';
}

/** Tile accent: drives the glow so an "on" device reads at a glance. */
export function isActive(device: Device): boolean {
  const { state, descriptor } = device;
  if (!state.online) return false;
  if (descriptor.capabilities.includes('thermostat')) return text(state, 'running') !== 'idle';
  if (bool(state, 'ringing')) return true;
  return bool(state, 'on') === true;
}

export function deviceAccent(device: Device): string | undefined {
  if (!isActive(device)) return undefined;
  const hex = text(device.state, 'hex');
  if (hex && device.descriptor.capabilities.includes('color')) return hex;
  if (device.descriptor.capabilities.includes('thermostat')) {
    const running = text(device.state, 'running');
    if (running === 'heating') return '#ff7a45';
    if (running === 'cooling') return '#38bdf8';
  }
  return undefined;
}

export function groupByRoom(devices: Device[]): Array<[string, Device[]]> {
  const groups = new Map<string, Device[]>();
  for (const device of devices) {
    const room = device.descriptor.room ?? 'Other';
    const bucket = groups.get(room);
    if (bucket) bucket.push(device);
    else groups.set(room, [device]);
  }
  return [...groups.entries()];
}
