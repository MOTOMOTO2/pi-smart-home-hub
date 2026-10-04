import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { parseConfig } from '../src/config.js';
import { Hub, withinWindow } from '../src/hub.js';
import { BadRequestError, NotFoundError } from '../src/errors.js';
import { SimTransport } from '../src/net/sim/index.js';
import { DEMO_HOSTS } from '../src/net/sim/index.js';
import { tempStore } from './helpers.js';

const baseConfig = {
  demo: true,
  devices: [
    { id: 'lights', name: 'Lights', type: 'nanoleaf', host: DEMO_HOSTS.nanoleaf, token: 'demo-nanoleaf-token' },
    { id: 'tv', name: 'TV', type: 'rokutv', host: DEMO_HOSTS.tv },
    { id: 'off', name: 'Disabled', type: 'rokutv', host: DEMO_HOSTS.tv, enabled: false },
  ],
  scenes: [
    {
      id: 'dim',
      name: 'Dim',
      actions: [
        { device: 'lights', command: 'power', params: { on: true } },
        { device: 'lights', command: 'brightness', params: { value: 20 } },
      ],
    },
  ],
};

const hubs: Hub[] = [];

async function makeHub(overrides: Record<string, unknown> = {}): Promise<{ hub: Hub; transport: SimTransport }> {
  const config = parseConfig({ ...baseConfig, ...overrides }, {});
  const transport = new SimTransport();
  const hub = new Hub(config, transport, tempStore());
  hubs.push(hub);
  await hub.start();
  await hub.refreshAll();
  return { hub, transport };
}

afterEach(async () => {
  while (hubs.length) await hubs.pop()?.stop();
});

describe('hub device registry', () => {
  it('builds an adapter per configured device', async () => {
    const { hub } = await makeHub();
    const ids = hub.listDevices().map((d) => d.descriptor.id);
    assert.deepEqual(ids, ['lights', 'tv', 'off']);
    assert.equal(hub.getDevice('lights').descriptor.type, 'nanoleaf');
  });

  it('marks a disabled device as such and refuses commands', async () => {
    const { hub } = await makeHub();
    const disabled = hub.getDevice('off');
    assert.equal(disabled.state.online, false);
    assert.equal(disabled.state.error, 'Disabled in config');
    await assert.rejects(hub.execute('off', 'toggle'), BadRequestError);
    await assert.rejects(hub.refreshDevice('off'), BadRequestError);
  });

  it('raises NotFound for an unknown id', async () => {
    const { hub } = await makeHub();
    assert.throws(() => hub.getDevice('ghost'), NotFoundError);
    await assert.rejects(hub.execute('ghost', 'toggle'), NotFoundError);
  });

  it('keeps the last known state when a poll fails, and flags the error', async () => {
    const { hub, transport } = await makeHub();
    assert.equal(hub.getDevice('lights').state['brightness'], 62);
    const original = transport.http.bind(transport);
    transport.http = async () => {
      throw new Error('EHOSTUNREACH');
    };
    await assert.rejects(hub.refreshDevice('lights'));
    const state = hub.getDevice('lights').state;
    assert.equal(state.online, false);
    assert.match(String(state.error), /EHOSTUNREACH/);
    assert.equal(state['brightness'], 62, 'stale value retained so the UI does not blank out');
    transport.http = original;
    await hub.refreshDevice('lights');
    assert.equal(hub.getDevice('lights').state.online, true, 'recovers');
  });

  it('reports state changes to listeners', async () => {
    const { hub } = await makeHub();
    const seen: string[] = [];
    hub.on('device.state', (payload: { id: string }) => seen.push(payload.id));
    await hub.refreshDevice('tv');
    assert.ok(seen.includes('tv'));
  });
});

