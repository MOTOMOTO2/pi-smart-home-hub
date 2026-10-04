# HTTP API

Everything the dashboard does, it does through this. Useful for shell scripts,
Home Assistant REST commands, Shortcuts, or a physical button wired to a
`curl`.

Base URL is the hub itself, e.g. `http://pi.local:8080`.

## Authentication

Off by default. When `auth.token` is set in config, every request needs it:

```bash
curl -H "Authorization: Bearer $HUB_TOKEN" http://pi.local:8080/api/state
```

WebSocket clients pass it as `?token=`.

## Status codes

| Code | Meaning |
| --- | --- |
| `400` | Bad parameter, unknown command, or a command the device cannot perform |
| `401` | Missing or wrong token |
| `404` | No such device, scene or automation |
| `409` | The device is not paired yet |
| `500` | Something else went wrong; the message says what |

Errors are always `{"error": "..."}` with a message meant to be read by a
person.

---

## Devices

### `GET /api/devices`

Every device with its descriptor and last known state.

```json
[
  {
    "descriptor": {
      "id": "lights",
      "name": "Hexagons",
      "type": "nanoleaf",
      "room": "Living Room",
      "icon": "nanoleaf",
      "capabilities": ["power", "brightness", "color", "colorTemp", "effects"],
      "commands": [
        { "name": "brightness", "label": "Brightness", "group": "light",
          "params": [{ "name": "value", "type": "number", "min": 0, "max": 100, "unit": "%" }] }
      ]
    },
    "state": {
      "online": true, "updatedAt": 1791087025280,
      "on": true, "brightness": 62, "hue": 28, "saturation": 92,
      "hex": "#ff8f1a", "effect": "Northern Lights", "effects": ["Nemo", "..."]
    }
  }
]
```

`capabilities` is the contract the dashboard renders from. `state` is an open
bag — `online`, `updatedAt`, and optionally `needsSetup` and `error` are
always meaningful; the rest is adapter-specific.

`online` means the hub can talk to the device. `on` means it is powered. A TV
in standby is `online: true, on: false`.

### `GET /api/devices/:id`

One device.

### `POST /api/devices/:id/command`

```bash
curl -X POST http://pi.local:8080/api/devices/lights/command \
  -H 'content-type: application/json' \
  -d '{"command":"brightness","params":{"value":40}}'
```

Returns `{"ok": true, "message": "..."}`. The hub re-polls the device shortly
afterwards and pushes the new state over the WebSocket.

### `POST /api/devices/:id/refresh`

Force a poll now. Returns `{"state": {...}}`.

### `GET /api/devices/:id/snapshot`

Camera still, for devices with the `camera` capability. Returns image bytes.

### `POST /api/devices/:id/pair`

Pairing, per device type:

```bash
# Nanoleaf: hold the power button first
curl -X POST .../api/devices/lights/pair

# Ecobee: two steps
curl -X POST .../api/devices/thermostat/pair -d '{"step":"start"}'      # -> {"pin":"AB12"}
curl -X POST .../api/devices/thermostat/pair -d '{"step":"complete"}'

# Ring: sign in, then the 2FA code
curl -X POST .../api/devices/doorbell/pair \
  -d '{"step":"start","username":"you@example.com","password":"..."}'
curl -X POST .../api/devices/doorbell/pair -d '{"step":"verify","code":"123456"}'
```

---

## Scenes

| Method | Path | Effect |
| --- | --- | --- |
| `GET` | `/api/scenes` | All scenes, each tagged `source: "config" \| "user"` |
| `POST` | `/api/scenes` | Create one (stored by the hub) |
| `DELETE` | `/api/scenes/:id` | Delete a user scene; config scenes are protected |
| `POST` | `/api/scenes/:id/run` | Run it |

Running returns `{"ok": true, "ran": 4, "failed": []}`. One failing action does
not abort the rest — a dimmer being offline should not stop movie night — so
check `failed`.

```json
{
  "id": "bedtime", "name": "Bedtime", "icon": "moon", "favorite": true,
  "actions": [
    { "device": "tv", "command": "power", "params": { "on": false } },
    { "delayMs": 1000 },
    { "device": "lights", "command": "brightness", "params": { "value": 5 } }
  ]
}
```

---

## Automations

| Method | Path | Effect |
| --- | --- | --- |
| `GET` | `/api/automations` | List with trigger description and last run |
| `POST` | `/api/automations/:id/enabled` | `{"enabled": false}`, persisted across restarts |

Automations themselves are defined in config. Three trigger shapes:

```yaml
when: { event: ring.ding }                                    # hub event
when: { event: ring.motion, device: doorbell }                # from one device
when: { schedule: "30 7 * * 1-5" }                            # 5-field cron
when: { deviceState: { device: thermostat, path: temperature, below: 62 } }
```

`deviceState` also takes `above` and `equals`, and is edge-triggered: it fires
on the transition, not on every poll while the condition holds. `between:
{from, to}` limits the active window (it handles wrapping past midnight) and
`cooldownSeconds` debounces repeats.

### Events

| Event | Emitted when |
| --- | --- |
| `ring.ding` | Someone presses the doorbell |
| `ring.motion` | Motion detected |
| `ring.event` | Any other Ring event kind |
| `scene.run` | A scene starts |
| `device.command` | A command is dispatched (bookkeeping only — cannot trigger automations, which would let a scene retrigger itself) |

---

## System

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/health` | `{ok, version, demo, uptimeSeconds, devices: {total, online, needsSetup}}` |
| `GET` | `/api/state` | Everything: hub info, devices, scenes, automations, recent events |
| `GET` | `/api/events?limit=50` | Recent hub events, newest first |
| `GET` | `/api/logs?level=info&limit=200` | Buffered log lines |
| `POST` | `/api/refresh` | Re-poll every device |
| `POST` | `/api/discover` | LAN scan; returns pasteable config blocks |
| `POST` | `/api/demo/doorbell` | Demo mode only: `{"kind":"ding"\|"motion"}` |

`/api/health` is a good liveness probe: it answers without touching any device.

---

## WebSocket

Connect to `/ws` (`?token=` when auth is on). The server pushes; the client
only ever sends `{"type":"ping"}`.

| Frame | Payload |
| --- | --- |
| `hello` | Full snapshot on connect: devices, scenes, automations, events |
| `device.state` | `{id, state}` whenever a device is polled or changes |
| `event` | `{name, at, payload}` |
| `log` | A log record at info or above |

```js
const ws = new WebSocket('ws://pi.local:8080/ws');
ws.onmessage = (e) => {
  const { type, payload } = JSON.parse(e.data);
  if (type === 'device.state') console.log(payload.id, payload.state);
};
```

---

## CLI

`npm run hub -- <command>` is a thin client over this API, so it works from
anywhere that can reach the hub. It talks to the server rather than opening
the state file, so only one process ever owns your credentials.

```bash
npm run hub -- devices                      # status table
npm run hub -- do tv input input=hdmi1      # run a command
npm run hub -- scene movie-night            # run a scene
npm run hub -- discover                     # LAN scan
npm run hub -- pair doorbell username=you@example.com password=...
npm run hub -- logs warn
```

Set `HUB_URL` (default `http://localhost:8080`) and `HUB_TOKEN` as needed.
