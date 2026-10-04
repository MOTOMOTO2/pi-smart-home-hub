import { EventEmitter } from 'node:events';
import type { AutomationConfig, HubConfig, SceneAction, SceneConfig } from './config.js';
import { createAdapter } from './devices/registry.js';
import { BadRequestError, NotFoundError } from './errors.js';
import {
  NeedsSetupError,
  type CommandResult,
  type DeviceAdapter,
  type DeviceDescriptor,
  type DeviceState,
} from './devices/types.js';
import { createLogger, type Logger } from './logger.js';
import type { Transport } from './net/transport.js';
import type { Store } from './store.js';
import { errorMessage, jitter, single, sleep } from './util/async.js';
import { cronMatches, parseCron, type CronFields } from './util/cron.js';

export interface HubEvent {
  name: string;
  at: number;
  payload: Record<string, unknown>;
}

export interface DeviceSnapshot {
  descriptor: DeviceDescriptor;
  state: DeviceState;
}

export interface SceneView extends SceneConfig {
  source: 'config' | 'user';
}

export interface AutomationView {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  lastRunAt: number | null;
}

interface DeviceSlot {
  adapter: DeviceAdapter;
  state: DeviceState;
  timer: NodeJS.Timeout | null;
  /** Consecutive failures, used to back off polling of a dead device. */
  failures: number;
  refresh: () => Promise<DeviceState>;
  disabled: boolean;
}

const MAX_BACKOFF_MULTIPLIER = 8;

/**
 * Owns the device set: builds adapters from config, polls them, caches the
 * last known state, dispatches commands, runs scenes, and evaluates
 * automations. Everything the HTTP layer exposes goes through here.
 */
export class Hub extends EventEmitter {
  private readonly devices = new Map<string, DeviceSlot>();
  private readonly log: Logger = createLogger('hub');
  private readonly automationState = new Map<string, { lastRunAt: number; cron?: CronFields }>();
  private readonly recentEvents: HubEvent[] = [];
  private cronTimer: NodeJS.Timeout | null = null;
  private running = false;
  readonly startedAt = Date.now();

  constructor(
    readonly config: HubConfig,
    private readonly transport: Transport,
    private readonly store: Store,
  ) {
    super();
    this.setMaxListeners(100);
  }

  // -- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    for (const cfg of this.config.devices) {
      const logger = createLogger(`device:${cfg.id}`);
      const adapter = createAdapter(cfg, {
        id: cfg.id,
        name: cfg.name,
        room: cfg.room,
        transport: this.transport,
        logger,
        store: this.store,
        emit: (name, payload) => this.publishEvent(name, { ...payload, deviceId: cfg.id }),
      });

      const slot: DeviceSlot = {
        adapter,
        state: { online: false, updatedAt: 0 },
        timer: null,
        failures: 0,
        disabled: !cfg.enabled,
        refresh: single(async () => await this.refreshSlot(cfg.id)),
      };
      this.devices.set(cfg.id, slot);

      if (!cfg.enabled) {
        slot.state = { online: false, updatedAt: Date.now(), error: 'Disabled in config' };
        this.log.info(`device ${cfg.id} is disabled in config`);
        continue;
      }

