import type { DeviceConfig } from '../config.js';
import { BadRequestError } from '../errors.js';
import { broadcastFor, wake } from '../protocols/wol.js';
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

type AndroidTvConfig = Extract<DeviceConfig, { type: 'androidtv' }>;

/** Android keyevent names accepted by `adb shell input keyevent`. */
const KEY_MAP: Record<string, string> = {
  Home: 'KEYCODE_HOME',
  Back: 'KEYCODE_BACK',
  Up: 'KEYCODE_DPAD_UP',
  Down: 'KEYCODE_DPAD_DOWN',
  Left: 'KEYCODE_DPAD_LEFT',
  Right: 'KEYCODE_DPAD_RIGHT',
  Select: 'KEYCODE_DPAD_CENTER',
  Play: 'KEYCODE_MEDIA_PLAY_PAUSE',
  Rev: 'KEYCODE_MEDIA_REWIND',
  Fwd: 'KEYCODE_MEDIA_FAST_FORWARD',
  VolumeUp: 'KEYCODE_VOLUME_UP',
  VolumeDown: 'KEYCODE_VOLUME_DOWN',
  VolumeMute: 'KEYCODE_VOLUME_MUTE',
  Info: 'KEYCODE_INFO',
  Search: 'KEYCODE_SEARCH',
  Power: 'KEYCODE_POWER',
  Sleep: 'KEYCODE_SLEEP',
  Wakeup: 'KEYCODE_WAKEUP',
};

const INPUT_MAP: Record<string, string> = {
  hdmi1: 'HW1',
  hdmi2: 'HW2',
  hdmi3: 'HW3',
  hdmi4: 'HW4',
};

/**
 * TCL sets sold as "Google TV" / "Android TV" rather than Roku TV. There is no
 * open LAN control API, so this drives the set through ADB over TCP, which
 * works once "Network debugging" is on under Developer options. You must accept
 * the RSA prompt on the TV the first time the hub connects.
 */
export class AndroidTvAdapter extends DeviceAdapter {
  readonly type = 'androidtv';
  readonly icon = 'tv';
  readonly capabilities: Capability[] = ['power', 'volume', 'remote', 'inputs', 'apps', 'media'];

  constructor(ctx: DeviceContext, private readonly cfg: AndroidTvConfig) {
    super(ctx);
    this.pollIntervalMs = (cfg.pollSeconds ?? 20) * 1000;
  }

  private get target(): string {
    return `${this.cfg.host}:${this.cfg.adbPort}`;
  }

  override setupHint(): string | undefined {
    return 'Enable Settings > System > Developer options > Network debugging on the TV, then accept the RSA fingerprint prompt the first time the hub connects. Requires the `adb` binary (apt install adb).';
  }

