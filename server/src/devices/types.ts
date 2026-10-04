import { BadRequestError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Transport } from '../net/transport.js';
import type { Store } from '../store.js';

/**
 * Capabilities drive the UI: the dashboard renders controls from this list
 * rather than switching on device type, so a new adapter gets a usable panel
 * as soon as it declares what it can do.
 */
export const CAPABILITIES = [
  'power', // on/off
  'brightness',
  'color',
  'colorTemp',
  'effects',
  'volume',
  'remote', // d-pad + transport keys
  'inputs',
  'apps',
  'media', // now-playing info
  'thermostat',
  'camera', // still snapshots
  'events', // motion/ding history
  'sensors',
  'wake', // wake-on-LAN style power on only
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type ParamType = 'number' | 'string' | 'boolean' | 'enum';

export interface ParamSpec {
  name: string;
  type: ParamType;
  label?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Array<{ value: string; label: string }>;
  default?: string | number | boolean;
}

export interface CommandSpec {
  name: string;
  label: string;
  /** Grouping hint for the UI, e.g. "power", "navigation", "comfort". */
  group?: string;
  icon?: string;
  params?: ParamSpec[];
}

export interface DeviceDescriptor {
  id: string;
  name: string;
  type: string;
  room: string | undefined;
  icon: string;
  capabilities: Capability[];
  commands: CommandSpec[];
  /** Human-readable hint shown when the device is unreachable or unpaired. */
  setupHint?: string;
}

export interface DeviceState {
  online: boolean;
  updatedAt: number;
  /** Set when the device needs pairing/credentials before it can be used. */
  needsSetup?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface DeviceContext {
  id: string;
  name: string;
  room: string | undefined;
  transport: Transport;
  logger: Logger;
  store: Store;
  /** Fire a hub event (motion, doorbell ding, ...) from inside an adapter. */
  emit(event: string, payload: Record<string, unknown>): void;
}

export interface CommandResult {
  ok: true;
  /** Optional message surfaced as a toast in the UI. */
  message?: string;
  data?: Record<string, unknown>;
}

export abstract class DeviceAdapter {
  abstract readonly type: string;
  abstract readonly icon: string;
  abstract readonly capabilities: Capability[];

  /** How often the hub polls this device for state. */
  pollIntervalMs = 15_000;

  constructor(protected readonly ctx: DeviceContext) {}

  get id(): string {
    return this.ctx.id;
  }

  get name(): string {
    return this.ctx.name;
  }

  describe(): DeviceDescriptor {
    const descriptor: DeviceDescriptor = {
      id: this.ctx.id,
      name: this.ctx.name,
      type: this.type,
      room: this.ctx.room,
      icon: this.icon,
      capabilities: this.capabilities,
      commands: this.commands(),
    };
    const hint = this.setupHint();
    if (hint) descriptor.setupHint = hint;
    return descriptor;
  }

  abstract commands(): CommandSpec[];

  /** Read current state. Throwing marks the device offline with the message. */
  abstract refresh(): Promise<Omit<DeviceState, 'online' | 'updatedAt'>>;

  abstract execute(command: string, params: Record<string, unknown>): Promise<CommandResult>;

  setupHint(): string | undefined {
    return undefined;
  }

  /** Called once at startup, after the store is loaded. */
  async init(): Promise<void> {}

  async dispose(): Promise<void> {}

  /** Serve `GET /api/devices/:id/snapshot` for camera-capable devices. */
  async snapshot?(): Promise<{ contentType: string; body: Buffer }>;
}

export { BadRequestError, NeedsSetupError, NotFoundError, UnsupportedCommandError } from '../errors.js';

// ---------------------------------------------------------------------------
// Param coercion helpers. Commands arrive as JSON from the UI or a YAML scene,
// so numbers can show up as strings and booleans as "true".
// ---------------------------------------------------------------------------

export function num(params: Record<string, unknown>, key: string, fallback?: number): number {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new BadRequestError(`missing required numeric parameter "${key}"`);
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new BadRequestError(`parameter "${key}" must be a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function bool(params: Record<string, unknown>, key: string, fallback?: boolean): boolean {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new BadRequestError(`missing required boolean parameter "${key}"`);
  }
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const s = String(raw).toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(s)) return true;
  if (['false', '0', 'off', 'no'].includes(s)) return false;
  throw new BadRequestError(`parameter "${key}" must be a boolean, got ${JSON.stringify(raw)}`);
}

export function str(params: Record<string, unknown>, key: string, fallback?: string): string {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new BadRequestError(`missing required parameter "${key}"`);
  }
  return String(raw);
}
