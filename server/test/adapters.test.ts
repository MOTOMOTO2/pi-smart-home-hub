import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EcobeeAdapter, runningState } from '../src/devices/ecobee.js';
import { NanoleafAdapter } from '../src/devices/nanoleaf.js';
import { PcAdapter } from '../src/devices/pc.js';
import { RingAdapter } from '../src/devices/ring.js';
import { RokuTvAdapter } from '../src/devices/rokutv.js';
import { XboxAdapter } from '../src/devices/xbox.js';
import { AndroidTvAdapter } from '../src/devices/androidtv.js';
import { BadRequestError, NeedsSetupError } from '../src/errors.js';
import { DEMO_HOSTS, DEMO_MACS } from '../src/net/sim/index.js';
import { testContext } from './helpers.js';

describe('nanoleaf adapter', () => {
  const make = () => {
    const t = testContext('lights');
    const adapter = new NanoleafAdapter(t.ctx, {
      id: 'lights',
      name: 'Lights',
      type: 'nanoleaf',
      host: DEMO_HOSTS.nanoleaf,
      port: 16021,
      token: 'demo-nanoleaf-token',
      enabled: true,
    });
    return { ...t, adapter };
  };

  it('reports the controller state and effect list', async () => {
    const { adapter } = make();
    await adapter.init();
    const state = await adapter.refresh();
    assert.equal(state['on'], true);
    assert.equal(state['brightness'], 62);
    assert.equal(state['effect'], 'Northern Lights');
    assert.equal((state['effects'] as string[]).length, 8);
    assert.equal(state['panels'], 9);
  });

  it('requires pairing before it will talk to the panels', async () => {
    const t = testContext('lights');
    const adapter = new NanoleafAdapter(t.ctx, {
      id: 'lights',
      name: 'Lights',
      type: 'nanoleaf',
      host: DEMO_HOSTS.nanoleaf,
      port: 16021,
      enabled: true,
    });
    await adapter.init();
    const state = await adapter.refresh();
    assert.equal(state['needsSetup'], true);
    assert.match(adapter.setupHint() ?? '', /hold the nanoleaf power button/i);
    await assert.rejects(adapter.execute('power', { on: true }), NeedsSetupError);
  });

  it('stores the token it earns while pairing', async () => {
    const t = testContext('lights');
    const adapter = new NanoleafAdapter(t.ctx, {
      id: 'lights',
      name: 'Lights',
      type: 'nanoleaf',
      host: DEMO_HOSTS.nanoleaf,
      port: 16021,
      enabled: true,
    });
    await adapter.init();
    const { token } = await adapter.pair();
    assert.equal(token, 'demo-nanoleaf-token');
    assert.equal(t.store.get('nanoleaf:lights', 'token'), 'demo-nanoleaf-token');
    assert.equal((await adapter.refresh())['on'], true, 'usable immediately after pairing');
  });

  it('writes hue and saturation separately, as the Open API requires', async () => {
    const { adapter, transport } = make();
    await adapter.init();
    await adapter.execute('color', { hex: '#00ff00' });
    const puts = transport.httpLog.filter((e) => e.method === 'PUT');
    assert.equal(puts.length, 3, 'hue, sat and brightness are three separate writes');
    assert.ok(puts.every((e) => e.url.endsWith('/state')));
    const state = await adapter.refresh();
    assert.equal(state['hue'], 120);
    assert.equal(state['saturation'], 100);
    assert.equal(state['colorMode'], 'hs');
  });

  it('leaves brightness alone when asked to', async () => {
    const { adapter } = make();
    await adapter.init();
    await adapter.execute('brightness', { value: 30 });
    await adapter.execute('color', { hex: '#ff0000', keepBrightness: true });
    assert.equal((await adapter.refresh())['brightness'], 30);
  });

  it('toggles based on the live state', async () => {
    const { adapter } = make();
    await adapter.init();
    const first = await adapter.execute('toggle', {});
    assert.equal(first.message, 'Lights off');
    assert.equal((await adapter.refresh())['on'], false);
    const second = await adapter.execute('toggle', {});
    assert.equal(second.message, 'Lights on');
  });

  it('rejects bad input as a client error', async () => {
    const { adapter } = make();
    await adapter.init();
    await assert.rejects(adapter.execute('color', { hex: 'blurple' }), BadRequestError);
    await assert.rejects(adapter.execute('brightness', {}), BadRequestError);
    await assert.rejects(adapter.execute('nonsense', {}), BadRequestError);
  });

  it('clamps brightness and colour temperature to the device range', async () => {
    const { adapter } = make();
    await adapter.init();
    await adapter.execute('brightness', { value: 500 });
    assert.equal((await adapter.refresh())['brightness'], 100);
    await adapter.execute('colorTemp', { kelvin: 99_999 });
    assert.equal((await adapter.refresh())['colorTempK'], 6500);
  });
});

