# Device notes

What each adapter speaks, what it can and cannot do, and how to get it working.

---

## Nanoleaf

**Protocol:** Nanoleaf Open API — plain HTTP on port **16021**, token in the
URL path. Fully local; no Nanoleaf account involved.

**Models:** Light Panels (Aurora), Canvas, Shapes, Elements, Lines. Anything
that appears in the Nanoleaf app with "local API" support.

### Pairing

Hold the power button on the controller for **5–7 seconds** until the LED
flashes, then press Pair within 30 seconds. The hub `POST`s to
`/api/v1/new` and is handed a token, which it stores in `data/state.json`.

A 403 means the controller is not in pairing mode. If a stored token stops
working (factory reset, or removed in the app), the adapter notices the 401,
clears it and asks you to pair again.

### Commands

| Command | Parameters | Notes |
| --- | --- | --- |
| `power` | `on: boolean` | |
| `toggle` | | Reads current state first |
| `brightness` | `value: 0-100`, `duration: seconds` | `duration` fades |
| `color` | `hex: "#1e90ff"`, `keepBrightness: boolean` | Writes hue then saturation |
| `colorTemp` | `kelvin: 1200-6500` | |
| `effect` | `name: string` | From the discovered effect list |
| `identify` | | Flashes the panels |

### Colour, hue and brightness

The device model separates colour from intensity: hue and saturation set the
colour, brightness is its own control. The adapter therefore reports `hex` as
the **chroma** — hue and saturation rendered at full value — so a panel dimmed
to 10% still shows its true colour in the UI instead of near-black.

The consequence is that `#22c55e` (a 77%-value green) is reported back as
`#2bff79`. The dashboard compares chroma to chroma when deciding which swatch
to highlight. Pass `keepBrightness: true` to set a colour without disturbing
the current brightness.

Writing hue or saturation implicitly takes the panels out of effect mode,
which is why `color` is three separate writes rather than one.

---

## TCL TV — Roku models

**Protocol:** Roku External Control Protocol (ECP) — unauthenticated HTTP on
port **8060**. Every Roku-powered set exposes it on the LAN.

Confirm you have one by opening `http://<tv-ip>:8060/query/device-info` in a
browser. If you get XML back, you are set; there is nothing to pair.

### Standby

A TV in standby only answers ECP when **Settings → System → Power → Fast TV
Start** is enabled. Without it the set is electrically asleep. Set `mac` in
config and the adapter falls back to a Wake-on-LAN magic packet when ECP
power-on fails.

### Commands

| Command | Parameters | Notes |
| --- | --- | --- |
| `power` | `on: boolean` | Falls back to Wake-on-LAN when `mac` is set |
| `toggle` | | |
| `key` | `key: Home \| Back \| Up \| Down \| Left \| Right \| Select \| Play \| Rev \| Fwd \| Info \| …` | Full ECP key list |
| `volume` | `delta: -20..20` | One keypress per step; ECP has no absolute set |
| `mute` | | |
| `input` | `input: tuner \| hdmi1..4 \| av1` | |
| `launch` | `appId: string` | Channel list is discovered and cached |
| `text` | `text: string` | Types into search boxes, one `Lit_` key per character |

The adapter reads `power-mode`, volume, mute, the active app or input, the
channel list and now-playing (title, position, duration) when something is
streaming. The active input is reported by its friendly label (`HDMI2`), not
its routing id (`tvinput.hdmi2`).

---

## TCL TV — Google / Android TV models

**Protocol:** ADB over TCP. There is no open LAN control API on these sets.

Set `type: androidtv` instead of `rokutv`, then:

1. On the TV, enable **Settings → System → Developer options → Network
   debugging**. (Developer options appear after tapping the build number seven
   times.)
2. Install adb on the Pi: `sudo apt install adb`.
3. The first time the hub connects, the TV shows an RSA fingerprint prompt —
   accept it, and tick "always allow".

Supports power (via `KEYCODE_WAKEUP`/`KEYCODE_SLEEP`), volume, remote keys,
HDMI input switching and launching packages by name
(`com.netflix.ninja`, `com.google.android.youtube.tv`, …).

This is a more fragile integration than ECP: ADB authorisation can be revoked
by a TV firmware update, and `dumpsys` output varies by vendor. Prefer a Roku
TV if you have the choice.

---

## Xbox One S

**Protocol:** SmartGlass over UDP **5050** — the unauthenticated subset.

### What works

- **Discovery.** A broadcast discovery request gets a response from any awake
  console, carrying its name, UUID and certificate. The console's **live ID**
  is the certificate's subject CN — a 16-character string starting with `FD`.
  The adapter extracts it and stores it, so you never have to find it yourself:
  turn the console on once and press Refresh.
- **Power on.** A power-on packet containing the live ID wakes a console from
  standby. The console needs **Settings → General → Power mode → Instant-on**;
  in Energy-saving mode it is genuinely off and ignores the network.
  The adapter sends a burst of five packets to both the console address and
  the broadcast address, because consoles routinely miss the first one.

### What does not, and why

**Power off, launching a title and sending input are not supported.** Those
messages travel on an encrypted, authenticated channel: the client must
complete a certificate exchange with the console *and* present an Xbox Live
token obtained from a Microsoft account sign-in. Implementing it would mean
storing Microsoft credentials on the Pi and refreshing them indefinitely.
This project does not make that trade. Use the controller, a voice assistant,
or the console's own auto-sleep timer.