      try {
        await adapter.init();
      } catch (err) {
        logger.error('init failed', err);
      }
    }

    for (const automation of this.config.automations) {
      const trigger = automation.when;
      if ('schedule' in trigger) {
        try {
          this.automationState.set(automation.id, { lastRunAt: 0, cron: parseCron(trigger.schedule) });
        } catch (err) {
          this.log.error(`automation "${automation.id}" has an invalid schedule, skipping`, err);
        }
      } else {
        this.automationState.set(automation.id, { lastRunAt: 0 });
      }
    }
    this.startCron();

    // Stagger the first poll so a dozen devices do not all hit the network at once.
    let offset = 0;
    for (const [id, slot] of this.devices) {
      if (slot.disabled) continue;
      offset += 120;
      slot.timer = setTimeout(() => void this.pollLoop(id), offset);
      slot.timer.unref?.();
    }

    this.log.info(
      `started with ${this.devices.size} device(s), ${this.scenes().length} scene(s), ${this.config.automations.length} automation(s)`,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    for (const slot of this.devices.values()) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      await slot.adapter.dispose().catch(() => {});
    }
    await this.store.close();
    this.log.info('stopped');
  }

  // -- polling --------------------------------------------------------------

  private async pollLoop(id: string): Promise<void> {
    const slot = this.devices.get(id);
    if (!slot || !this.running) return;
    try {
      await slot.refresh();
    } catch {
      // refreshSlot already recorded the failure.
    }
    if (!this.running) return;
    const multiplier = Math.min(2 ** slot.failures, MAX_BACKOFF_MULTIPLIER);
    const delay = jitter(slot.adapter.pollIntervalMs * multiplier);
    slot.timer = setTimeout(() => void this.pollLoop(id), delay);
    slot.timer.unref?.();
  }

  private async refreshSlot(id: string): Promise<DeviceState> {
    const slot = this.devices.get(id);
    if (!slot) throw new NotFoundError(`unknown device "${id}"`);
    const previous = slot.state;
    try {
      const partial = await slot.adapter.refresh();
      slot.failures = 0;
      const next: DeviceState = { ...partial, online: true, updatedAt: Date.now() };
      // needsSetup devices are reachable but unusable; do not call them online.
      if (next['needsSetup'] === true) next.online = false;
      this.commitState(id, previous, next);
      return next;
    } catch (err) {
      slot.failures += 1;
      const message = errorMessage(err);
      if (err instanceof NeedsSetupError) {
        const next: DeviceState = { online: false, updatedAt: Date.now(), needsSetup: true, error: message };
        this.commitState(id, previous, next);
        return next;
      }
      // Keep the last known values so the UI does not blank out on one blip.
      const next: DeviceState = { ...previous, online: false, updatedAt: Date.now(), error: message };
      if (slot.failures === 1 || slot.failures % 10 === 0) {
        this.log.warn(`device ${id} unreachable (attempt ${slot.failures}): ${message}`);
      }
      this.commitState(id, previous, next);
      throw err;
    }
  }

  private commitState(id: string, previous: DeviceState, next: DeviceState): void {
    const slot = this.devices.get(id);
    if (!slot) return;
    slot.state = next;
    this.emit('device.state', { id, state: next });
    this.evaluateStateTriggers(id, previous, next);
  }

  // -- reads ----------------------------------------------------------------

  listDevices(): DeviceSnapshot[] {
    return [...this.devices.entries()].map(([, slot]) => ({
      descriptor: slot.adapter.describe(),
      state: slot.state,
    }));
  }

  getDevice(id: string): DeviceSnapshot {
    const slot = this.devices.get(id);
    if (!slot) throw new NotFoundError(`unknown device "${id}"`);
    return { descriptor: slot.adapter.describe(), state: slot.state };
  }

  adapter(id: string): DeviceAdapter {
    const slot = this.devices.get(id);
    if (!slot) throw new NotFoundError(`unknown device "${id}"`);
    return slot.adapter;
  }

  hasDevice(id: string): boolean {
    return this.devices.has(id);
  }

  events(limit = 50): HubEvent[] {
    return this.recentEvents.slice(-limit).reverse();
  }

  // -- commands -------------------------------------------------------------

  async refreshDevice(id: string): Promise<DeviceState> {
    const slot = this.devices.get(id);
    if (!slot) throw new NotFoundError(`unknown device "${id}"`);
    if (slot.disabled) throw new BadRequestError(`device "${id}" is disabled in config`);
    return await slot.refresh();
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(
      [...this.devices.entries()]
        .filter(([, slot]) => !slot.disabled)
        .map(async ([id]) => await this.refreshDevice(id)),
    );
  }

  async execute(id: string, command: string, params: Record<string, unknown> = {}): Promise<CommandResult> {
    const slot = this.devices.get(id);
    if (!slot) throw new NotFoundError(`unknown device "${id}"`);
    if (slot.disabled) throw new BadRequestError(`device "${id}" is disabled in config`);

    this.log.info(`${id}.${command}${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ''}`);
    const result = await slot.adapter.execute(command, params);
    this.publishEvent('device.command', { deviceId: id, command, params });

    // Devices need a moment to settle before they report the new state.
    setTimeout(() => {
      void slot.refresh().catch(() => {});
    }, 700).unref?.();

    return result;
  }

  async snapshot(id: string): Promise<{ contentType: string; body: Buffer }> {
    const slot = this.devices.get(id);
    if (!slot) throw new NotFoundError(`unknown device "${id}"`);
    if (!slot.adapter.snapshot) throw new BadRequestError(`device "${id}" has no camera`);
    return await slot.adapter.snapshot();
  }

  // -- scenes ---------------------------------------------------------------

  /** Config scenes are read-only; scenes created from the UI live in the store. */
  scenes(): SceneView[] {
    const userScenes = (this.store.get<SceneConfig[]>('hub', 'scenes') ?? []).map(
      (scene): SceneView => ({ ...scene, source: 'user' }),
    );
    const configScenes = this.config.scenes.map((scene): SceneView => ({ ...scene, source: 'config' }));
    const byId = new Map<string, SceneView>();
    for (const scene of [...configScenes, ...userScenes]) byId.set(scene.id, scene);
    return [...byId.values()];
  }

  getScene(id: string): SceneView {
    const scene = this.scenes().find((s) => s.id === id);
    if (!scene) throw new NotFoundError(`unknown scene "${id}"`);
    return scene;
  }

  saveScene(scene: SceneConfig): SceneView {
    if (this.config.scenes.some((s) => s.id === scene.id)) {
      throw new BadRequestError(`scene "${scene.id}" is defined in the config file; edit config/hub.yaml instead`);
    }
    for (const action of scene.actions) {
      if (action.device && !this.devices.has(action.device)) {
        throw new BadRequestError(`unknown device "${action.device}" in scene action`);
      }
    }
    const existing = this.store.get<SceneConfig[]>('hub', 'scenes') ?? [];
    const next = [...existing.filter((s) => s.id !== scene.id), scene];
    this.store.set('hub', 'scenes', next);
    return { ...scene, source: 'user' };
  }

  deleteScene(id: string): void {
    if (this.config.scenes.some((s) => s.id === id)) {
      throw new BadRequestError(`scene "${id}" is defined in the config file; remove it from config/hub.yaml`);
    }
    const existing = this.store.get<SceneConfig[]>('hub', 'scenes') ?? [];
    if (!existing.some((s) => s.id === id)) throw new NotFoundError(`unknown scene "${id}"`);
    this.store.set(
      'hub',
      'scenes',
      existing.filter((s) => s.id !== id),
    );
  }

  async runScene(id: string): Promise<{ ran: number; failed: Array<{ device: string; error: string }> }> {
    const scene = this.getScene(id);
    this.log.info(`running scene "${scene.name}"`);
    this.publishEvent('scene.run', { sceneId: id, name: scene.name });
    return await this.runActions(scene.actions, `scene:${id}`);
  }

  /**
   * Actions run in order so "turn the TV on, wait, switch input" works. One
   * failing action does not abort the rest -- a dimmer being offline should
   * not stop movie night.
   */
  async runActions(
    actions: SceneAction[],
    context: string,
  ): Promise<{ ran: number; failed: Array<{ device: string; error: string }> }> {
    let ran = 0;
    const failed: Array<{ device: string; error: string }> = [];
    for (const action of actions) {
      if (action.delayMs !== undefined && !action.command) {
        await sleep(action.delayMs);
        continue;
      }
      if (!action.device || !action.command) continue;
      try {
        await this.execute(action.device, action.command, action.params);
        ran += 1;
      } catch (err) {
        const message = errorMessage(err);
        this.log.warn(`${context}: ${action.device}.${action.command} failed: ${message}`);
        failed.push({ device: action.device, error: message });
      }
      if (action.delayMs !== undefined) await sleep(action.delayMs);
    }
    return { ran, failed };
  }

  // -- automations ----------------------------------------------------------

  automations(): AutomationView[] {
    return this.config.automations.map((automation) => ({
      id: automation.id,
      name: automation.name,
      enabled: this.isAutomationEnabled(automation),
      trigger: describeTrigger(automation),
      lastRunAt: this.automationState.get(automation.id)?.lastRunAt || null,
    }));
  }

  isAutomationEnabled(automation: AutomationConfig): boolean {
    const override = this.store.get<boolean>('hub', `automation:${automation.id}:enabled`);
    return override ?? automation.enabled;
  }

  setAutomationEnabled(id: string, enabled: boolean): void {
    const automation = this.config.automations.find((a) => a.id === id);
    if (!automation) throw new NotFoundError(`unknown automation "${id}"`);
    this.store.set('hub', `automation:${id}:enabled`, enabled);
  }

  /** Emit a hub event and let automations react to it. */
  publishEvent(name: string, payload: Record<string, unknown> = {}): void {
    const event: HubEvent = { name, at: Date.now(), payload };
    this.recentEvents.push(event);
    if (this.recentEvents.length > 200) this.recentEvents.shift();
    this.emit('event', event);
    // device.command is internal bookkeeping; letting it trigger automations
    // would make a scene able to retrigger itself.
    if (name !== 'device.command') void this.handleEventTriggers(event);
  }

  private async handleEventTriggers(event: HubEvent): Promise<void> {
    for (const automation of this.config.automations) {
      const trigger = automation.when;
      if (!('event' in trigger)) continue;
      if (trigger.event !== event.name) continue;
      if (trigger.device && trigger.device !== event.payload['deviceId']) continue;
      await this.fire(automation, `event ${event.name}`);
    }
  }

  private evaluateStateTriggers(id: string, previous: DeviceState, next: DeviceState): void {
    for (const automation of this.config.automations) {
      const trigger = automation.when;
      if (!('deviceState' in trigger)) continue;
      const spec = trigger.deviceState;
      if (spec.device !== id) continue;
      const before = previous[spec.path];
      const after = next[spec.path];
      if (before === after) continue; // edge-triggered only
      if (!matchesCondition(after, spec)) continue;
      void this.fire(automation, `${id}.${spec.path} -> ${JSON.stringify(after)}`);
    }
  }

  private startCron(): void {
    const hasSchedule = this.config.automations.some((a) => 'schedule' in a.when);
    if (!hasSchedule) return;
    let lastMinute = -1;
    this.cronTimer = setInterval(() => {
      const now = new Date();
      const minute = now.getHours() * 60 + now.getMinutes();
      if (minute === lastMinute) return;
      lastMinute = minute;
      for (const automation of this.config.automations) {
        const state = this.automationState.get(automation.id);
        if (!state?.cron) continue;
        if (!cronMatches(state.cron, now)) continue;
        void this.fire(automation, `schedule ${('schedule' in automation.when && automation.when.schedule) || ''}`);
      }
    }, 20_000);
    this.cronTimer.unref?.();
  }

  private async fire(automation: AutomationConfig, reason: string): Promise<void> {
    if (!this.isAutomationEnabled(automation)) return;
    const state = this.automationState.get(automation.id) ?? { lastRunAt: 0 };
    const now = Date.now();
    if (automation.cooldownSeconds > 0 && now - state.lastRunAt < automation.cooldownSeconds * 1000) {
      this.log.debug(`automation "${automation.id}" still in cooldown`);
      return;
    }
    if (automation.between && !withinWindow(new Date(now), automation.between.from, automation.between.to)) {
      this.log.debug(`automation "${automation.id}" outside its active window`);
      return;
    }

    state.lastRunAt = now;
    this.automationState.set(automation.id, state);
    this.log.info(`automation "${automation.name}" fired (${reason})`);

    try {
      if (automation.scene) {
        await this.runScene(automation.scene);
      } else if (automation.run) {
        await this.runActions(automation.run, `automation:${automation.id}`);
      }
    } catch (err) {
      this.log.error(`automation "${automation.id}" failed`, err);
    }
  }
}