describe('scenes', () => {
  it('runs actions in order', async () => {
    const { hub, transport } = await makeHub();
    const result = await hub.runScene('dim');
    assert.deepEqual(result.failed, []);
    assert.equal(result.ran, 2);
    assert.equal(transport.world.nanoleaf.brightness, 20);
    assert.equal(transport.world.nanoleaf.on, true);
  });

  it('honours delayMs between actions', async () => {
    const { hub } = await makeHub({
      scenes: [
        {
          id: 'slow',
          name: 'Slow',
          actions: [
            { device: 'lights', command: 'toggle' },
            { delayMs: 120 },
            { device: 'lights', command: 'toggle' },
          ],
        },
      ],
    });
    const started = Date.now();
    await hub.runScene('slow');
    assert.ok(Date.now() - started >= 110, 'waited between the two toggles');
  });

  it('keeps going when one action fails, and reports which', async () => {
    const { hub, transport } = await makeHub({
      scenes: [
        {
          id: 'mixed',
          name: 'Mixed',
          actions: [
            { device: 'lights', command: 'color', params: { hex: 'not-a-colour' } },
            { device: 'lights', command: 'brightness', params: { value: 33 } },
          ],
        },
      ],
    });
    const result = await hub.runScene('mixed');
    assert.equal(result.ran, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.device, 'lights');
    assert.equal(transport.world.nanoleaf.brightness, 33, 'the second action still ran');
  });

  it('stores runtime scenes alongside config ones but protects the config ones', async () => {
    const { hub } = await makeHub();
    hub.saveScene({ id: 'mine', name: 'Mine', icon: '*', favorite: false, actions: [{ device: 'tv', command: 'mute', params: {} }] });
    const scenes = hub.scenes();
    assert.equal(scenes.find((s) => s.id === 'mine')?.source, 'user');
    assert.equal(scenes.find((s) => s.id === 'dim')?.source, 'config');

    assert.throws(() => hub.deleteScene('dim'), BadRequestError);
    assert.throws(
      () => hub.saveScene({ id: 'dim', name: 'Hijack', icon: '*', favorite: false, actions: [{ device: 'tv', command: 'mute', params: {} }] }),
      BadRequestError,
    );
    hub.deleteScene('mine');
    assert.equal(hub.scenes().some((s) => s.id === 'mine'), false);
    assert.throws(() => hub.deleteScene('mine'), NotFoundError);
  });

  it('rejects a runtime scene that points at an unknown device', async () => {
    const { hub } = await makeHub();
    assert.throws(
      () => hub.saveScene({ id: 'bad', name: 'Bad', icon: '*', favorite: false, actions: [{ device: 'ghost', command: 'x', params: {} }] }),
      BadRequestError,
    );
  });
});