  commands(): CommandSpec[] {
    return [
      { name: 'power', label: 'Power', group: 'power', params: [{ name: 'on', type: 'boolean', required: true }] },
      { name: 'toggle', label: 'Toggle', group: 'power' },
      {
        name: 'key',
        label: 'Remote key',
        group: 'navigation',
        params: [
          { name: 'key', type: 'enum', required: true, options: Object.keys(KEY_MAP).map((k) => ({ value: k, label: k })) },
        ],
      },
      {
        name: 'volume',
        label: 'Volume step',
        group: 'audio',
        params: [{ name: 'delta', type: 'number', min: -20, max: 20, required: true }],
      },
      { name: 'mute', label: 'Mute', group: 'audio' },
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
        label: 'Launch package',
        group: 'source',
        params: [{ name: 'packageName', type: 'string', required: true, default: 'com.netflix.ninja' }],
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
    await this.connect();
    const screen = await this.shell('dumpsys power | grep -m 1 "mWakefulness="');
    const awake = /mWakefulness=Awake/i.test(screen);
    const state: Record<string, unknown> = {
      on: awake,
      host: this.cfg.host,
      adbTarget: this.target,
    };

    if (awake) {
      const focus = await this.shell('dumpsys window | grep -m 1 mCurrentFocus');
      const pkg = /mCurrentFocus=.*?\{[^}]*\s([\w.]+)\//.exec(focus);
      state['activeApp'] = pkg?.[1] ?? null;
      const volume = await this.shell('cmd media_session volume --get --stream 3');
      const vol = /volume is (\d+) in range \[(\d+)\.\.(\d+)\]/.exec(volume);
      if (vol?.[1] && vol[3]) {
        state['volume'] = Math.round((Number(vol[1]) / Number(vol[3])) * 100);
      }
    }
    return state;
  }

  async execute(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    switch (command) {
      case 'power': {
        const on = bool(params, 'on');
        if (on && this.cfg.mac) {
          const broadcast = broadcastFor(this.cfg.host);
          await wake(this.ctx.transport, this.cfg.mac, broadcast ? { broadcastAddress: broadcast } : {});
        }
        await this.connect();
        await this.keyevent(on ? KEY_MAP['Wakeup']! : KEY_MAP['Sleep']!);
        return { ok: true, message: on ? 'TV on' : 'TV off' };
      }

      case 'toggle':
        await this.connect();
        await this.keyevent(KEY_MAP['Power']!);
        return { ok: true };

      case 'key': {
        const key = str(params, 'key');
        const code = KEY_MAP[key];
        if (!code) {
          throw new BadRequestError(`unknown key "${key}" (expected one of ${Object.keys(KEY_MAP).join(', ')})`);
        }
        await this.connect();
        await this.keyevent(code);
        return { ok: true };
      }

      case 'volume': {
        const delta = Math.round(num(params, 'delta'));
        const code = delta >= 0 ? KEY_MAP['VolumeUp']! : KEY_MAP['VolumeDown']!;
        await this.connect();
        for (let i = 0; i < Math.min(Math.abs(delta), 20); i += 1) await this.keyevent(code);
        return { ok: true };
      }

      case 'mute':
        await this.connect();
        await this.keyevent(KEY_MAP['VolumeMute']!);
        return { ok: true };

      case 'input': {
        const input = str(params, 'input').toLowerCase();
        const port = INPUT_MAP[input];
        if (!port) throw new BadRequestError(`unknown input "${input}"`);
        await this.connect();
        await this.shell(
          `am start -a android.intent.action.VIEW -d "content://android.media.tv/passthrough/com.android.tv.input.hdmi%2F.HdmiInputService%2F${port}"`,
        );
        return { ok: true, message: `Input: ${input.toUpperCase()}` };
      }

      case 'launch': {
        const pkg = str(params, 'packageName');
        await this.connect();
        await this.shell(`monkey -p ${shellQuote(pkg)} -c android.intent.category.LAUNCHER 1`);
        return { ok: true };
      }

      case 'text': {
        const text = str(params, 'text');
        await this.connect();
        await this.shell(`input text ${shellQuote(text.replace(/ /g, '%s'))}`);
        return { ok: true };
      }

      default:
        throw new UnsupportedCommandError(command, this.type);
    }
  }

  private async connect(): Promise<void> {
    const res = await this.ctx.transport.exec(this.cfg.adbPath, ['connect', this.target], 8000);
    const out = `${res.stdout}${res.stderr}`;
    if (/unable to connect|failed to connect|cannot connect/i.test(out)) {
      throw new Error(`adb could not reach ${this.target}: ${out.trim()}`);
    }
    if (/unauthorized/i.test(out)) {
      throw new Error(`adb is unauthorized for ${this.target}; accept the RSA prompt on the TV screen`);
    }
  }

  private async shell(script: string): Promise<string> {
    const res = await this.ctx.transport.exec(this.cfg.adbPath, ['-s', this.target, 'shell', script], 10_000);
    if (res.code !== 0 && res.stderr.trim()) {
      throw new Error(`adb shell failed: ${res.stderr.trim()}`);
    }
    return res.stdout;
  }

  private async keyevent(code: string): Promise<void> {
    await this.shell(`input keyevent ${code}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
