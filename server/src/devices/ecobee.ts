import type { DeviceConfig } from '../config.js';
import { BadRequestError } from '../errors.js';
import { clamp } from '../util/async.js';
import {
  DeviceAdapter,
  NeedsSetupError,
  UnsupportedCommandError,
  num,
  str,
  type Capability,
  type CommandResult,
  type CommandSpec,
  type DeviceContext,
  type DeviceState,
} from './types.js';

type EcobeeConfig = Extract<DeviceConfig, { type: 'ecobee' }>;

const API = 'https://api.ecobee.com';
const SCOPE = 'smartWrite';

export const HVAC_MODES = ['heat', 'cool', 'auto', 'auxHeatOnly', 'off'] as const;
export const HOLD_TYPES = ['nextTransition', 'indefinite', 'holdHours'] as const;

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface EcobeeSensorCapability {
  id: string;
  type: string;
  value: string;
}

interface EcobeeThermostat {
  identifier: string;
  name: string;
  modelNumber?: string;
  brand?: string;
  runtime?: {
    actualTemperature?: number;
    actualHumidity?: number;
    desiredHeat?: number;
    desiredCool?: number;
    desiredFanMode?: string;
    connected?: boolean;
  };
  settings?: {
    hvacMode?: string;
    heatRangeLow?: number;
    heatRangeHigh?: number;
    coolRangeLow?: number;
    coolRangeHigh?: number;
    fanMinOnTime?: number;
  };
  equipmentStatus?: string;
  events?: Array<{ type: string; running?: boolean; name?: string; endDate?: string; endTime?: string }>;
  remoteSensors?: Array<{ id: string; name: string; type: string; capability?: EcobeeSensorCapability[] }>;
}

/** Ecobee reports and accepts temperatures as tenths of a degree Fahrenheit. */
const tenthsFToF = (v: number | undefined): number | null => (typeof v === 'number' ? v / 10 : null);
const fToC = (f: number): number => ((f - 32) * 5) / 9;
const cToF = (c: number): number => (c * 9) / 5 + 32;

/**
 * Ecobee thermostat via the official API. Authorisation uses the `ecobeePin`
 * flow, which is the right fit for a headless hub: the hub asks for a 4-char
 * PIN, you type it into ecobee.com under My Apps, and the hub trades the code
 * for tokens. Access tokens last an hour and are refreshed automatically; the
 * refresh token lives in the state file.
 *
 * You need your own developer API key (free): ecobee.com > Developer > Create
 * New Application. The thermostat must be registered to the same account.
 */
export class EcobeeAdapter extends DeviceAdapter {
  readonly type = 'ecobee';
  readonly icon = 'thermostat';
  readonly capabilities: Capability[] = ['thermostat', 'sensors'];

  private tokens: TokenSet | undefined;
  private pending: { code: string; pin: string; expiresAt: number } | undefined;
  private refreshing: Promise<void> | null = null;

  constructor(ctx: DeviceContext, private readonly cfg: EcobeeConfig) {
    super(ctx);
    // Ecobee aggregates data on a 3-minute cadence; polling faster is wasted.
    this.pollIntervalMs = (cfg.pollSeconds ?? 120) * 1000;
  }

  override async init(): Promise<void> {
    const saved = this.ctx.store.get<TokenSet>(`ecobee:${this.id}`, 'tokens');
    if (saved?.refreshToken) {
      this.tokens = saved;
    } else if (this.cfg.refreshToken) {
      // Seeded from config: no access token yet, so the first call refreshes.
      this.tokens = { accessToken: '', refreshToken: this.cfg.refreshToken, expiresAt: 0 };
    }
  }

  private get apiKey(): string {
    const key = this.cfg.apiKey;
    if (!key) {
      throw new NeedsSetupError(
        'No Ecobee API key configured. Create a free developer app at ecobee.com (Developer > Create New Application), then set `apiKey` on this device.',
      );
    }
    return key;
  }