describe('roku tv adapter', () => {
  const make = () => {
    const t = testContext('tv');
    const adapter = new RokuTvAdapter(t.ctx, {
      id: 'tv',
      name: 'TV',
      type: 'rokutv',
      host: DEMO_HOSTS.tv,
      port: 8060,
      mac: DEMO_MACS.tv,
      enabled: true,
    });
    return { ...t, adapter };
  };

  it('reads device info, volume and the active input', async () => {
    const { adapter } = make();
    const state = await adapter.refresh();
    assert.equal(state['on'], true);
    assert.equal(state['vendor'], 'TCL');
    assert.equal(state['model'], '55S425');
    assert.equal(state['volume'], 14);
    assert.equal(state['activeApp'], 'HDMI2', 'friendly label, not the tvinput id');
    assert.equal(state['activeAppId'], 'tvinput.hdmi2');
  });

  it('caches the channel list so the UI can offer it as a dropdown', async () => {
    const { adapter, store } = make();
    await adapter.refresh();
    const apps = store.get<Array<{ id: string; name: string }>>('rokutv:tv', 'apps');
    assert.ok(apps && apps.length > 0);
    assert.ok(apps.some((a) => a.name === 'Netflix'));
    const launch = adapter.commands().find((c) => c.name === 'launch');
    assert.ok(launch?.params?.[0]?.options?.some((o) => o.label === 'Netflix'));
  });

  it('reports standby without treating it as an error', async () => {
    const { adapter } = make();
    await adapter.execute('power', { on: false });
    const state = await adapter.refresh();
    assert.equal(state['on'], false);
    assert.equal(state['powerMode'], 'DisplayOff');
    assert.equal(state['error'], undefined);
  });

  it('sends one keypress per volume step', async () => {
    const { adapter, transport } = make();
    await adapter.execute('volume', { delta: 3 });
    const presses = transport.httpLog.filter((e) => e.url.includes('/keypress/VolumeUp'));
    assert.equal(presses.length, 3);
    assert.equal((await adapter.refresh())['volume'], 17);
  });

  it('maps friendly input names onto ECP keys', async () => {
    const { adapter, transport } = make();
    await adapter.execute('input', { input: 'hdmi3' });
    assert.ok(transport.httpLog.some((e) => e.url.endsWith('/keypress/InputHDMI3')));
    assert.equal((await adapter.refresh())['activeApp'], 'HDMI3');
    await assert.rejects(adapter.execute('input', { input: 'scart' }), BadRequestError);
  });

  it('types text one character at a time with Lit_ keys', async () => {
    const { adapter, transport } = make();
    await adapter.execute('text', { text: 'hi' });
    const lit = transport.httpLog.filter((e) => e.url.includes('/keypress/Lit_'));
    assert.equal(lit.length, 2);
  });

  it('reports now-playing when something is streaming', async () => {
    const { adapter } = make();
    await adapter.execute('launch', { appId: '12' });
    const state = await adapter.refresh();
    assert.equal(state['activeApp'], 'Netflix');
    assert.equal(state['playState'], 'play');
    assert.deepEqual(state['nowPlaying'], { title: 'The Demo Episode', positionMs: 842000, durationMs: 2640000 });
  });
});