describe('automations', () => {
  const automationConfig = (extra: Record<string, unknown> = {}) => ({
    ...baseConfig,
    automations: [
      {
        id: 'on-ding',
        name: 'On ding',
        when: { event: 'ring.ding' },
        run: [{ device: 'lights', command: 'brightness', params: { value: 99 } }],
        ...extra,
      },
    ],
  });

  it('fires on a matching hub event', async () => {
    const { hub, transport } = await makeHub(automationConfig());
    hub.publishEvent('ring.ding', { deviceId: 'doorbell' });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(transport.world.nanoleaf.brightness, 99);
  });

  it('ignores events it does not subscribe to', async () => {
    const { hub, transport } = await makeHub(automationConfig());
    const before = transport.world.nanoleaf.brightness;
    hub.publishEvent('ring.motion', {});
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(transport.world.nanoleaf.brightness, before);
  });

  it('respects the cooldown window', async () => {
    const { hub, transport } = await makeHub(automationConfig({ cooldownSeconds: 60 }));
    hub.publishEvent('ring.ding', {});
    await new Promise((r) => setTimeout(r, 120));
    await hub.execute('lights', 'brightness', { value: 10 });
    hub.publishEvent('ring.ding', {});
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(transport.world.nanoleaf.brightness, 10, 'second ding was suppressed');
  });

  it('can be disabled at runtime without editing config', async () => {
    const { hub, transport } = await makeHub(automationConfig());
    hub.setAutomationEnabled('on-ding', false);
    assert.equal(hub.automations()[0]?.enabled, false);
    const before = transport.world.nanoleaf.brightness;
    hub.publishEvent('ring.ding', {});
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(transport.world.nanoleaf.brightness, before);
    assert.throws(() => hub.setAutomationEnabled('nope', true), NotFoundError);
  });

  it('filters by source device when asked', async () => {
    const { hub, transport } = await makeHub({
      ...baseConfig,
      automations: [
        {
          id: 'only-front',
          name: 'Only the front door',
          when: { event: 'ring.ding', device: 'front' },
          run: [{ device: 'lights', command: 'brightness', params: { value: 77 } }],
        },
      ],
    });
    const before = transport.world.nanoleaf.brightness;
    hub.publishEvent('ring.ding', { deviceId: 'back' });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(transport.world.nanoleaf.brightness, before);
    hub.publishEvent('ring.ding', { deviceId: 'front' });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(transport.world.nanoleaf.brightness, 77);
  });

  it('fires on a device state threshold being crossed', async () => {
    const { hub, transport } = await makeHub({
      ...baseConfig,
      automations: [
        {
          id: 'bright',
          name: 'Too bright',
          when: { deviceState: { device: 'lights', path: 'brightness', above: 90 } },
          run: [{ device: 'tv', command: 'mute', params: {} }],
        },
      ],
    });
    const muted = transport.world.roku.muted;
    await hub.execute('lights', 'brightness', { value: 50 });
    await hub.refreshDevice('lights');
    assert.equal(transport.world.roku.muted, muted, 'below the threshold, nothing happens');
    await hub.execute('lights', 'brightness', { value: 95 });
    await hub.refreshDevice('lights');
    await new Promise((r) => setTimeout(r, 150));
    assert.notEqual(transport.world.roku.muted, muted);
  });

  it('runs a named scene as its action', async () => {
    const { hub, transport } = await makeHub({
      ...baseConfig,
      automations: [{ id: 'sc', name: 'Scene trigger', when: { event: 'test.go' }, scene: 'dim' }],
    });
    hub.publishEvent('test.go', {});
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(transport.world.nanoleaf.brightness, 20);
  });

  it('does not let device.command events retrigger automations', async () => {
    const { hub, transport } = await makeHub({
      ...baseConfig,
      automations: [
        {
          id: 'loop',
          name: 'Would loop',
          when: { event: 'device.command' },
          run: [{ device: 'lights', command: 'brightness', params: { value: 5 } }],
        },
      ],
    });
    await hub.execute('lights', 'brightness', { value: 50 });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(transport.world.nanoleaf.brightness, 50, 'no feedback loop');
  });

  it('describes its trigger for the UI', async () => {
    const { hub } = await makeHub({
      ...baseConfig,
      automations: [
        { id: 'a', name: 'A', when: { event: 'ring.ding' }, scene: 'dim' },
        { id: 'b', name: 'B', when: { schedule: '0 7 * * *' }, scene: 'dim' },
        { id: 'c', name: 'C', when: { deviceState: { device: 'lights', path: 'on', equals: false } }, scene: 'dim' },
      ],
    });
    const triggers = hub.automations().map((a) => a.trigger);
    assert.deepEqual(triggers, ['ring.ding', 'schedule 0 7 * * *', 'lights.on = false']);
  });
});

describe('time windows', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 5, h, m);

  it('handles a normal daytime window', () => {
    assert.ok(withinWindow(at(10), '09:00', '17:00'));
    assert.ok(!withinWindow(at(8), '09:00', '17:00'));
    assert.ok(!withinWindow(at(17), '09:00', '17:00'), 'end is exclusive');
  });

  it('handles a window that wraps midnight', () => {
    assert.ok(withinWindow(at(23), '22:00', '06:00'));
    assert.ok(withinWindow(at(2), '22:00', '06:00'));
    assert.ok(!withinWindow(at(12), '22:00', '06:00'));
  });

  it('treats an empty window as always on', () => {
    assert.ok(withinWindow(at(13), '00:00', '00:00'));
  });
});

describe('event feed', () => {
  it('records events newest-first and bounds the buffer', async () => {
    const { hub } = await makeHub();
    hub.publishEvent('first', {});
    hub.publishEvent('second', {});
    const events = hub.events(10);
    assert.equal(events[0]?.name, 'second');
    assert.equal(events[1]?.name, 'first');
    for (let i = 0; i < 300; i += 1) hub.publishEvent(`spam-${i}`, {});
    assert.ok(hub.events(500).length <= 200, 'ring buffer is capped');
  });
});
