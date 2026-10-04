import type { DeviceConfig } from '../config.js';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../util/color.js';
import { clamp } from '../util/async.js';
import { BadRequestError } from '../errors.js';
import {
  DeviceAdapter,
  NeedsSetupError,
  UnsupportedCommandError,
  bool,
  num,
  str,
  type Capability,
  type CommandResult,
  type CommandSpec,
  type DeviceContext,
  type DeviceState,
} from './types.js';

type NanoleafConfig = Extract<DeviceConfig, { type: 'nanoleaf' }>;

interface NanoleafValue {
  value: number;
  max?: number;
  min?: number;
}

interface NanoleafInfo {
  name?: string;
  serialNo?: string;
  model?: string;
  firmwareVersion?: string;
  state?: {
    on?: { value: boolean };
    brightness?: NanoleafValue;
    hue?: NanoleafValue;
    sat?: NanoleafValue;
    ct?: NanoleafValue;
    colorMode?: string;
  };
  effects?: {
    select?: string;
    effectsList?: string[];
  };
  panelLayout?: {
    layout?: { numPanels?: number };
  };
}

/**
 * Nanoleaf Open API (Light Panels / Shapes / Canvas / Lines). Plain HTTP on
 * port 16021 with a bearer-ish token in the path. The token is minted by
 * holding the power button for 5-7 seconds and POSTing to /api/v1/new, which
 * `pair()` does; it then lives in the state file.
 */
export class NanoleafAdapter extends DeviceAdapter {
  readonly type = 'nanoleaf';
  readonly icon = 'nanoleaf';
  readonly capabilities: Capability[] = ['power', 'brightness', 'color', 'colorTemp', 'effects'];

  private token: string | undefined;

  constructor(ctx: DeviceContext, private readonly cfg: NanoleafConfig) {
    super(ctx);
    this.pollIntervalMs = (cfg.pollSeconds ?? 10) * 1000;
  }

  override async init(): Promise<void> {
    this.token = this.cfg.token ?? this.ctx.store.get<string>(`nanoleaf:${this.id}`, 'token');
  }

  private get base(): string {
    if (!this.token) {
      throw new NeedsSetupError(
        'Nanoleaf is not paired yet. Hold the power button on the controller for 5-7 seconds until the LED flashes, then press Pair.',
      );
    }
    return `http://${this.cfg.host}:${this.cfg.port}/api/v1/${this.token}`;
  }

  override setupHint(): string | undefined {
    return this.token
      ? undefined
      : 'Hold the Nanoleaf power button for 5-7 seconds until the LED flashes, then press Pair.';
  }

  /** Mint a new auth token. The controller must be in pairing mode. */
  async pair(): Promise<{ token: string }> {
    const res = await this.ctx.transport.http(`http://${this.cfg.host}:${this.cfg.port}/api/v1/new`, {
      method: 'POST',
      timeoutMs: 8000,
      allowStatus: true,
    });
    if (res.status === 403) {
      throw new Error(
        'Nanoleaf refused pairing (403). Hold the power button for 5-7 seconds until the LED flashes, then try again within 30 seconds.',
      );
    }
    if (!res.ok) throw new Error(`Nanoleaf pairing failed with HTTP ${res.status}`);
    const body = res.json<{ auth_token?: string }>();
    if (!body.auth_token) throw new Error('Nanoleaf pairing response did not contain an auth_token');
    this.token = body.auth_token;
    this.ctx.store.set(`nanoleaf:${this.id}`, 'token', body.auth_token);
    await this.ctx.store.flush();
    this.ctx.logger.info('paired successfully, token stored');
    return { token: body.auth_token };
  }

  commands(): CommandSpec[] {
    const effects = (this.ctx.store.get<string[]>(`nanoleaf:${this.id}`, 'effects') ?? []).map((name) => ({
      value: name,
      label: name,
    }));
    return [
      {
        name: 'power',
        label: 'Power',
        group: 'power',
        params: [{ name: 'on', type: 'boolean', label: 'On', required: true }],
      },
      { name: 'toggle', label: 'Toggle', group: 'power' },
      {
        name: 'brightness',
        label: 'Brightness',
        group: 'light',
        params: [
          { name: 'value', type: 'number', min: 0, max: 100, step: 1, unit: '%', required: true },
          { name: 'duration', type: 'number', min: 0, max: 60, unit: 's', default: 0 },
        ],
      },
      {
        name: 'color',
        label: 'Colour',
        group: 'light',
        params: [{ name: 'hex', type: 'string', label: 'Hex colour', required: true, default: '#ff8c1a' }],
      },
      {
        name: 'colorTemp',
        label: 'White temperature',
        group: 'light',
        params: [{ name: 'kelvin', type: 'number', min: 1200, max: 6500, step: 100, unit: 'K', required: true }],
      },
      {
        name: 'effect',
        label: 'Effect',
        group: 'light',
        params: [{ name: 'name', type: 'enum', required: true, options: effects }],
      },
      { name: 'identify', label: 'Identify', group: 'diagnostic' },
    ];
  }