  override setupHint(): string | undefined {
    if (!this.cfg.apiKey) {
      return 'Create a developer app at ecobee.com (Developer > Create New Application, auth method "ecobee PIN") and set `apiKey` in config.';
    }
    if (!this.tokens) {
      return 'Press Pair to get a PIN, then add it at ecobee.com > My Apps > Add Application within 9 minutes.';
    }
    return undefined;
  }

  commands(): CommandSpec[] {
    const unit = this.cfg.scale === 'C' ? 'C' : 'F';
    const range = this.cfg.scale === 'C' ? { min: 5, max: 35, step: 0.5 } : { min: 45, max: 92, step: 1 };
    return [
      {
        name: 'setpoint',
        label: 'Set temperature',
        group: 'comfort',
        params: [
          { name: 'heat', type: 'number', label: 'Heat to', unit, ...range },
          { name: 'cool', type: 'number', label: 'Cool to', unit, ...range },
          {
            name: 'holdType',
            type: 'enum',
            default: 'nextTransition',
            options: HOLD_TYPES.map((h) => ({ value: h, label: h })),
          },
          { name: 'holdHours', type: 'number', min: 1, max: 48, label: 'Hold hours' },
        ],
      },
      {
        name: 'nudge',
        label: 'Adjust',
        group: 'comfort',
        params: [{ name: 'delta', type: 'number', min: -10, max: 10, step: 1, unit, required: true }],
      },
      {
        name: 'hvacMode',
        label: 'Mode',
        group: 'comfort',
        params: [
          { name: 'mode', type: 'enum', required: true, options: HVAC_MODES.map((m) => ({ value: m, label: m })) },
        ],
      },
      {
        name: 'fan',
        label: 'Fan',
        group: 'comfort',
        params: [
          {
            name: 'mode',
            type: 'enum',
            required: true,
            options: [
              { value: 'auto', label: 'Auto' },
              { value: 'on', label: 'On' },
            ],
          },
        ],
      },
      { name: 'resume', label: 'Resume schedule', group: 'comfort' },
    ];
  }

  /** Step 1 of the PIN flow: ask Ecobee for a PIN to show the user. */
  async pairStart(): Promise<{ pin: string; expiresInSeconds: number }> {
    const url = `${API}/authorize?response_type=ecobeePin&client_id=${encodeURIComponent(this.apiKey)}&scope=${SCOPE}`;
    const res = await this.ctx.transport.http(url, { timeoutMs: 8000 });
    const body = res.json<{ ecobeePin?: string; code?: string; expires_in?: number }>();
    if (!body.ecobeePin || !body.code) throw new Error('Ecobee did not return a PIN; check that the API key is correct');
    const expiresInSeconds = (body.expires_in ?? 9) * 60;
    this.pending = { code: body.code, pin: body.ecobeePin, expiresAt: Date.now() + expiresInSeconds * 1000 };
    this.ctx.store.set(`ecobee:${this.id}`, 'pending', this.pending);
    return { pin: body.ecobeePin, expiresInSeconds };
  }

