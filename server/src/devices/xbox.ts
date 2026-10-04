import type { DeviceConfig } from '../config.js';
import {
  SMARTGLASS_PORT,
  discoveryRequest,
  parseDiscoveryResponse,
  powerOnRequest,
} from '../protocols/smartglass.js';
import { BadRequestError, NeedsSetupError } from '../errors.js';
import {
  DeviceAdapter,
  UnsupportedCommandError,
  bool,
  type Capability,
  type CommandResult,
  type CommandSpec,
  type DeviceContext,
  type DeviceState,
} from './types.js';

type XboxConfig = Extract<DeviceConfig, { type: 'xbox' }>;

/**
 * Xbox One S over the unauthenticated part of the SmartGlass protocol
 * (UDP/5050): discovery tells you whether the console is awake and what it is
 * called, and a power-on packet wakes it from standby.
 *
 * Power *off* and title launching need a pairing handshake plus an Xbox Live
 * token, which would mean storing Microsoft account credentials on the Pi, so
 * this adapter deliberately stops at wake + status. The console must have
 * "Instant-on" power mode set for wake to work at all.
 */
export class XboxAdapter extends DeviceAdapter {
  readonly type = 'xbox';
  readonly icon = 'xbox';
  readonly capabilities: Capability[] = ['wake', 'sensors'];

  private liveId: string | undefined;

  constructor(ctx: DeviceContext, private readonly cfg: XboxConfig) {
    super(ctx);
    this.pollIntervalMs = (cfg.pollSeconds ?? 20) * 1000;
  }

  override async init(): Promise<void> {
    this.liveId = this.cfg.liveId ?? this.ctx.store.get<string>(`xbox:${this.id}`, 'liveId');
  }

  override setupHint(): string | undefined {
    if (this.liveId) return undefined;
    return 'Turn the console on and press Refresh: the hub reads its live ID from the discovery response and remembers it, after which it can wake the console. Set Settings > General > Power mode to Instant-on.';
  }

  commands(): CommandSpec[] {
    return [
      {
        name: 'power',
        label: 'Power',
        group: 'power',
        params: [{ name: 'on', type: 'boolean', required: true, default: true }],
      },
      { name: 'wake', label: 'Wake console', group: 'power' },
    ];
  }

  async refresh(): Promise<Omit<DeviceState, 'online' | 'updatedAt'>> {
    const targets = this.probeTargets();
    const packet = discoveryRequest();

    for (const host of targets) {
      const replies = await this.ctx.transport.udp({ host, port: SMARTGLASS_PORT }, packet, {
        broadcast: host.endsWith('.255') || host === '255.255.255.255',
        collectMs: 900,
      });
      for (const reply of replies) {
        const parsed = parseDiscoveryResponse(reply.data);
        if (!parsed) continue;
        // Only accept a reply from our console once we know which one it is.
        if (this.cfg.host && reply.from !== this.cfg.host) continue;
        if (parsed.liveId && parsed.liveId !== this.liveId) {
          this.liveId = parsed.liveId;
          this.ctx.store.set(`xbox:${this.id}`, 'liveId', parsed.liveId);
          this.ctx.logger.info(`learned live ID ${parsed.liveId} from discovery`);
        }
        return {
          on: true,
          consoleName: parsed.name || null,
          uuid: parsed.uuid || null,
          liveId: this.liveId ?? null,
          host: reply.from,
          canWake: Boolean(this.liveId),
          lastSeen: Date.now(),
        };
      }
    }

    // No discovery reply means standby or powered down, not an error: a
    // console in Instant-on standby stops answering on 5050.
    return {
      on: false,
      consoleName: (this.ctx.store.get<string>(`xbox:${this.id}`, 'name') ?? null) as string | null,
      liveId: this.liveId ?? null,
      host: this.cfg.host ?? null,
      canWake: Boolean(this.liveId),
      needsSetup: !this.liveId,
    };
  }

  async execute(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    switch (command) {
      case 'wake':
        return await this.wake();

      case 'power': {
        const on = bool(params, 'on', true);
        if (!on) {
          throw new BadRequestError(
            'Powering the Xbox off needs an authenticated SmartGlass session (Xbox Live sign-in), which this hub does not store. Use the controller or say "Xbox, turn off".',
          );
        }
        return await this.wake();
      }

      default:
        throw new UnsupportedCommandError(command, this.type);
    }
  }

  private async wake(): Promise<CommandResult> {
    if (!this.liveId) {
      throw new NeedsSetupError(
        'No Xbox live ID known yet. Turn the console on and refresh the device so the hub can learn it, or set `liveId` in config.',
      );
    }
    const packet = powerOnRequest(this.liveId);
    // The console frequently misses the first packet coming out of standby, so
    // the reference implementations all send a short burst.
    for (const host of this.wakeTargets()) {
      await this.ctx.transport.udp({ host, port: SMARTGLASS_PORT }, packet, {
        broadcast: host.endsWith('.255') || host === '255.255.255.255',
        repeat: 5,
        repeatDelayMs: 500,
      });
    }
    return { ok: true, message: 'Wake packet sent; the console takes a few seconds to come up' };
  }

  private probeTargets(): string[] {
    const targets: string[] = [];
    if (this.cfg.host) targets.push(this.cfg.host);
    const broadcast = this.cfg.broadcastAddress;
    if (broadcast) targets.push(broadcast);
    if (targets.length === 0) targets.push('255.255.255.255');
    return targets;
  }

  private wakeTargets(): string[] {
    const targets = new Set<string>(this.probeTargets());
    targets.add('255.255.255.255');
    return [...targets];
  }
}
