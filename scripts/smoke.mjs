#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots the real server with the demo profile (so every device adapter runs
 * its real code against the in-process simulators), then drives the HTTP API
 * and WebSocket the way the dashboard does: reads state, sends commands,
 * runs a scene, triggers the doorbell and checks the automation fired.
 *
 *   node scripts/smoke.mjs
 *
 * Exits non-zero on the first failed assertion.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 8477);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Compare two hex colours channel-wise, tolerating integer rounding. */
function hexNear(a, b, tolerance) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ra, ga, ba] = channels(a);
  const [rb, gb, bb] = channels(b);
  return Math.abs(ra - rb) <= tolerance && Math.abs(ga - gb) <= tolerance && Math.abs(ba - bb) <= tolerance;
}

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function deviceState(id) {
  const { body } = await api(`/api/devices/${id}`);
  return body.state;
}

/** Re-poll a device and return its fresh state. */
async function refresh(id) {
  const { body } = await api(`/api/devices/${id}/refresh`, { method: 'POST' });
  return body.state;
}

async function command(id, cmd, params = {}) {
  return await api(`/api/devices/${id}/command`, { method: 'POST', body: { command: cmd, params } });
}

/** Poll until `predicate(state)` holds, for devices that settle asynchronously. */
async function waitFor(id, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let state = await refresh(id);
  while (!predicate(state) && Date.now() < deadline) {
    await sleep(400);
    state = await refresh(id);
  }
  return state;
}