function matchesCondition(
  value: unknown,
  spec: { equals?: unknown; above?: number; below?: number },
): boolean {
  if (spec.equals !== undefined) return value === spec.equals;
  if (spec.above !== undefined) return typeof value === 'number' && value > spec.above;
  if (spec.below !== undefined) return typeof value === 'number' && value < spec.below;
  // No condition given: any change fires.
  return true;
}

/** Handles windows that wrap midnight, e.g. 22:00 to 06:30. */
export function withinWindow(now: Date, from: string, to: string): boolean {
  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(':');
    return Number(h) * 60 + Number(m);
  };
  const current = now.getHours() * 60 + now.getMinutes();
  const start = toMinutes(from);
  const end = toMinutes(to);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function describeTrigger(automation: AutomationConfig): string {
  const trigger = automation.when;
  if ('event' in trigger) return trigger.device ? `${trigger.event} from ${trigger.device}` : trigger.event;
  if ('schedule' in trigger) return `schedule ${trigger.schedule}`;
  const spec = trigger.deviceState;
  if (spec.equals !== undefined) return `${spec.device}.${spec.path} = ${JSON.stringify(spec.equals)}`;
  if (spec.above !== undefined) return `${spec.device}.${spec.path} > ${spec.above}`;
  if (spec.below !== undefined) return `${spec.device}.${spec.path} < ${spec.below}`;
  return `${spec.device}.${spec.path} changes`;
}