describe('xbox adapter', () => {
  const make = (liveId?: string) => {
    const t = testContext('xbox');
    const adapter = new XboxAdapter(t.ctx, {
      id: 'xbox',
      name: 'Xbox',
      type: 'xbox',
      host: DEMO_HOSTS.xbox,
      enabled: true,
      ...(liveId ? { liveId } : {}),
    });
    return { ...t, adapter };
  };

  it('reports a standby console as off rather than failing', async () => {
    const { adapter } = make('FD00A1B2C3D4E5F6');
    await adapter.init();
    const state = await adapter.refresh();
    assert.equal(state['on'], false);
    assert.equal(state['canWake'], true);
  });

  it('learns and persists the live ID from a discovery response', async () => {
    const { adapter, world, store } = make();
    await adapter.init();
    assert.match(adapter.setupHint() ?? '', /live ID/);
    world.xbox.on = true;
    const state = await adapter.refresh();
    assert.equal(state['on'], true);
    assert.equal(state['consoleName'], 'LIVING ROOM XBOX');
    assert.equal(state['liveId'], 'FD00A1B2C3D4E5F6');
    assert.equal(store.get('xbox:xbox', 'liveId'), 'FD00A1B2C3D4E5F6');
    assert.equal(adapter.setupHint(), undefined, 'no longer needs setup');
  });

  it('refuses to wake without a live ID, and says how to get one', async () => {
    const { adapter } = make();
    await adapter.init();
    await assert.rejects(adapter.execute('wake', {}), NeedsSetupError);
  });

  it('sends a burst of power-on packets to unicast and broadcast', async () => {
    const { adapter, transport } = make('FD00A1B2C3D4E5F6');
    await adapter.init();
    await adapter.execute('wake', {});
    const sent = transport.udpLog.filter((e) => e.target.port === 5050);
    const hosts = new Set(sent.map((e) => e.target.host));
    assert.ok(hosts.has(DEMO_HOSTS.xbox));
    assert.ok(hosts.has('255.255.255.255'), 'also broadcast, since routers vary');
  });

  it('explains that powering off needs an authenticated session', async () => {
    const { adapter } = make('FD00A1B2C3D4E5F6');
    await adapter.init();
    await assert.rejects(adapter.execute('power', { on: false }), (err: Error) => {
      assert.ok(err instanceof BadRequestError);
      assert.match(err.message, /authenticated SmartGlass session/);
      return true;
    });
  });
});

describe('pc adapter', () => {
  const make = (overrides: Record<string, unknown> = {}) => {
    const t = testContext('pc');
    const adapter = new PcAdapter(t.ctx, {
      id: 'pc',
      name: 'PC',
      type: 'pc',
      host: DEMO_HOSTS.pc,
      mac: DEMO_MACS.pc,
      probePort: 3389,
      agentUrl: `http://${DEMO_HOSTS.pc}:3445`,
      agentToken: 'demo-token',
      enabled: true,
      ...overrides,
    } as never);
    return { ...t, adapter };
  };

  it('treats an unreachable agent as a sleeping PC, not an error', async () => {
    const { adapter } = make();
    const state = await adapter.refresh();
    assert.equal(state['on'], false);
    assert.equal(state['error'], undefined);
  });

  it('wakes with a magic packet and then reads the agent', async () => {
    const { adapter, world, transport } = make();
    await adapter.execute('wake', {});
    assert.equal(world.pc.on, true);
    // Sprayed across the three ports WoL implementations listen on, and to
    // both the global and the directed broadcast, since routers differ.
    const ports = new Set(transport.udpLog.map((e) => e.target.port));
    assert.deepEqual([...ports].sort((a, b) => a - b), [7, 9, 40000]);
    const hosts = new Set(transport.udpLog.map((e) => e.target.host));
    assert.deepEqual([...hosts].sort(), ['10.0.0.255', '255.255.255.255']);
    const state = await adapter.refresh();
    assert.equal(state['on'], true);
    assert.equal(state['hostname'], 'battlestation');
    assert.equal(state['platform'], 'win32');
  });

  it('only advertises agent commands when an agent is configured', () => {
    const withAgent = make().adapter.commands().map((c) => c.name);
    const without = make({ agentUrl: undefined }).adapter.commands().map((c) => c.name);
    assert.ok(withAgent.includes('sleep') && withAgent.includes('lock'));
    assert.ok(!without.includes('sleep'));
    assert.ok(without.includes('wake'), 'wake needs no agent');
  });

  it('falls back to a TCP probe when there is no agent', async () => {
    const { adapter, world } = make({ agentUrl: undefined });
    world.pc.on = true;
    const state = await adapter.refresh();
    assert.equal(state['on'], true);
    assert.equal(state['probePort'], 3389);
    assert.equal(state['hasAgent'], false);
  });

  it('explains that sleep needs the agent', async () => {
    const { adapter } = make({ agentUrl: undefined });
    await assert.rejects(adapter.execute('sleep', {}), (err: Error) => {
      assert.ok(err instanceof BadRequestError);
      assert.match(err.message, /companion agent/);
      return true;
    });
  });

  it('cannot wake without a MAC address', async () => {
    const { adapter } = make({ mac: undefined });
    await assert.rejects(adapter.execute('wake', {}), BadRequestError);
  });
});

