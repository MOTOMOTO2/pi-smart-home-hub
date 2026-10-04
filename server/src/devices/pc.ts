import type { DeviceConfig } from '../config.js';
import { BadRequestError } from '../errors.js';
import { broadcastFor, normalizeMac, wake } from '../protocols/wol.js';
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

type PcConfig = Extract<DeviceConfig, { type: 'pc' }>;

interface AgentStatus {
  hostname?: string;
  platform?: string;
  uptimeSeconds?: number;
  loadAverage?: number[];
  memory?: { totalMb: number; freeMb: number };
  agentVersion?: string;
}

/**
 * Desktop PC control. Waking is pure Wake-on-LAN, which needs no software on
 * the PC but also cannot do anything else -- there is no standard way to put a
 * machine to sleep from the network. Sleep/shutdown/restart/lock therefore go
 * through the small companion agent in agents/pc-agent, which you run on the
 * PC with a shared token. Without an agent configured the adapter still works,
 * it just offers wake plus a TCP reachability check.
 */
export class PcAdapter extends DeviceAdapter {
  readonly type = 'pc';
  readonly icon = 'desktop';
  readonly capabilities: Capability[];

  constructor(ctx: DeviceContext, private readonly cfg: PcConfig) {
    super(ctx);
    this.pollIntervalMs = (cfg.pollSeconds ?? 20) * 1000;
    // Without the agent the hub can wake the PC but has no way to put it back
    // to sleep, so it must not advertise two-way power control.
    this.capabilities = cfg.agentUrl ? ['power', 'wake', 'sensors'] : ['wake', 'sensors'];
  }

  private get hasAgent(): boolean {
    return Boolean(this.cfg.agentUrl);
  }

  override setupHint(): string | undefined {
    if (!this.cfg.mac) {
      return 'Set `mac` to the PC wired NIC address and enable Wake-on-LAN in its BIOS and adapter settings, otherwise the hub cannot wake it.';
    }
    if (!this.hasAgent) {
      return 'Sleep, shutdown, restart and lock need the companion agent: run agents/pc-agent on the PC, then set `agentUrl` and `agentToken`.';
    }
    return undefined;
  }

  commands(): CommandSpec[] {
    const commands: CommandSpec[] = [
      { name: 'wake', label: 'Wake', group: 'power', icon: 'power' },
      { name: 'power', label: 'Power', group: 'power', params: [{ name: 'on', type: 'boolean', required: true }] },
    ];
    if (this.hasAgent) {
      commands.push(
        { name: 'sleep', label: 'Sleep', group: 'power' },
        { name: 'shutdown', label: 'Shut down', group: 'power' },
        { name: 'restart', label: 'Restart', group: 'power' },
        { name: 'lock', label: 'Lock screen', group: 'power' },
      );
    }
    return commands;
  }

  async refresh(): Promise<Omit<DeviceState, 'online' | 'updatedAt'>> {
    const state: Record<string, unknown> = {
      host: this.cfg.host ?? null,
      mac: this.cfg.mac ? normalizeMac(this.cfg.mac) : null,
      hasAgent: this.hasAgent,
      canWake: Boolean(this.cfg.mac),
    };

    if (this.hasAgent) {
      try {
        const res = await this.agent('/status', 'GET');
        const status = res.json<AgentStatus>();
        return {
          ...state,
          on: true,
          hostname: status.hostname ?? null,
          platform: status.platform ?? null,
          uptimeSeconds: status.uptimeSeconds ?? null,
          memory: status.memory ?? null,
          agentVersion: status.agentVersion ?? null,
        };
      } catch (err) {
        // An unreachable agent is the normal state of a sleeping PC.
        this.ctx.logger.debug('agent unreachable, treating PC as off', err);
        return { ...state, on: false };
      }
    }

    if (this.cfg.host) {
      const up = await this.ctx.transport.tcpProbe(this.cfg.host, this.cfg.probePort, 1200);
      return { ...state, on: up, probePort: this.cfg.probePort };
    }

    return { ...state, on: null, note: 'Set `host` or `agentUrl` to report power state' };
  }

  async execute(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    switch (command) {
      case 'wake':
        return await this.doWake();

      case 'power': {
        const on = bool(params, 'on');
        if (on) return await this.doWake();
        return await this.agentAction('shutdown', 'Shutting down');
      }

      case 'sleep':
        return await this.agentAction('sleep', 'Going to sleep');
      case 'shutdown':
        return await this.agentAction('shutdown', 'Shutting down');
      case 'restart':
        return await this.agentAction('restart', 'Restarting');
      case 'lock':
        return await this.agentAction('lock', 'Screen locked');

      default:
        throw new UnsupportedCommandError(command, this.type);
    }
  }

  private async doWake(): Promise<CommandResult> {
    if (!this.cfg.mac) {
      throw new BadRequestError('No `mac` configured for this PC, so Wake-on-LAN is not possible.');
    }
    const broadcast = this.cfg.broadcastAddress ?? (this.cfg.host ? broadcastFor(this.cfg.host) : undefined);
    await wake(this.ctx.transport, this.cfg.mac, broadcast ? { broadcastAddress: broadcast } : {});
    return { ok: true, message: 'Magic packet sent' };
  }

  private async agentAction(action: string, message: string): Promise<CommandResult> {
    if (!this.hasAgent) {
      throw new BadRequestError(
        `"${action}" needs the companion agent. Run agents/pc-agent on the PC and set agentUrl + agentToken in config.`,
      );
    }
    await this.agent(`/${action}`, 'POST');
    return { ok: true, message };
  }

  private async agent(pathname: string, method: 'GET' | 'POST') {
    const base = (this.cfg.agentUrl ?? '').replace(/\/$/, '');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.cfg.agentToken) headers['authorization'] = `Bearer ${this.cfg.agentToken}`;
    return await this.ctx.transport.http(`${base}${pathname}`, { method, headers, timeoutMs: 4000 });
  }
}
