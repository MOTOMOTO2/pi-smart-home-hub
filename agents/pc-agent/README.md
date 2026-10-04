# PC companion agent

Wake-on-LAN can start a PC, but nothing in the network stack can put one to
sleep. This agent runs on the PC and gives the hub four actions: **sleep**,
**shutdown**, **restart** and **lock**, plus a `/status` endpoint the hub uses
to tell whether the machine is awake.

It is a single file with no dependencies. It needs Node 18 or newer, and it
only answers requests that carry a shared token.

If you skip the agent entirely the hub still works: it can wake the PC with a
magic packet and infer on/off by probing a TCP port. You just will not get the
sleep / shutdown / restart / lock buttons.

## Run it

```bash
node agent.mjs --token=change-me-to-something-random
```

Generate a token with `openssl rand -hex 16`, or any password manager.

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--token=` | `HUB_AGENT_TOKEN` | *(required)* | Shared secret; must match `agentToken` in the hub config |
| `--port=` | `HUB_AGENT_PORT` | `3445` | Listening port |
| `--host=` | `HUB_AGENT_HOST` | `0.0.0.0` | Bind address |
| `--allow=` | `HUB_AGENT_ALLOW` | *(any)* | Comma-separated list of IPs allowed to connect, e.g. the Pi |

Then point the hub at it in `config/hub.yaml`:

```yaml
- id: pc
  name: Battlestation
  type: pc
  host: 192.168.1.74
  mac: "A4:BB:6D:11:22:33"
  agentUrl: http://192.168.1.74:3445
  agentToken: ${PC_AGENT_TOKEN}
```

Restricting the agent to the hub is worth doing:

```bash
node agent.mjs --token=... --allow=192.168.1.10
```

## Start it at boot

### Windows (Task Scheduler)

Run in an **administrator** PowerShell, substituting your paths and token:

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
             -Argument "C:\hub-agent\agent.mjs --token=YOUR_TOKEN" `
             -WorkingDirectory "C:\hub-agent"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
               -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "Hub PC Agent" -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings
```

Allow the port through the firewall, scoped to your LAN:

```powershell
New-NetFirewallRule -DisplayName "Hub PC Agent" -Direction Inbound -Protocol TCP `
  -LocalPort 3445 -Action Allow -RemoteAddress LocalSubnet
```

Note that `lock` only has an effect when run in the signed-in user session.
If you mainly want the lock button, register the task under your own user
account with "Run only when user is logged on" instead of SYSTEM.

### Linux (systemd)

```ini
# /etc/systemd/system/hub-pc-agent.service
[Unit]
Description=Home hub PC agent
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/hub-agent/agent.mjs
Environment=HUB_AGENT_TOKEN=YOUR_TOKEN
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now hub-pc-agent
```

`systemctl suspend` and `poweroff` need root, which is why the unit runs as
root. If you would rather not, run it as your user and grant just those two
verbs with a polkit rule.

### macOS (launchd)

Put a plist in `~/Library/LaunchAgents/` that runs
`node /path/to/agent.mjs --token=...` with `RunAtLoad`, then
`launchctl load` it. Sleep and display-sleep work as the logged-in user;
shutdown and restart prompt unless the user is an admin.

## Also check

- **BIOS/UEFI**: enable "Wake on LAN", "Power on by PCI-E", or similarly named
  setting, and disable ErP / EuP power saving, which cuts power to the NIC.
- **Windows adapter settings**: Device Manager → your network adapter →
  Power Management → tick *Allow this device to wake the computer*, and under
  Advanced enable *Wake on Magic Packet*.
- **Fast Startup**: Windows "fast startup" leaves the NIC unpowered after a
  shutdown, so Wake-on-LAN works from sleep but not from off. Turn it off
  under Control Panel → Power Options → Choose what the power buttons do.
- Use the **wired** MAC address. Wake-on-wireless is unreliable and often
  unsupported.

## Endpoints

All require `Authorization: Bearer <token>` (or `?token=`).

| Method | Path | Effect |
| --- | --- | --- |
| `GET` | `/status` | hostname, platform, uptime, memory, agent version |
| `POST` | `/sleep` | suspend to RAM |
| `POST` | `/shutdown` | power off |
| `POST` | `/restart` | reboot |
| `POST` | `/lock` | lock the screen |

Action responses are sent *before* the command runs, since shutting down kills
the process mid-response.