describe('ecobee adapter', () => {
  const make = (overrides: Record<string, unknown> = {}) => {
    const t = testContext('thermo');
    const adapter = new EcobeeAdapter(t.ctx, {
      id: 'thermo',
      name: 'Thermostat',
      type: 'ecobee',
      apiKey: 'demo-api-key',
      refreshToken: 'demo-ecobee-refresh',
      scale: 'F',
      enabled: true,
      ...overrides,
    } as never);
    return { ...t, adapter };
  };

  it('converts tenths of Fahrenheit into display units', async () => {
    const { adapter } = make();
    await adapter.init();
    const state = await adapter.refresh();
    assert.equal(state['temperature'], 69.4);
    assert.equal(state['heatSetpoint'], 70);
    assert.equal(state['coolSetpoint'], 75.5);
    assert.equal(state['humidity'], 38);
  });

  it('converts to Celsius when configured that way', async () => {
    const { adapter } = make({ scale: 'C' });
    await adapter.init();
    const state = await adapter.refresh();
    assert.equal(state['temperature'], 20.8, '69.4F is 20.8C');
    await adapter.execute('setpoint', { heat: 20, cool: 25 });
    const after = await adapter.refresh();
    assert.equal(after['heatSetpoint'], 20, 'round-trips through the Fahrenheit API');
    assert.equal(after['coolSetpoint'], 25);
  });

  it('exchanges a refresh token for an access token on first use', async () => {
    const { adapter, transport, store } = make();
    await adapter.init();
    await adapter.refresh();
    assert.ok(transport.httpLog.some((e) => e.url.includes('grant_type=refresh_token')));
    assert.ok(store.get('ecobee:thermo', 'tokens'), 'tokens are persisted');
  });

  it('walks the PIN flow, including the not-yet-entered case', async () => {
    const { adapter } = make({ refreshToken: undefined });
    await adapter.init();
    assert.match(adapter.setupHint() ?? '', /PIN/);
    const { pin } = await adapter.pairStart();
    assert.equal(pin, 'AB12');
    await assert.rejects(adapter.pairComplete(), /has not seen the PIN/);
    await adapter.pairComplete();
    assert.equal(adapter.setupHint(), undefined);
    assert.equal((await adapter.refresh())['paired'], true);
  });

  it('needs an API key before anything else', async () => {
    const { adapter } = make({ apiKey: undefined, refreshToken: undefined });
    await adapter.init();
    assert.match(adapter.setupHint() ?? '', /developer app/);
    assert.equal((await adapter.refresh())['needsSetup'], true);
    await assert.rejects(adapter.pairStart(), NeedsSetupError);
  });

  it('fills in the other half of the band when only one is given', async () => {
    const { adapter } = make();
    await adapter.init();
    await adapter.execute('setpoint', { heat: 72 });
    const state = await adapter.refresh();
    assert.equal(state['heatSetpoint'], 72);
    assert.equal(state['coolSetpoint'], 75.5, 'cool side left where it was');
    assert.equal(state['holdActive'], true);
  });

  it('slides the whole band in auto mode but only one side otherwise', async () => {
    const { adapter, world } = make();
    await adapter.init();
    await adapter.execute('nudge', { delta: 2 });
    let state = await adapter.refresh();
    assert.equal(state['heatSetpoint'], 72, 'heat mode moves the heat setpoint');
    assert.equal(state['coolSetpoint'], 75.5, 'and leaves cooling alone');

    world.ecobee.hvacMode = 'auto';
    await adapter.execute('nudge', { delta: -2 });
    state = await adapter.refresh();
    assert.equal(state['heatSetpoint'], 70);
    assert.equal(state['coolSetpoint'], 73.5);
  });

  it('resumes the schedule and switches modes', async () => {
    const { adapter } = make();
    await adapter.init();
    await adapter.execute('setpoint', { heat: 72, cool: 78 });
    await adapter.execute('resume', {});
    assert.equal((await adapter.refresh())['holdActive'], false);
    await adapter.execute('hvacMode', { mode: 'cool' });
    assert.equal((await adapter.refresh())['hvacMode'], 'cool');
    await assert.rejects(adapter.execute('hvacMode', { mode: 'turbo' }), BadRequestError);
    await assert.rejects(adapter.execute('fan', { mode: 'maybe' }), BadRequestError);
  });

  it('reads remote sensors', async () => {
    const { adapter } = make();
    await adapter.init();
    const sensors = (await adapter.refresh())['sensors'] as Array<Record<string, unknown>>;
    assert.equal(sensors.length, 2);
    assert.equal(sensors[0]?.['name'], 'Living Room');
    assert.equal(sensors[0]?.['occupied'], true);
    assert.equal(sensors[1]?.['occupied'], false);
  });

  it('maps equipmentStatus relay names to a running state', () => {
    assert.equal(runningState(['heatPump']), 'heating');
    assert.equal(runningState(['auxHeat1', 'fan']), 'heating');
    assert.equal(runningState(['compCool1']), 'cooling');
    assert.equal(runningState(['fan']), 'fan');
    assert.equal(runningState([]), 'idle');
    assert.equal(runningState(['compHotWater']), 'idle', 'the water heater is not space heating');
  });
});

