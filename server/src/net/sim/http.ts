import { kelvinToRgb, rgbToHex } from '../../util/color.js';
import { makeResponse, type HttpRequest, type HttpResponse } from '../transport.js';
import type { SimWorld } from './world.js';

export const DEMO_NANOLEAF_TOKEN = 'demo-nanoleaf-token';

type Handler = (url: URL, req: HttpRequest, world: SimWorld) => HttpResponse | null;

function json(status: number, body: unknown): HttpResponse {
  return makeResponse(status, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(body), 'utf8'));
}

function xml(body: string): HttpResponse {
  return makeResponse(200, { 'content-type': 'text/xml' }, Buffer.from(body, 'utf8'));
}

function empty(status = 200): HttpResponse {
  return makeResponse(status, {}, Buffer.alloc(0));
}

function parseBody(req: HttpRequest): Record<string, unknown> {
  if (!req.body) return {};
  try {
    const text = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
    const parsed: unknown = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Nanoleaf Open API
// ---------------------------------------------------------------------------
const nanoleaf: Handler = (url, req, world) => {
  if (url.port !== '16021') return null;
  const state = world.nanoleaf;

  if (url.pathname === '/api/v1/new' && req.method === 'POST') {
    return json(200, { auth_token: DEMO_NANOLEAF_TOKEN });
  }

  const match = /^\/api\/v1\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  const rest = match[2] ?? '/';

  if (rest === '/' && (req.method ?? 'GET') === 'GET') {
    return json(200, {
      name: 'Shapes Hexagons',
      serialNo: 'S19042H00123',
      manufacturer: 'Nanoleaf',
      firmwareVersion: '7.3.2',
      model: 'NL42',
      state: {
        on: { value: state.on },
        brightness: { value: state.brightness, max: 100, min: 0 },
        hue: { value: state.hue, max: 360, min: 0 },
        sat: { value: state.sat, max: 100, min: 0 },
        ct: { value: state.ct, max: 6500, min: 1200 },
        colorMode: state.colorMode,
      },
      effects: { select: state.effect, effectsList: state.effectsList },
      panelLayout: { layout: { numPanels: 9 } },
    });
  }

  if (rest === '/state' && req.method === 'PUT') {
    const body = parseBody(req) as Record<string, { value?: unknown }>;
    if (body['on']?.value !== undefined) state.on = Boolean(body['on'].value);
    if (body['brightness']?.value !== undefined) {
      state.brightness = Number(body['brightness'].value);
      if (state.brightness > 0) state.on = true;
    }
    if (body['hue']?.value !== undefined) {
      state.hue = Number(body['hue'].value);
      state.colorMode = 'hs';
      state.effect = '*Solid*';
    }
    if (body['sat']?.value !== undefined) {
      state.sat = Number(body['sat'].value);
      state.colorMode = 'hs';
      state.effect = '*Solid*';
    }
    if (body['ct']?.value !== undefined) {
      state.ct = Number(body['ct'].value);
      state.colorMode = 'ct';
      state.effect = '*Solid*';
    }
    return empty(204);
  }

  if (rest === '/effects' && req.method === 'PUT') {
    const body = parseBody(req);
    const select = body['select'];
    if (typeof select === 'string') {
      if (!state.effectsList.includes(select)) return json(400, { error: 'unknown effect' });
      state.effect = select;
      state.colorMode = 'effect';
      state.on = true;
    }
    return empty(204);
  }

  if (rest === '/effects/effectsList') return json(200, state.effectsList);

  if (rest === '/identify' && req.method === 'PUT') {
    state.identifyCount += 1;
    return empty(204);
  }

  return json(404, { error: 'not found' });
};

// ---------------------------------------------------------------------------
// Roku ECP
// ---------------------------------------------------------------------------
const DEMO_APPS: Array<{ id: string; name: string }> = [
  { id: '12', name: 'Netflix' },
  { id: '13', name: 'Prime Video' },
  { id: '837', name: 'YouTube' },
  { id: '2213', name: 'Plex' },
  { id: '291097', name: 'Disney+' },
  { id: 'tvinput.hdmi1', name: 'HDMI1' },
  { id: 'tvinput.hdmi2', name: 'HDMI2' },
  { id: 'tvinput.hdmi3', name: 'HDMI3' },
];

const INPUT_KEY_TO_APP: Record<string, { id: string; name: string }> = {
  InputTuner: { id: 'tvinput.dtv', name: 'Antenna TV' },
  InputHDMI1: { id: 'tvinput.hdmi1', name: 'HDMI1' },
  InputHDMI2: { id: 'tvinput.hdmi2', name: 'HDMI2' },
  InputHDMI3: { id: 'tvinput.hdmi3', name: 'HDMI3' },
  InputHDMI4: { id: 'tvinput.hdmi4', name: 'HDMI4' },
  InputAV1: { id: 'tvinput.av1', name: 'AV1' },
};

const roku: Handler = (url, req, world) => {
  if (url.port !== '8060') return null;
  const tv = world.roku;

  if (url.pathname === '/query/device-info') {
    return xml(`<?xml version="1.0" encoding="UTF-8" ?>
<device-info>
  <udn>29ee2d78-c1b4-5d2a-b1cf-4d1f2a3b4c5d</udn>
  <serial-number>X01500DEMO42</serial-number>
  <device-id>S01500DEMO42</device-id>
  <vendor-name>TCL</vendor-name>
  <model-name>55S425</model-name>
  <friendly-model-name>TCL 4 Series Roku TV</friendly-model-name>
  <friendly-device-name>Living Room TV</friendly-device-name>
  <software-version>13.0.4</software-version>
  <power-mode>${tv.on ? 'PowerOn' : 'DisplayOff'}</power-mode>
  <supports-wake-on-wlan>true</supports-wake-on-wlan>
  <volume-level>${tv.volume}</volume-level>
  <is-muted>${tv.muted}</is-muted>
  <is-tv>true</is-tv>
</device-info>`);
  }

  if (url.pathname === '/query/apps') {
    const apps = DEMO_APPS.map((a) => `  <app id="${a.id}" type="appl" version="1.0">${a.name}</app>`).join('\n');
    return xml(`<?xml version="1.0" encoding="UTF-8" ?>\n<apps>\n${apps}\n</apps>`);
  }

  if (url.pathname === '/query/active-app') {
    if (tv.activeAppId.startsWith('tvinput.')) {
      return xml(
        `<?xml version="1.0" encoding="UTF-8" ?>\n<active-app>\n  <input id="${tv.activeAppId}" type="tvin">${tv.activeApp}</input>\n</active-app>`,
      );
    }
    return xml(
      `<?xml version="1.0" encoding="UTF-8" ?>\n<active-app>\n  <app id="${tv.activeAppId}" type="appl">${tv.activeApp}</app>\n</active-app>`,
    );
  }

  if (url.pathname === '/query/media-player') {
    if (tv.playState === 'none') {
      return xml('<?xml version="1.0" encoding="UTF-8" ?>\n<player error="false" state="close"></player>');
    }
    return xml(`<?xml version="1.0" encoding="UTF-8" ?>
<player error="false" state="${tv.playState}">
  <plugin id="${tv.activeAppId}" name="${tv.activeApp}" />
  <title>The Demo Episode</title>
  <position>842000 ms</position>
  <duration>2640000 ms</duration>
</player>`);
  }

  const keypress = /^\/keypress\/(.+)$/.exec(url.pathname);
  if (keypress && req.method === 'POST') {
    const key = decodeURIComponent(keypress[1] ?? '');
    tv.lastKey = key;
    if (key === 'PowerOff') tv.on = false;
    else if (key === 'PowerOn') tv.on = true;
    else if (key === 'Power') tv.on = !tv.on;
    else if (key === 'VolumeUp') tv.volume = Math.min(100, tv.volume + 1);
    else if (key === 'VolumeDown') tv.volume = Math.max(0, tv.volume - 1);
    else if (key === 'VolumeMute') tv.muted = !tv.muted;
    else if (key === 'Play') tv.playState = tv.playState === 'play' ? 'pause' : 'play';
    else if (key === 'Home') {
      tv.activeAppId = 'Home';
      tv.activeApp = 'Roku';
      tv.playState = 'none';
    } else if (key.startsWith('Lit_')) {
      tv.typed += decodeURIComponent(key.slice(4));
    } else {
      const input = INPUT_KEY_TO_APP[key];
      if (input) {
        tv.activeAppId = input.id;
        tv.activeApp = input.name;
        tv.playState = 'none';
        tv.on = true;
      }
    }
    return empty(200);
  }

  const launch = /^\/launch\/(.+)$/.exec(url.pathname);
  if (launch && req.method === 'POST') {
    const id = decodeURIComponent(launch[1] ?? '');
    const app = DEMO_APPS.find((a) => a.id === id);
    tv.activeAppId = id;
    tv.activeApp = app?.name ?? id;
    tv.playState = id.startsWith('tvinput.') ? 'none' : 'play';
    tv.on = true;
    return empty(200);
  }

  return json(404, { error: 'not found' });
};

// ---------------------------------------------------------------------------
// Ecobee
// ---------------------------------------------------------------------------
const ecobee: Handler = (url, req, world) => {
  if (url.hostname !== 'api.ecobee.com') return null;
  const t = world.ecobee;

  if (url.pathname === '/authorize') {
    t.pin = 'AB12';
    t.pinCode = 'demo-authorization-code';
    t.pinClaimed = false;
    return json(200, { ecobeePin: t.pin, code: t.pinCode, scope: 'smartWrite', expires_in: 9, interval: 30 });
  }

  if (url.pathname === '/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'ecobeePin') {
      const code = url.searchParams.get('code');
      if (code !== t.pinCode) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
      // Demo convenience: the PIN counts as entered on the second attempt, so
      // the "authorization_pending" path is exercised at least once.
      if (!t.pinClaimed) {
        t.pinClaimed = true;
        return json(401, { error: 'authorization_pending', error_description: 'Waiting for the PIN to be entered' });
      }
      return json(200, { access_token: t.accessToken, refresh_token: t.refreshToken, expires_in: 3600, token_type: 'Bearer' });
    }
    if (grant === 'refresh_token') {
      if (url.searchParams.get('code') !== t.refreshToken) {
        return json(400, { error: 'invalid_grant' });
      }
      return json(200, { access_token: t.accessToken, refresh_token: t.refreshToken, expires_in: 3600, token_type: 'Bearer' });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  if (url.pathname === '/1/thermostat') {
    const auth = req.headers?.['authorization'] ?? req.headers?.['Authorization'];
    if (auth !== `Bearer ${t.accessToken}`) {
      return json(401, { status: { code: 14, message: 'Authentication token has expired' } });
    }

    if ((req.method ?? 'GET') === 'GET') {
      return json(200, {
        page: { page: 1, totalPages: 1, pageSize: 1, total: 1 },
        thermostatList: [
          {
            identifier: '511941000000',
            name: 'Home',
            brand: 'ecobee',
            modelNumber: 'athenaSmart',
            runtime: {
              connected: true,
              actualTemperature: t.actualTemperature,
              actualHumidity: t.actualHumidity,
              desiredHeat: t.desiredHeat,
              desiredCool: t.desiredCool,
              desiredFanMode: t.fanMode,
            },
            settings: {
              hvacMode: t.hvacMode,
              heatRangeLow: 450,
              heatRangeHigh: 790,
              coolRangeLow: 650,
              coolRangeHigh: 920,
              fanMinOnTime: 5,
            },
            equipmentStatus: t.equipmentStatus,
            events: t.holdActive
              ? [{ type: 'hold', running: true, name: 'hold', endDate: '2026-10-03', endTime: '22:00:00' }]
              : [],
            remoteSensors: [
              {
                id: 'rs:100',
                name: 'Living Room',
                type: 'ecobee3_remote_sensor',
                capability: [
                  { id: '1', type: 'temperature', value: String(t.actualTemperature + 8) },
                  { id: '2', type: 'occupancy', value: 'true' },
                ],
              },
              {
                id: 'rs:101',
                name: 'Bedroom',
                type: 'ecobee3_remote_sensor',
                capability: [
                  { id: '1', type: 'temperature', value: String(t.actualTemperature - 21) },
                  { id: '2', type: 'occupancy', value: 'false' },
                ],
              },
            ],
          },
        ],
        status: { code: 0, message: '' },
      });
    }

    const body = parseBody(req);
    const functions = (body['functions'] ?? []) as Array<{ type?: string; params?: Record<string, unknown> }>;
    for (const fn of functions) {
      if (fn.type === 'setHold') {
        const p = fn.params ?? {};
        if (typeof p['heatHoldTemp'] === 'number') t.desiredHeat = p['heatHoldTemp'];
        if (typeof p['coolHoldTemp'] === 'number') t.desiredCool = p['coolHoldTemp'];
        if (typeof p['fan'] === 'string') t.fanMode = p['fan'];
        t.holdActive = true;
      } else if (fn.type === 'resumeProgram') {
        t.holdActive = false;
        t.desiredHeat = 700;
        t.desiredCool = 755;
        t.fanMode = 'auto';
      }
    }
    const thermostat = body['thermostat'] as { settings?: { hvacMode?: string } } | undefined;
    if (thermostat?.settings?.hvacMode) {
      t.hvacMode = thermostat.settings.hvacMode;
      t.equipmentStatus = t.hvacMode === 'cool' ? 'compCool1' : t.hvacMode === 'off' ? '' : 'heatPump';
    }
    return json(200, { status: { code: 0, message: '' } });
  }

  return json(404, { status: { code: 404, message: 'not found' } });
};

// ---------------------------------------------------------------------------
// Ring
// ---------------------------------------------------------------------------
const PLACEHOLDER_SNAPSHOT = (label: string): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#1b2430"/><stop offset="100%" stop-color="#0a0e14"/>
  </linearGradient></defs>
  <rect width="640" height="360" fill="url(#g)"/>
  <rect x="210" y="120" width="220" height="200" rx="8" fill="#243041"/>
  <circle cx="320" cy="150" r="10" fill="#4b6075"/>
  <text x="320" y="56" fill="#7d8fa3" font-family="monospace" font-size="18" text-anchor="middle">DEMO CAMERA</text>
  <text x="320" y="340" fill="#55657a" font-family="monospace" font-size="13" text-anchor="middle">${label}</text>
</svg>`,
    'utf8',
  );

const ring: Handler = (url, req, world) => {
  const r = world.ring;

  if (url.hostname === 'oauth.ring.com') {
    const body = parseBody(req);
    const grant = body['grant_type'];
    if (grant === 'refresh_token') {
      if (body['refresh_token'] !== r.refreshToken) return json(401, { error: 'invalid_grant' });
      return json(200, { access_token: r.accessToken, refresh_token: r.refreshToken, expires_in: 3600, scope: 'client' });
    }
    if (grant === 'password') {
      const code = req.headers?.['2fa-code'];
      if (!code) {
        r.twoFactorPending = true;
        return json(412, { next_time_in_secs: 60, phone: '**-**-**-89', tsv_state: 'sms' });
      }
      if (code !== '123456') return json(400, { error: 'invalid_code', error_description: 'Verification code is wrong (demo expects 123456)' });
      r.twoFactorPending = false;
      return json(200, { access_token: r.accessToken, refresh_token: r.refreshToken, expires_in: 3600, scope: 'client' });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  if (url.hostname !== 'api.ring.com') return null;
  if (req.headers?.['authorization'] !== `Bearer ${r.accessToken}`) {
    return json(401, { error: 'unauthorized' });
  }

  if (url.pathname === '/clients_api/ring_devices') {
    return json(200, {
      doorbots: [
        {
          id: r.deviceId,
          description: r.description,
          kind: 'doorbell_v4',
          battery_life: String(r.battery),
          firmware_version: r.firmware,
          led_status: r.lightOn ? 'on' : 'off',
          siren_status: { seconds_remaining: r.sirenOn ? 30 : 0 },
        },
      ],
      authorized_doorbots: [],
      stickup_cams: [],
      chimes: [],
      base_stations: [],
      other: [],
    });
  }

  const health = /^\/clients_api\/doorbots\/(\d+)\/health$/.exec(url.pathname);
  if (health) {
    return json(200, {
      device_health: {
        id: r.deviceId,
        battery_percentage: r.battery,
        latest_signal_strength: r.signalStrength,
        latest_signal_category: r.signalStrength > -60 ? 'good' : 'fair',
        firmware: r.firmware,
        wifi_name: 'HomeNet-5G',
      },
    });
  }

  if (url.pathname === '/clients_api/doorbots/history') {
    const limit = Number(url.searchParams.get('limit') ?? '20');
    return json(
      200,
      r.events.slice(0, limit).map((event) => ({
        id: event.id,
        created_at: event.created_at,
        kind: event.kind,
        answered: event.answered,
        duration: event.duration,
        recording: { status: 'ready' },
        doorbot: { id: r.deviceId, description: r.description },
      })),
    );
  }

  if (url.pathname === '/clients_api/dings/active') {
    if (!r.activeDing) return json(200, []);
    const newest = r.events[0];
    return json(200, [
      {
        id: newest?.id ?? 1,
        id_str: String(newest?.id ?? 1),
        doorbot_id: r.deviceId,
        kind: 'ding',
        expires_in: 45,
        now: Date.now() / 1000,
      },
    ]);
  }

  if (url.pathname === '/clients_api/snapshots/update_all' && req.method === 'POST') {
    r.snapshotRequestedAt = Date.now();
    return json(200, {});
  }

  const image = /^\/clients_api\/snapshots\/image\/(\d+)$/.exec(url.pathname);
  if (image) {
    return makeResponse(
      200,
      { 'content-type': 'image/svg+xml' },
      PLACEHOLDER_SNAPSHOT(new Date(r.snapshotRequestedAt).toLocaleTimeString()),
    );
  }

  const light = /^\/clients_api\/doorbots\/(\d+)\/floodlight_light_(on|off)$/.exec(url.pathname);
  if (light) {
    r.lightOn = light[2] === 'on';
    return json(200, {});
  }

  const siren = /^\/clients_api\/doorbots\/(\d+)\/siren_(on|off)$/.exec(url.pathname);
  if (siren) {
    r.sirenOn = siren[2] === 'on';
    return json(200, {});
  }

  const play = /^\/clients_api\/dings\/([^/]+)\/share\/play$/.exec(url.pathname);
  if (play) {
    return json(200, { url: `https://example.invalid/demo-recording/${play[1]}.mp4`, wait: 0 });
  }

  return json(404, { error: 'not found' });
};

// ---------------------------------------------------------------------------
// PC companion agent
// ---------------------------------------------------------------------------
const pcAgent: Handler = (url, req, world) => {
  if (url.port !== '3445') return null;
  const pc = world.pc;
  if (!pc.on) {
    // A sleeping PC does not answer: surface it the way a real socket would.
    return makeResponse(0, {}, Buffer.alloc(0));
  }

  if (url.pathname === '/status') {
    return json(200, {
      hostname: pc.hostname,
      platform: pc.platform,
      uptimeSeconds: Math.round((Date.now() - pc.bootedAt) / 1000),
      memory: { totalMb: 32_768, freeMb: 19_004 },
      agentVersion: '1.0.0-demo',
    });
  }

  if (req.method === 'POST' && ['/sleep', '/shutdown', '/restart'].includes(url.pathname)) {
    pc.on = false;
    if (url.pathname === '/restart') {
      setTimeout(() => {
        pc.on = true;
        pc.bootedAt = Date.now();
      }, 4000).unref?.();
    }
    return json(200, { ok: true, action: url.pathname.slice(1) });
  }

  if (req.method === 'POST' && url.pathname === '/lock') return json(200, { ok: true, action: 'lock' });

  return json(404, { error: 'not found' });
};

const HANDLERS: Handler[] = [nanoleaf, roku, ecobee, ring, pcAgent];

export function handleSimHttp(rawUrl: string, req: HttpRequest, world: SimWorld): HttpResponse {
  const url = new URL(rawUrl);
  for (const handler of HANDLERS) {
    const res = handler(url, req, world);
    if (res) {
      if (res.status === 0) throw new Error(`connect ECONNREFUSED ${url.host} (demo: device is powered off)`);
      return res;
    }
  }
  throw new Error(`demo transport has no handler for ${rawUrl}`);
}