  async refresh(): Promise<Omit<DeviceState, 'online' | 'updatedAt'>> {
    if (!this.token) return { needsSetup: true, paired: false };
    const res = await this.ctx.transport.http(this.base, { timeoutMs: 5000, allowStatus: true });
    if (res.status === 401 || res.status === 403) {
      // Token was revoked (factory reset or removed from the app).
      this.ctx.logger.warn('stored token rejected by the controller, clearing it');
      this.token = undefined;
      this.ctx.store.delete(`nanoleaf:${this.id}`, 'token');
      return { needsSetup: true, paired: false, error: 'Stored Nanoleaf token was rejected; pair again.' };
    }
    if (!res.ok) throw new Error(`Nanoleaf returned HTTP ${res.status}`);

    const info = res.json<NanoleafInfo>();
    const state = info.state ?? {};
    const hue = state.hue?.value ?? 0;
    const sat = state.sat?.value ?? 0;
    const brightness = state.brightness?.value ?? 0;
    const effects = info.effects?.effectsList ?? [];
    this.ctx.store.set(`nanoleaf:${this.id}`, 'effects', effects);

    return {
      paired: true,
      on: state.on?.value ?? false,
      brightness,
      hue,
      saturation: sat,
      colorTempK: state.ct?.value ?? null,
      colorMode: state.colorMode ?? 'unknown',
      // Report brightness-independent colour so a dimmed swatch still reads true.
      hex: rgbToHex(hsvToRgb({ h: hue, s: sat, v: 100 })),
      effect: info.effects?.select ?? null,
      effects,
      panels: info.panelLayout?.layout?.numPanels ?? null,
      model: info.model ?? null,
      firmware: info.firmwareVersion ?? null,
      serial: info.serialNo ?? null,
      host: this.cfg.host,
    };
  }

  async execute(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    switch (command) {
      case 'power':
        await this.put('/state', { on: { value: bool(params, 'on') } });
        return { ok: true };

      case 'toggle': {
        const current = await this.refresh();
        const next = !(current['on'] === true);
        await this.put('/state', { on: { value: next } });
        return { ok: true, message: next ? 'Lights on' : 'Lights off' };
      }

      case 'brightness': {
        const value = clamp(Math.round(num(params, 'value')), 0, 100);
        const duration = Math.round(num(params, 'duration', 0));
        await this.put('/state', { brightness: { value, duration } });
        return { ok: true };
      }

      case 'color': {
        const hex = str(params, 'hex');
        const rgb = hexToRgb(hex);
        if (!rgb) throw new BadRequestError(`"${hex}" is not a hex colour like #ff8c1a`);
        const hsv = rgbToHsv(rgb);
        // Writing hue+sat implicitly switches the panels out of effect mode.
        await this.put('/state', { hue: { value: hsv.h } });
        await this.put('/state', { sat: { value: hsv.s } });
        if (params['keepBrightness'] !== true) {
          await this.put('/state', { brightness: { value: clamp(hsv.v, 1, 100) } });
        }
        return { ok: true, data: { hex: rgbToHex(rgb) } };
      }

      case 'colorTemp': {
        const kelvin = clamp(Math.round(num(params, 'kelvin')), 1200, 6500);
        await this.put('/state', { ct: { value: kelvin } });
        return { ok: true };
      }

      case 'effect': {
        const name = str(params, 'name');
        await this.put('/effects', { select: name });
        return { ok: true, message: `Effect: ${name}` };
      }

      case 'identify':
        await this.put('/identify', {});
        return { ok: true, message: 'Flashing panels' };

      default:
        throw new UnsupportedCommandError(command, this.type);
    }
  }

  private async put(pathname: string, body: unknown): Promise<void> {
    await this.ctx.transport.http(`${this.base}${pathname}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 5000,
    });
  }
}