describe('ring adapter', () => {
  const make = (overrides: Record<string, unknown> = {}) => {
    const t = testContext('doorbell');
    const adapter = new RingAdapter(t.ctx, {
      id: 'doorbell',
      name: 'Front Door',
      type: 'ring',
      refreshToken: 'demo-ring-refresh-token',
      pollSeconds: 45,
      enabled: true,
      ...overrides,
    } as never);
    return { ...t, adapter };
  };

  it('reads health and event history', async () => {
    const { adapter } = make();
    await adapter.init();
    const state = await adapter.refresh();
    assert.equal(state['battery'], 78);
    assert.equal(state['signalCategory'], 'good');
    assert.equal(state['wifiName'], 'HomeNet-5G');
    assert.equal(state['deviceName'], 'Front Door');
    assert.equal((state['events'] as unknown[]).length, 4);
  });

  it('generates a stable hardware id and keeps it', async () => {
    const { adapter, store } = make();
    await adapter.init();
    const first = store.get<string>('ring:doorbell', 'hardwareId');
    assert.ok(first);
    await adapter.init();
    assert.equal(store.get('ring:doorbell', 'hardwareId'), first, 'reused, so 2FA is not re-triggered');
  });

  it('does not replay history on the first poll after a restart', async () => {
    const { adapter, events } = make();
    await adapter.init();
    await adapter.refresh();
    assert.equal(events.length, 0, 'first poll only records the cursor');
  });

  it('emits an event when a new one appears', async () => {
    const { adapter, world, events } = make();
    await adapter.init();
    await adapter.refresh();
    world.pushRingEvent('motion');
    await adapter.refresh();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'ring.motion');
    assert.equal(events[0]?.payload['kind'], 'motion');
  });

  it('emits every missed event in chronological order', async () => {
    const { adapter, world, events } = make();
    await adapter.init();
    await adapter.refresh();
    world.pushRingEvent('motion');
    world.pushRingEvent('motion');
    world.pushRingEvent('ding');
    await adapter.refresh();
    const names = events.map((e) => e.event);
    assert.equal(names.filter((n) => n === 'ring.motion').length, 2);
    assert.ok(names.includes('ring.ding'));
    assert.equal(names[0], 'ring.motion', 'oldest first');
  });

  it('reflects an active ding as ringing', async () => {
    const { adapter, world } = make();
    await adapter.init();
    world.pushRingEvent('ding');
    const state = await adapter.refresh();
    assert.equal(state['ringing'], true);
    assert.equal(state['activeDings'], 1);
  });

  it('runs the 2FA sign-in flow and stores only the refresh token', async () => {
    const { adapter, store } = make({ refreshToken: undefined });
    await adapter.init();
    assert.match(adapter.setupHint() ?? '', /refresh token is stored/);
    const start = await adapter.pairStart('demo@example.com', 'hunter2');
    assert.equal(start.needsCode, true);
    assert.match(start.hint ?? '', /SMS/);
    await assert.rejects(adapter.pairVerify('000000'), /demo expects 123456/);
    await adapter.pairVerify('123456');
    const tokens = store.get<Record<string, unknown>>('ring:doorbell', 'tokens');
    assert.equal(tokens?.['refreshToken'], 'demo-ring-refresh-token');
    assert.ok(!JSON.stringify(store.all('ring:doorbell')).includes('hunter2'), 'password is never persisted');
  });

  it('serves a camera snapshot', async () => {
    const { adapter } = make();
    await adapter.init();
    const snap = await adapter.snapshot!();
    assert.match(snap.contentType, /^image\//);
    assert.ok(snap.body.length > 0);
  });

  it('controls the floodlight and siren', async () => {
    const { adapter, world } = make();
    await adapter.init();
    await adapter.execute('light', { on: true });
    assert.equal(world.ring.lightOn, true);
    await adapter.execute('siren', { on: true });
    assert.equal(world.ring.sirenOn, true);
    await adapter.execute('siren', { on: false });
    assert.equal(world.ring.sirenOn, false);
  });

  it('needs pairing before it will talk to Ring', async () => {
    const { adapter } = make({ refreshToken: undefined });
    await adapter.init();
    assert.equal((await adapter.refresh())['needsSetup'], true);
    await assert.rejects(adapter.execute('snapshot', {}), NeedsSetupError);
  });
});

describe('android tv adapter', () => {
  const make = () => {
    const t = testContext('gtv');
    const adapter = new AndroidTvAdapter(t.ctx, {
      id: 'gtv',
      name: 'Google TV',
      type: 'androidtv',
      host: DEMO_HOSTS.tv,
      adbPort: 5555,
      adbPath: 'adb',
      enabled: true,
    });
    return { ...t, adapter };
  };

  it('reads wakefulness and volume over adb', async () => {
    const { adapter } = make();
    const state = await adapter.refresh();
    assert.equal(state['on'], true);
    assert.equal(state['adbTarget'], `${DEMO_HOSTS.tv}:5555`);
    assert.equal(state['volume'], 14);
  });

  it('maps remote keys to Android keycodes', async () => {
    const { adapter, world } = make();
    await adapter.execute('power', { on: false });
    assert.equal(world.roku.on, false);
    await adapter.execute('power', { on: true });
    assert.equal(world.roku.on, true);
    await assert.rejects(adapter.execute('key', { key: 'Teleport' }), BadRequestError);
  });
});