Note that a console in Instant-on standby stops answering discovery, so
"off" in the dashboard means "standby or powered down" — the hub cannot tell
those apart, and reports it as off rather than as an error.

---

## PC

**Waking** is a Wake-on-LAN magic packet: six `0xFF` bytes followed by the MAC
repeated sixteen times, sprayed to UDP ports 9, 7 and 40000 on both the global
broadcast address and your subnet's directed broadcast, since routers vary in
what they forward.

For this to work at all:

- Enable Wake-on-LAN in the **BIOS/UEFI** ("Power on by PCI-E", "Wake on
  LAN"), and disable ErP/EuP power saving, which cuts NIC power.
- Enable it in the **OS adapter settings** too — on Windows, Device Manager →
  adapter → Power Management → *Allow this device to wake the computer* and
  *Wake on Magic Packet*.
- Turn off Windows **Fast Startup**, which leaves the NIC unpowered after a
  shutdown (so wake works from sleep but not from off).
- Use the **wired** MAC. Wake-on-wireless is unreliable.

**Everything else** needs the companion agent in `agents/pc-agent/` — a single
dependency-free file that exposes sleep, shutdown, restart and lock behind a
shared token. See its README for running it at boot.

Without the agent the adapter still reports on/off by probing a TCP port
(`probePort`, default 3389/RDP; use 22 for SSH), and declares only the `wake`
capability — so the dashboard shows a Wake button rather than an on/off switch
it could not honour.

---

## Ecobee

**Protocol:** the official Ecobee API over HTTPS, `ecobeePin` OAuth flow.

### Getting a key

Ecobee requires each installation to register its own application — there is
no shared key:

1. Sign in at [ecobee.com](https://www.ecobee.com) with the account your
   thermostat is registered to.
2. **Developer** → **Create New Application**. Name it anything.
3. Authorization Method: **ecobee PIN**.
4. Copy the **API key** into `apiKey` (ideally as `${ECOBEE_API_KEY}`).

### Pairing

Press Pair for a 4-character PIN, add it at ecobee.com under **My Apps → Add
Application** within 9 minutes, then press Complete. The hub trades the code
for an access token (1 hour) and a refresh token, and refreshes automatically.
Concurrent refreshes are collapsed so two polls cannot spend the same token.

### Units

The API reports and accepts temperatures as **tenths of a degree Fahrenheit**
(`694` = 69.4°F). The adapter converts to whatever `scale` you configure, in
both directions, so a `setpoint` of 20 with `scale: C` arrives as 68°F.

### Commands

| Command | Parameters | Notes |
| --- | --- | --- |
| `setpoint` | `heat`, `cool`, `holdType`, `holdHours` | Either side may be omitted; the current value fills in |
| `nudge` | `delta: number` | In `heat`/`cool` mode moves only the active side; in `auto` slides the whole band |
| `hvacMode` | `mode: heat \| cool \| auto \| auxHeatOnly \| off` | |
| `fan` | `mode: on \| auto` | |
| `resume` | | Cancels the hold, back to schedule |

Running state is derived from `equipmentStatus`, which is a list of relay
names: `heatPump*`/`auxHeat*` mean heating, `compCool*` cooling. Note that
`compHotWater` is the water heater and deliberately does not count.

Remote room sensors are reported with temperature and occupancy.

`pollSeconds` defaults to 180 — Ecobee aggregates on roughly a three-minute
cadence, so polling faster only burns quota.

---

## Ring doorbell

**Protocol:** the endpoints the Ring mobile app uses. Ring publishes no public
API, so this is reverse-engineered and could break if Ring changes it.

### Pairing

Sign in with your Ring email and password; Ring replies `412` and sends a
verification code by SMS or email; the hub resends the grant with the code
attached and receives tokens. **Only the refresh token is stored** — the
password is held in memory for the length of the sign-in and then dropped.

The hub generates a stable `hardware_id` on first run and reuses it, so Ring
treats it as one known device and does not re-challenge for 2FA each time.
Ring invalidates a refresh token once used, so the newest one is persisted on
every refresh.

### Scope

| Command | Notes |
| --- | --- |
| `snapshot` | Asks the device for a fresh still |
| `light` | `on: boolean`, cameras with a floodlight |
| `siren` | `on: boolean`, cameras with a siren |
| `playback` | `eventId`, returns a recording URL |

State includes battery, wifi name and signal strength, firmware, whether
someone is ringing right now, and the last dozen motion/ding events.
`GET /api/devices/<id>/snapshot` proxies the latest still.

**Live video is out of scope.** Ring streams over WebRTC with its own
signalling; supporting it would mean a large dependency surface for something
the Ring app already does well.

### Events and automations

Each poll compares the event feed against the last seen id and emits
`ring.ding` or `ring.motion` for anything new, oldest first, which is what
drives automations. On the first poll after a restart the hub only records the
cursor — replaying yesterday's events on every reboot would be worse than
missing one.

**Rate limits are real.** Ring returns `429` if you poll hard; `pollSeconds`
defaults to 45 and the schema will not let you go below 10. If you see rate
limit errors in the log, raise it.
