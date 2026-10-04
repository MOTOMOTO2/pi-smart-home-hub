export type Capability =
  | 'power'
  | 'brightness'
  | 'color'
  | 'colorTemp'
  | 'effects'
  | 'volume'
  | 'remote'
  | 'inputs'
  | 'apps'
  | 'media'
  | 'thermostat'
  | 'camera'
  | 'events'
  | 'sensors'
  | 'wake';

export interface ParamSpec {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'enum';
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
  group?: string;
  icon?: string;
  params?: ParamSpec[];
}

export interface DeviceDescriptor {
  id: string;
  name: string;
  type: string;
  room?: string;
  icon: string;
  capabilities: Capability[];
  commands: CommandSpec[];
  setupHint?: string;
}

export interface DeviceState {
  online: boolean;
  updatedAt: number;
  needsSetup?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface Device {
  descriptor: DeviceDescriptor;
  state: DeviceState;
}

export interface SceneAction {
  device?: string;
  command?: string;
  params?: Record<string, unknown>;
  delayMs?: number;
}

export interface Scene {
  id: string;
  name: string;
  icon: string;
  favorite: boolean;
  actions: SceneAction[];
  source: 'config' | 'user';
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  lastRunAt: number | null;
}

export interface HubEvent {
  name: string;
  at: number;
  payload: Record<string, unknown>;
}

export interface LogRecord {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

export interface RingEvent {
  id: string;
  kind: string;
  at: string;
  answered: boolean;
  hasRecording: boolean;
}

export interface ThermostatSensor {
  id: string;
  name: string;
  temperature: number | null;
  humidity: number | null;
  occupied: boolean | null;
}

export interface Discovered {
  type: string;
  name: string;
  host?: string;
  suggestedConfig: Record<string, unknown>;
  details: Record<string, unknown>;
}
