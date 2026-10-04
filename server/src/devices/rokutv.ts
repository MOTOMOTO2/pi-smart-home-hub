import type { DeviceConfig } from '../config.js';
import { BadRequestError } from '../errors.js';
import { broadcastFor, wake } from '../protocols/wol.js';
import { xmlElements, xmlText } from '../util/xml.js';
import {
  DeviceAdapter,
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

type RokuTvConfig = Extract<DeviceConfig, { type: 'rokutv' }>;

/** Keys the Roku External Control Protocol accepts on /keypress/<key>. */
export const ROKU_KEYS = [
  'Home',
  'Rev',
  'Fwd',
  'Play',
  'Select',
  'Left',
  'Right',
  'Down',
  'Up',
  'Back',
  'InstantReplay',
  'Info',
  'Backspace',
  'Search',
  'Enter',
  'VolumeDown',
  'VolumeUp',
  'VolumeMute',
  'PowerOff',
  'PowerOn',
  'Power',
  'ChannelUp',
  'ChannelDown',
  'InputTuner',
  'InputHDMI1',
  'InputHDMI2',
  'InputHDMI3',
  'InputHDMI4',
  'InputAV1',
] as const;

const INPUT_MAP: Record<string, string> = {
  tuner: 'InputTuner',
  hdmi1: 'InputHDMI1',
  hdmi2: 'InputHDMI2',
  hdmi3: 'InputHDMI3',
  hdmi4: 'InputHDMI4',
  av1: 'InputAV1',
};

interface RokuApp {
  id: string;
  name: string;
}

/**
 * TCL Roku TV over ECP: an unauthenticated HTTP API on port 8060 that every
 * Roku-powered set exposes on the LAN. Covers power, volume, the full remote,
 * HDMI input switching and app launching.
 *
 * Note that the TV only answers while it is in standby if "Fast TV Start" is
 * enabled (Settings > System > Power). Without it, PowerOn needs Wake-on-LAN,
 * which is why `mac` is worth filling in.
 */
export class RokuTvAdapter extends DeviceAdapter {
  readonly type = 'rokutv';
  readonly icon = 'tv';
  readonly capabilities: Capability[] = ['power', 'volume', 'remote', 'inputs', 'apps', 'media'];

  constructor(ctx: DeviceContext, private readonly cfg: RokuTvConfig) {
    super(ctx);
    this.pollIntervalMs = (cfg.pollSeconds ?? 12) * 1000;
  }

  private get base(): string {
    return `http://${this.cfg.host}:${this.cfg.port}`;
  }

  override setupHint(): string | undefined {
    return 'If the TV does not respond from standby, enable Settings > System > Power > Fast TV Start, or set a `mac` so the hub can wake it over Wake-on-LAN.';
  }

  commands(): CommandSpec[] {
    const apps = (this.ctx.store.get<RokuApp[]>(`rokutv:${this.id}`, 'apps') ?? []).map((app) => ({
      value: app.id,
      label: app.name,
    }));
    return [
      {
        name: 'power',
        label: 'Power',
        group: 'power',
        params: [{ name: 'on', type: 'boolean', required: true }],
      },
      { name: 'toggle', label: 'Toggle', group: 'power' },
      {
        name: 'key',
        label: 'Remote key',
        group: 'navigation',
        params: [
          {
            name: 'key',
            type: 'enum',
            required: true,
            options: ROKU_KEYS.map((k) => ({ value: k, label: k })),
          },
        ],
      },
      {
        name: 'volume',
        label: 'Volume step',
        group: 'audio',
        params: [{ name: 'delta', type: 'number', min: -20, max: 20, required: true }],
      },
      {
        name: 'mute',
        label: 'Mute',
        group: 'audio',
      },
      {
        name: 'input',
        label: 'Input',
        group: 'source',
        params: [
          {
            name: 'input',
            type: 'enum',
            required: true,
            options: Object.keys(INPUT_MAP).map((k) => ({ value: k, label: k.toUpperCase() })),
          },
        ],
      },
      {
        name: 'launch',
        label: 'Launch app',
        group: 'source',
        params: [{ name: 'appId', type: 'enum', required: true, options: apps }],
      },
      {
        name: 'text',
        label: 'Type text',
        group: 'navigation',
        params: [{ name: 'text', type: 'string', required: true }],
      },
    ];
  }

  async refresh(): Promise<Omit<DeviceState, 'online' | 'updatedAt'>> {
    const info = await this.ctx.transport.http(`${this.base}/query/device-info`, { timeoutMs: 4000 });
    const xml = info.text();
    const powerMode = xmlText(xml, 'power-mode') ?? 'Unknown';

    const state: Record<string, unknown> = {
      on: powerMode === 'PowerOn',
      powerMode,
      model: xmlText(xml, 'model-name') ?? xmlText(xml, 'friendly-model-name') ?? null,
      vendor: xmlText(xml, 'vendor-name') ?? null,
      serial: xmlText(xml, 'serial-number') ?? null,
      softwareVersion: xmlText(xml, 'software-version') ?? null,
      friendlyName: xmlText(xml, 'friendly-device-name') ?? this.name,
      supportsWake: xmlText(xml, 'supports-wake-on-wlan') === 'true' || Boolean(this.cfg.mac),
      host: this.cfg.host,
    };

    const volume = xmlText(xml, 'volume-level');
    if (volume !== undefined) state['volume'] = Number(volume);
    const muted = xmlText(xml, 'is-muted');
    if (muted !== undefined) state['muted'] = muted === 'true';

    // A set in standby answers device-info but not the app/media queries.
    if (state['on'] === true) {
      const [active, apps, media] = await Promise.allSettled([
        this.ctx.transport.http(`${this.base}/query/active-app`, { timeoutMs: 4000 }),
        this.ctx.transport.http(`${this.base}/query/apps`, { timeoutMs: 4000 }),
        this.ctx.transport.http(`${this.base}/query/media-player`, { timeoutMs: 4000, allowStatus: true }),
      ]);

      if (active.status === 'fulfilled') {
        const activeXml = active.value.text();
        const app = xmlElements(activeXml, 'app')[0];
        const input = xmlElements(activeXml, 'input')[0];
        // Roku puts the friendly label in the element text ("HDMI2") and the
        // routing id in the attribute ("tvinput.hdmi2"); show the label.
        state['activeApp'] = app?.text || input?.text || input?.attrs['id'] || 'Home';
        state['activeAppId'] = app?.attrs['id'] ?? input?.attrs['id'] ?? null;
      }
      if (apps.status === 'fulfilled') {
        const list: RokuApp[] = xmlElements(apps.value.text(), 'app')
          .filter((el) => el.attrs['id'])
          .map((el) => ({ id: el.attrs['id'] as string, name: el.text || (el.attrs['id'] as string) }));
        this.ctx.store.set(`rokutv:${this.id}`, 'apps', list);
        state['apps'] = list;
      }
      if (media.status === 'fulfilled' && media.value.ok) {
        const mediaXml = media.value.text();
        const player = xmlElements(mediaXml, 'player')[0];
        const playState = player?.attrs['state'] ?? 'none';
        state['playState'] = playState;
        if (playState !== 'none' && playState !== 'close') {
          state['nowPlaying'] = {
            title: xmlText(mediaXml, 'title') ?? null,
            positionMs: parseMs(xmlText(mediaXml, 'position')),
            durationMs: parseMs(xmlText(mediaXml, 'duration')),
          };
        }
      }
    }

    return state;
  }

  async execute(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    switch (command) {
      case 'power': {
        const on = bool(params, 'on');
        if (on) return await this.powerOn();
        await this.keypress('PowerOff');
        return { ok: true, message: 'TV off' };
      }

      case 'toggle': {
        const current = await this.refresh();
        if (current['on'] === true) {
          await this.keypress('PowerOff');
          return { ok: true, message: 'TV off' };
        }
        return await this.powerOn();
      }

      case 'key': {
        const key = str(params, 'key');
        if (!(ROKU_KEYS as readonly string[]).includes(key)) {
          throw new BadRequestError(`unknown Roku key "${key}"`);
        }
        await this.keypress(key);
        return { ok: true };
      }

      case 'volume': {
        const delta = Math.round(num(params, 'delta'));
        const key = delta >= 0 ? 'VolumeUp' : 'VolumeDown';
        for (let i = 0; i < Math.min(Math.abs(delta), 20); i += 1) {
          await this.keypress(key);
        }
        return { ok: true };
      }

      case 'mute':
        await this.keypress('VolumeMute');
        return { ok: true };

      case 'input': {
        const input = str(params, 'input').toLowerCase();
        const key = INPUT_MAP[input];
        if (!key) {
          throw new BadRequestError(`unknown input "${input}" (expected one of ${Object.keys(INPUT_MAP).join(', ')})`);
        }
        await this.keypress(key);
        return { ok: true, message: `Input: ${input.toUpperCase()}` };
      }

      case 'launch': {
        const appId = str(params, 'appId');
        await this.ctx.transport.http(`${this.base}/launch/${encodeURIComponent(appId)}`, {
          method: 'POST',
          timeoutMs: 5000,
        });
        return { ok: true };
      }

      case 'text': {
        const text = str(params, 'text');
        for (const char of [...text].slice(0, 120)) {
          await this.ctx.transport.http(`${this.base}/keypress/Lit_${encodeURIComponent(char)}`, {
            method: 'POST',
            timeoutMs: 4000,
          });
        }
        return { ok: true };
      }

      default:
        throw new UnsupportedCommandError(command, this.type);
    }
  }

  private async powerOn(): Promise<CommandResult> {
    // Try ECP first; fall back to Wake-on-LAN when the set is fully asleep.
    try {
      await this.keypress('PowerOn');
      return { ok: true, message: 'TV on' };
    } catch (err) {
      if (!this.cfg.mac) throw err;
      this.ctx.logger.info('ECP PowerOn failed, falling back to Wake-on-LAN');
      const broadcast = broadcastFor(this.cfg.host);
      await wake(this.ctx.transport, this.cfg.mac, broadcast ? { broadcastAddress: broadcast } : {});
      return { ok: true, message: 'Sent Wake-on-LAN to the TV' };
    }
  }

  private async keypress(key: string): Promise<void> {
    await this.ctx.transport.http(`${this.base}/keypress/${key}`, { method: 'POST', timeoutMs: 4000 });
  }
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+)/.exec(value.trim());
  return m && m[1] ? Number(m[1]) : null;
}