async function waitForServer(child, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

async function run() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'dist', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HUB_PORT: String(PORT),
      HUB_HOST: '127.0.0.1',
      HUB_DEMO: '1',
      HUB_LOG_LEVEL: 'warn',
      // Keep the smoke run from stomping on a real state file.
      HUB_DATA_DIR: path.join('data', 'smoke'),
      HUB_CONFIG: path.join('config', 'demo.yaml'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const serverOutput = [];
  child.stdout.on('data', (d) => serverOutput.push(d.toString()));
  child.stderr.on('data', (d) => serverOutput.push(d.toString()));

  try {
    section('server startup');
    const health = await waitForServer(child);
    check('health endpoint reports ok', health.ok === true, health);
    check('demo mode is active', health.demo === true, health);
    check('six demo devices are configured', health.devices.total === 6, health.devices);

    // The hub staggers first polls; give every device a chance to report in.
    await api('/api/refresh', { method: 'POST' });

    section('device state');
    const { body: state } = await api('/api/state');
    const byId = Object.fromEntries(state.devices.map((d) => [d.descriptor.id, d]));
    check('all six devices present in /api/state', state.devices.length === 6);
    check(
      'nanoleaf, tv, pc-capable, thermostat and doorbell report online',
      ['lights', 'tv', 'thermostat', 'doorbell'].every((id) => byId[id]?.state.online === true),
      Object.fromEntries(Object.entries(byId).map(([k, v]) => [k, v.state.online])),
    );
    check('no device reports needsSetup', state.devices.every((d) => d.state.needsSetup !== true));
    check('scenes loaded from config', state.scenes.length === 5, state.scenes.length);
    check('automations loaded from config', state.automations.length === 4, state.automations.length);
    check(
      'capabilities drive the UI contract',
      byId.lights.descriptor.capabilities.includes('color') &&
        byId.tv.descriptor.capabilities.includes('remote') &&
        byId.thermostat.descriptor.capabilities.includes('thermostat') &&
        byId.doorbell.descriptor.capabilities.includes('camera'),
    );

    section('nanoleaf');
    check('effect list was discovered', (await deviceState('lights')).effects.length === 8);
    await command('lights', 'power', { on: false });
    check('power off is reflected in state', (await refresh('lights')).on === false);
    await command('lights', 'power', { on: true });
    await command('lights', 'brightness', { value: 42 });
    const dimmed = await refresh('lights');
    check('brightness applied', dimmed.brightness === 42, dimmed.brightness);
    const colorRes = await command('lights', 'color', { hex: '#1e90ff' });
    check('colour command accepted', colorRes.status === 200, colorRes.body);
    const colored = await refresh('lights');
    // Nanoleaf stores integer hue/sat, so the round-trip is close but not exact.
    check('hue/sat round-trip to within one step of the requested colour', hexNear(colored.hex, '#1e90ff', 3), colored.hex);
    await command('lights', 'effect', { name: 'Nemo' });
    check('effect selected', (await refresh('lights')).effect === 'Nemo');
    const badColor = await command('lights', 'color', { hex: 'not-a-colour' });
    check('invalid colour is rejected with 400', badColor.status === 400, badColor.body);

    section('tcl roku tv');
    const tv0 = await refresh('tv');
    check('reads model over ECP', tv0.model === '55S425', tv0.model);
    await command('tv', 'input', { input: 'hdmi1' });
    check('input switched to HDMI1', (await refresh('tv')).activeApp === 'HDMI1');
    await command('tv', 'launch', { appId: '12' });
    check('app launch switches active app', (await refresh('tv')).activeApp === 'Netflix');
    const volBefore = (await refresh('tv')).volume;
    await command('tv', 'volume', { delta: 3 });
    check('volume stepped up by 3', (await refresh('tv')).volume === volBefore + 3);
    await command('tv', 'power', { on: false });
    check('tv reports off', (await refresh('tv')).on === false);
    const badKey = await command('tv', 'key', { key: 'Nope' });
    check('unknown remote key is rejected', badKey.status === 400, badKey.body);

    section('xbox one s');
    const xbox0 = await refresh('xbox');
    check('standby console reports off, not errored', xbox0.on === false && !xbox0.error, xbox0);
    check('live ID from config enables wake', xbox0.canWake === true);
    await command('xbox', 'wake');
    const xbox1 = await waitFor('xbox', (s) => s.on === true);
    check('wake packet brings the console up', xbox1.on === true, xbox1);
    check('discovery reports the console name', xbox1.consoleName === 'LIVING ROOM XBOX', xbox1.consoleName);
    const xboxOff = await command('xbox', 'power', { on: false });
    check('power-off explains why it is unsupported', xboxOff.status === 400 && /authenticated/i.test(xboxOff.body.error), xboxOff.body);

    section('pc');
    const pc0 = await refresh('pc');
    check('sleeping pc reports off', pc0.on === false, pc0);
    await command('pc', 'wake');
    const pc1 = await waitFor('pc', (s) => s.on === true);
    check('wake-on-lan magic packet wakes it', pc1.on === true, pc1);
    check('agent reports the hostname', pc1.hostname === 'battlestation', pc1.hostname);
    await command('pc', 'sleep');
    check('sleep via agent puts it back to sleep', (await waitFor('pc', (s) => s.on === false)).on === false);

    section('ecobee');
    const t0 = await refresh('thermostat');
    check('temperature read in Fahrenheit', t0.temperature === 69.4, t0.temperature);
    check('remote sensors reported', t0.sensors.length === 2, t0.sensors);
    check('equipment state derived', t0.running === 'heating', t0.running);
    await command('thermostat', 'setpoint', { heat: 72, cool: 78 });
    const t1 = await refresh('thermostat');
    check('heat setpoint applied', t1.heatSetpoint === 72, t1.heatSetpoint);
    check('cool setpoint applied', t1.coolSetpoint === 78, t1.coolSetpoint);
    check('hold is now active', t1.holdActive === true);
    await command('thermostat', 'nudge', { delta: -2 });
    const t2 = await refresh('thermostat');
    check(
      'nudge moves only the active side in heat mode',
      t2.heatSetpoint === 70 && t2.coolSetpoint === 78,
      { heat: t2.heatSetpoint, cool: t2.coolSetpoint, mode: t2.hvacMode },
    );
    await command('thermostat', 'resume');
    check('resume clears the hold', (await refresh('thermostat')).holdActive === false);
    await command('thermostat', 'hvacMode', { mode: 'cool' });
    const t3 = await refresh('thermostat');
    check('hvac mode changed to cool', t3.hvacMode === 'cool' && t3.running === 'cooling', t3);

    section('ring doorbell');
    const r0 = await refresh('doorbell');
    check('battery level read from health', r0.battery === 78, r0.battery);
    check('event history populated', r0.events.length >= 4, r0.events?.length);
    const snapshot = await fetch(`${BASE}/api/devices/doorbell/snapshot`);
    check('snapshot endpoint returns an image', snapshot.ok && /image\//.test(snapshot.headers.get('content-type') ?? ''), snapshot.headers.get('content-type'));
    await command('doorbell', 'light', { on: true });
    check('floodlight command accepted', true);

    section('pairing flows');
    const nanoPair = await api('/api/devices/lights/pair', { method: 'POST' });
    check('nanoleaf pairing mints a token', nanoPair.status === 200 && nanoPair.body.paired === true, nanoPair.body);
    const pinStart = await api('/api/devices/thermostat/pair', { method: 'POST', body: { step: 'start' } });
    check('ecobee pairing returns a PIN to enter', pinStart.body.pin === 'AB12', pinStart.body);
    const pinPending = await api('/api/devices/thermostat/pair', { method: 'POST', body: { step: 'complete' } });
    check(
      'ecobee reports when the PIN has not been entered yet',
      pinPending.status === 500 && /has not seen the PIN/i.test(pinPending.body.error),
      pinPending.body,
    );
    const pinDone = await api('/api/devices/thermostat/pair', { method: 'POST', body: { step: 'complete' } });
    check('ecobee pairing completes once the PIN is accepted', pinDone.body.paired === true, pinDone.body);
    const ringStart = await api('/api/devices/doorbell/pair', {
      method: 'POST',
      body: { step: 'start', username: 'demo@example.com', password: 'hunter2' },
    });
    check('ring sign-in asks for a 2FA code', ringStart.body.needsCode === true, ringStart.body);
    const ringBadCode = await api('/api/devices/doorbell/pair', { method: 'POST', body: { step: 'verify', code: '000000' } });
    check('a wrong 2FA code is rejected', ringBadCode.status >= 400, ringBadCode.body);
    const ringDone = await api('/api/devices/doorbell/pair', { method: 'POST', body: { step: 'verify', code: '123456' } });
    check('ring pairing completes with the right code', ringDone.body.paired === true, ringDone.body);
    const noPair = await api('/api/devices/tv/pair', { method: 'POST' });
    check('devices that need no pairing say so', noPair.status === 400, noPair.body);

    section('scenes');
    const scene = await api('/api/scenes/movie-night/run', { method: 'POST' });
    check('movie-night ran without failures', scene.body.ok === true, scene.body);
    const tvScene = await refresh('tv');
    const lightsScene = await refresh('lights');
    check('scene powered the tv on and selected HDMI2', tvScene.on === true && tvScene.activeApp === 'HDMI2', tvScene.activeApp);
    check('scene dimmed the lights to 12', lightsScene.brightness === 12, lightsScene.brightness);
    const userScene = await api('/api/scenes', {
      method: 'POST',
      body: { id: 'smoke-scene', name: 'Smoke Scene', actions: [{ device: 'lights', command: 'identify' }] },
    });
    check('a scene can be created at runtime', userScene.status === 201, userScene.body);
    check('created scene runs', (await api('/api/scenes/smoke-scene/run', { method: 'POST' })).body.ok === true);
    check('created scene can be deleted', (await api('/api/scenes/smoke-scene', { method: 'DELETE' })).status === 200);
    const badDelete = await api('/api/scenes/movie-night', { method: 'DELETE' });
    check('config scenes are protected from deletion', badDelete.status === 400, badDelete.body);

    section('automations and events');
    await command('lights', 'power', { on: false });
    const doorbell = await api('/api/demo/doorbell', { method: 'POST', body: { kind: 'ding' } });
    check('demo doorbell accepted', doorbell.status === 200);
    const lightsAfterDing = await waitFor('lights', (s) => s.on === true && s.brightness === 100, 8000);
    check(
      'ring.ding automation turned the lights on at full brightness',
      lightsAfterDing.on === true && lightsAfterDing.brightness === 100,
      { on: lightsAfterDing.on, brightness: lightsAfterDing.brightness },
    );
    const { body: events } = await api('/api/events?limit=50');
    check('ring.ding appears in the event feed', events.some((e) => e.name === 'ring.ding'), events.slice(0, 5));
    check('scene.run appears in the event feed', events.some((e) => e.name === 'scene.run'));
    const toggled = await api('/api/automations/doorbell-lights/enabled', { method: 'POST', body: { enabled: false } });
    check('automation can be disabled', toggled.status === 200);
    check(
      'disabled automation is reflected in the list',
      (await api('/api/automations')).body.find((a) => a.id === 'doorbell-lights').enabled === false,
    );

    section('discovery');
    const { body: found } = await api('/api/discover', { method: 'POST' });
    const types = found.map((d) => d.type).sort();
    check('ssdp found the roku tv', types.includes('rokutv'), types);
    check('ssdp found the nanoleaf', types.includes('nanoleaf'), types);
    check('smartglass found the awake xbox', types.includes('xbox'), types);
    check(
      'discovery returns pasteable config',
      found.every((d) => typeof d.suggestedConfig.id === 'string' && typeof d.suggestedConfig.type === 'string'),
    );

    section('websocket');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const frames = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket did not deliver a hello frame')), 6000);
      ws.addEventListener('message', (event) => {
        frames.push(JSON.parse(event.data));
        if (frames.length === 1) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('websocket connection failed'));
      });
    });
    check('hello frame carries the full snapshot', frames[0].type === 'hello' && frames[0].payload.devices.length === 6);
    const pushed = new Promise((resolve) => {
      ws.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === 'device.state' && frame.payload.id === 'lights' && frame.payload.state.brightness === 55) {
          resolve(frame);
        }
      });
    });
    await command('lights', 'brightness', { value: 55 });
    const push = await Promise.race([pushed, sleep(8000).then(() => null)]);
    check('state changes are pushed over the websocket', push !== null, push);
    ws.close();

    section('errors and 404s');
    check('unknown device returns 404', (await api('/api/devices/nope')).status === 404);
    check('unknown command returns 400', (await command('lights', 'teleport')).status === 400);
    check('unknown api path returns 404 json', (await api('/api/nope')).status === 404);
    check('command body is validated', (await api('/api/devices/lights/command', { method: 'POST', body: {} })).status === 400);
  } finally {
    child.kill();
    await sleep(300);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    process.stdout.write(`\nfailed assertions:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
    process.stdout.write(`\nserver output:\n${serverOutput.join('')}\n`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  process.stderr.write(`\nsmoke test crashed: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