  /** Step 2: once the PIN has been added in the Ecobee portal, claim tokens. */
  async pairComplete(): Promise<void> {
    const pending = this.pending ?? this.ctx.store.get<typeof this.pending>(`ecobee:${this.id}`, 'pending');
    if (!pending) throw new Error('No pairing in progress. Request a PIN first.');
    if (pending.expiresAt < Date.now()) throw new Error('That PIN has expired. Request a new one.');

    const url = `${API}/token?grant_type=ecobeePin&code=${encodeURIComponent(pending.code)}&client_id=${encodeURIComponent(this.apiKey)}`;
    const res = await this.ctx.transport.http(url, { method: 'POST', timeoutMs: 8000, allowStatus: true });
    const body = res.json<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }>();
    if (!res.ok || !body.access_token || !body.refresh_token) {
      if (body.error === 'authorization_pending') {
        throw new Error('Ecobee has not seen the PIN yet. Add it at ecobee.com > My Apps > Add Application, then press Complete.');
      }
      throw new Error(body.error_description ?? `Ecobee token request failed with HTTP ${res.status}`);
    }
    this.saveTokens(body.access_token, body.refresh_token, body.expires_in ?? 3600);
    this.pending = undefined;
    this.ctx.store.delete(`ecobee:${this.id}`, 'pending');
    this.ctx.logger.info('paired successfully');
  }

  async refresh(): Promise<Omit<DeviceState, 'online' | 'updatedAt'>> {
    if (!this.cfg.apiKey || !this.tokens) {
      return { needsSetup: true, paired: false, pendingPin: this.pending?.pin ?? null };
    }

    const selection = {
      selection: {
        selectionType: this.cfg.thermostatId ? 'thermostats' : 'registered',
        selectionMatch: this.cfg.thermostatId ?? '',
        includeRuntime: true,
        includeSettings: true,
        includeEquipmentStatus: true,
        includeEvents: true,
        includeSensors: true,
      },
    };
    const res = await this.authed(`${API}/1/thermostat?format=json&body=${encodeURIComponent(JSON.stringify(selection))}`);
    const body = res.json<{ thermostatList?: EcobeeThermostat[] }>();
    const thermostat = body.thermostatList?.[0];
    if (!thermostat) throw new Error('Ecobee returned no thermostats for this account');

    this.ctx.store.set(`ecobee:${this.id}`, 'thermostatId', thermostat.identifier);

    const runtime = thermostat.runtime ?? {};
    const settings = thermostat.settings ?? {};
    const equipment = (thermostat.equipmentStatus ?? '').split(',').filter(Boolean);
    const hold = thermostat.events?.find((e) => e.running && e.type === 'hold');

    return {
      paired: true,
      thermostatId: thermostat.identifier,
      thermostatName: thermostat.name,
      scale: this.cfg.scale,
      temperature: this.display(tenthsFToF(runtime.actualTemperature)),
      humidity: runtime.actualHumidity ?? null,
      heatSetpoint: this.display(tenthsFToF(runtime.desiredHeat)),
      coolSetpoint: this.display(tenthsFToF(runtime.desiredCool)),
      hvacMode: settings.hvacMode ?? 'unknown',
      fanMode: runtime.desiredFanMode ?? 'auto',
      equipment,
      running: runningState(equipment),
      holdActive: Boolean(hold),
      holdEnds: hold?.endDate && hold?.endTime ? `${hold.endDate} ${hold.endTime}` : null,
      model: thermostat.modelNumber ?? null,
      sensors: (thermostat.remoteSensors ?? []).map((sensor) => ({
        id: sensor.id,
        name: sensor.name,
        type: sensor.type,
        temperature: this.display(sensorNumber(sensor.capability, 'temperature', 10)),
        humidity: sensorNumber(sensor.capability, 'humidity', 1),
        occupied: sensorBool(sensor.capability, 'occupancy'),
      })),
      on: settings.hvacMode !== undefined && settings.hvacMode !== 'off',
    };
  }

  async execute(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    switch (command) {
      case 'setpoint': {
        const hasHeat = params['heat'] !== undefined && params['heat'] !== null && params['heat'] !== '';
        const hasCool = params['cool'] !== undefined && params['cool'] !== null && params['cool'] !== '';
        if (!hasHeat && !hasCool) throw new BadRequestError('setpoint needs at least one of heat or cool');

        const current = await this.refresh();
        const heat = hasHeat ? num(params, 'heat') : (current['heatSetpoint'] as number | null);
        const cool = hasCool ? num(params, 'cool') : (current['coolSetpoint'] as number | null);
        if (heat === null || cool === null) {
          throw new Error('Could not read the current setpoints to fill in the missing half; try setting both.');
        }
        const holdType = str(params, 'holdType', 'nextTransition');
        const holdParams: Record<string, unknown> = {
          holdType,
          heatHoldTemp: this.toTenthsF(heat),
          coolHoldTemp: this.toTenthsF(cool),
        };
        if (holdType === 'holdHours') holdParams['holdHours'] = clamp(Math.round(num(params, 'holdHours', 2)), 1, 48);
        await this.callFunction('setHold', holdParams);
        return { ok: true, message: `Hold set: heat ${heat}, cool ${cool}` };
      }

      case 'nudge': {
        const delta = num(params, 'delta');
        const current = await this.refresh();
        const mode = String(current['hvacMode'] ?? 'auto');
        const heat = current['heatSetpoint'] as number | null;
        const cool = current['coolSetpoint'] as number | null;
        if (heat === null || cool === null) throw new Error('Current setpoints unavailable');
        // In a single-mode setup only the active side should move; in auto,
        // slide the whole comfort band so it stays valid.
        const nextHeat = mode === 'cool' ? heat : heat + delta;
        const nextCool = mode === 'heat' ? cool : cool + delta;
        await this.callFunction('setHold', {
          holdType: 'nextTransition',
          heatHoldTemp: this.toTenthsF(nextHeat),
          coolHoldTemp: this.toTenthsF(nextCool),
        });
        return { ok: true, message: `Adjusted by ${delta > 0 ? '+' : ''}${delta}` };
      }

      case 'hvacMode': {
        const mode = str(params, 'mode');
        if (!(HVAC_MODES as readonly string[]).includes(mode)) {
          throw new BadRequestError(`unknown hvacMode "${mode}" (expected ${HVAC_MODES.join(', ')})`);
        }
        await this.update({ settings: { hvacMode: mode } });
        return { ok: true, message: `Mode: ${mode}` };
      }

      case 'fan': {
        const mode = str(params, 'mode').toLowerCase();
        if (mode !== 'on' && mode !== 'auto') throw new BadRequestError('fan mode must be "on" or "auto"');
        const current = await this.refresh();
        await this.callFunction('setHold', {
          holdType: 'nextTransition',
          heatHoldTemp: this.toTenthsF((current['heatSetpoint'] as number) ?? 68),
          coolHoldTemp: this.toTenthsF((current['coolSetpoint'] as number) ?? 76),
          fan: mode,
        });
        return { ok: true, message: `Fan: ${mode}` };
      }

      case 'resume':
        await this.callFunction('resumeProgram', { resumeAll: false });
        return { ok: true, message: 'Back on schedule' };

      default:
        throw new UnsupportedCommandError(command, this.type);
    }
  }

  // -- token handling -------------------------------------------------------

  private saveTokens(accessToken: string, refreshToken: string, expiresIn: number): void {
    // Expire a minute early so a long poll cannot straddle the boundary.
    this.tokens = { accessToken, refreshToken, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
    this.ctx.store.set(`ecobee:${this.id}`, 'tokens', this.tokens);
    void this.ctx.store.flush();
  }

  private async ensureToken(): Promise<string> {
    const tokens = this.tokens;
    if (!tokens) throw new NeedsSetupError('Ecobee is not paired yet.');
    if (tokens.expiresAt > Date.now()) return tokens.accessToken;
    // Collapse concurrent refreshes so two polls cannot both spend the token.
    if (!this.refreshing) {
      this.refreshing = this.doRefreshToken().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    if (!this.tokens) throw new NeedsSetupError('Ecobee token refresh failed; pair again.');
    return this.tokens.accessToken;
  }

  private async doRefreshToken(): Promise<void> {
    const tokens = this.tokens;
    if (!tokens) throw new NeedsSetupError('Ecobee is not paired yet.');
    const url = `${API}/token?grant_type=refresh_token&code=${encodeURIComponent(tokens.refreshToken)}&client_id=${encodeURIComponent(this.apiKey)}`;
    const res = await this.ctx.transport.http(url, { method: 'POST', timeoutMs: 8000, allowStatus: true });
    const body = res.json<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string }>();
    if (!res.ok || !body.access_token) {
      if (res.status === 400 || res.status === 401) {
        this.tokens = undefined;
        this.ctx.store.delete(`ecobee:${this.id}`, 'tokens');
        throw new NeedsSetupError('Ecobee refresh token was rejected; pair again.');
      }
      throw new Error(`Ecobee token refresh failed with HTTP ${res.status}`);
    }
    this.saveTokens(body.access_token, body.refresh_token ?? tokens.refreshToken, body.expires_in ?? 3600);
    this.ctx.logger.debug('access token refreshed');
  }

  private async authed(url: string, init: { method?: 'GET' | 'POST'; body?: string } = {}) {
    const token = await this.ensureToken();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const res = await this.ctx.transport.http(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      timeoutMs: 10_000,
      allowStatus: true,
    });
    if (res.status === 401) {
      // Token died mid-flight; refresh once and retry.
      await this.doRefreshToken();
      const retryToken = await this.ensureToken();
      return await this.ctx.transport.http(url, {
        method: init.method ?? 'GET',
        headers: { ...headers, authorization: `Bearer ${retryToken}` },
        ...(init.body === undefined ? {} : { body: init.body }),
        timeoutMs: 10_000,
      });
    }
    if (!res.ok) {
      const detail = res.json<{ status?: { message?: string } }>();
      throw new Error(detail?.status?.message ?? `Ecobee API returned HTTP ${res.status}`);
    }
    return res;
  }

  private selection(): Record<string, unknown> {
    const id = this.cfg.thermostatId ?? this.ctx.store.get<string>(`ecobee:${this.id}`, 'thermostatId');
    return id
      ? { selectionType: 'thermostats', selectionMatch: id }
      : { selectionType: 'registered', selectionMatch: '' };
  }

  private async callFunction(type: string, params: Record<string, unknown>): Promise<void> {
    await this.authed(`${API}/1/thermostat?format=json`, {
      method: 'POST',
      body: JSON.stringify({ selection: this.selection(), functions: [{ type, params }] }),
    });
  }

  private async update(thermostat: Record<string, unknown>): Promise<void> {
    await this.authed(`${API}/1/thermostat?format=json`, {
      method: 'POST',
      body: JSON.stringify({ selection: this.selection(), thermostat }),
    });
  }

  private display(valueF: number | null): number | null {
    if (valueF === null) return null;
    const value = this.cfg.scale === 'C' ? fToC(valueF) : valueF;
    return Math.round(value * 10) / 10;
  }

  private toTenthsF(displayValue: number): number {
    const f = this.cfg.scale === 'C' ? cToF(displayValue) : displayValue;
    return Math.round(f * 10);
  }
}

/**
 * Ecobee reports running equipment as a comma-separated list of relay names.
 * Space heating is heatPump/auxHeat, cooling is compCool; compHotWater and
 * auxHotWater are the water heater and must not be read as heating.
 */
export function runningState(equipment: string[]): 'heating' | 'cooling' | 'fan' | 'idle' {
  if (equipment.some((e) => e.startsWith('heatPump') || e.startsWith('auxHeat'))) return 'heating';
  if (equipment.some((e) => e.startsWith('compCool'))) return 'cooling';
  if (equipment.some((e) => e === 'fan' || e === 'ventilator')) return 'fan';
  return 'idle';
}

function sensorNumber(
  capabilities: EcobeeSensorCapability[] | undefined,
  type: string,
  divisor: number,
): number | null {
  const cap = capabilities?.find((c) => c.type === type);
  if (!cap) return null;
  const n = Number(cap.value);
  return Number.isFinite(n) ? n / divisor : null;
}

function sensorBool(capabilities: EcobeeSensorCapability[] | undefined, type: string): boolean | null {
  const cap = capabilities?.find((c) => c.type === type);
  if (!cap) return null;
  return cap.value === 'true';
}
