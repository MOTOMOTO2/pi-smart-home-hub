/**
 * Thin HTTP client for a running hub, for the jobs that are awkward over a
 * touchscreen: discovery scans, Ecobee/Ring pairing from an SSH session, and
 * firing scenes from a shell script or cron job.
 *
 * It deliberately talks to the server rather than opening the state file, so
 * there is only ever one process owning credentials.
 */
const BASE = process.env['HUB_URL'] ?? 'http://localhost:8080';
const TOKEN = process.env['HUB_TOKEN'];

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
}

async function api<T = unknown>(pathname: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (TOKEN) headers['authorization'] = `Bearer ${TOKEN}`;

  let res: Response;
  try {
    res = await fetch(`${BASE}${pathname}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new Error(`cannot reach the hub at ${BASE} (${err instanceof Error ? err.message : String(err)})`);
  }

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

function parseParams(args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const arg of args) {
    const idx = arg.indexOf('=');
    if (idx <= 0) continue;
    const key = arg.slice(0, idx);
    const raw = arg.slice(idx + 1);
    if (raw === 'true') params[key] = true;
    else if (raw === 'false') params[key] = false;
    else if (raw !== '' && !Number.isNaN(Number(raw))) params[key] = Number(raw);
    else params[key] = raw;
  }
  return params;
}

function out(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

const USAGE = `pi-smart-home-hub CLI

Usage: npm run hub -- <command> [args]

  status                              hub health summary
  devices                             list devices with their live state
  show <deviceId>                     full state and supported commands
  refresh [deviceId]                  re-poll one device or all of them
  do <deviceId> <command> [k=v ...]   run a command, e.g. do tv input input=hdmi1
  discover                            scan the LAN for Nanoleaf / Roku TV / Xbox
  scenes                              list scenes
  scene <sceneId>                     run a scene
  automations                         list automations and their triggers
  pair <deviceId> [k=v ...]           pair a device (see below)
  events [limit]                      recent hub events
  logs [level]                        recent log lines

Pairing:
  Nanoleaf   hold the power button 5-7s, then:  pair lights
  Ecobee     pair thermo                  -> shows a PIN to add at ecobee.com
             pair thermo step=complete    -> claims the tokens
  Ring       pair doorbell username=you@example.com password=secret
             pair doorbell step=verify code=123456

Environment:
  HUB_URL    hub base URL (default http://localhost:8080)
  HUB_TOKEN  bearer token, when auth.token is set in config
`;

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE.trimEnd());
      return;

    case 'status':
      out(await api('/api/health'));
      return;

    case 'devices': {
      const devices = await api<Array<{ descriptor: { id: string; name: string; type: string }; state: Record<string, unknown> }>>(
        '/api/devices',
      );
      const rows = devices.map((d) => {
        const flags: string[] = [];
        if (d.state['needsSetup'] === true) flags.push('needs setup');
        if (d.state['error']) flags.push(String(d.state['error']));
        return `${d.state.online ? 'up  ' : 'down'}  ${d.descriptor.id.padEnd(14)} ${d.descriptor.type.padEnd(10)} ${d.descriptor.name}${
          flags.length ? `  (${flags.join('; ')})` : ''
        }`;
      });
      out(rows.join('\n') || 'no devices configured');
      return;
    }

    case 'show': {
      const id = rest[0];
      if (!id) throw new Error('usage: show <deviceId>');
      out(await api(`/api/devices/${encodeURIComponent(id)}`));
      return;
    }

    case 'refresh': {
      const id = rest[0];
      out(id ? await api(`/api/devices/${encodeURIComponent(id)}/refresh`, { method: 'POST' }) : await api('/api/refresh', { method: 'POST' }));
      return;
    }

    case 'do': {
      const [id, cmd, ...params] = rest;
      if (!id || !cmd) throw new Error('usage: do <deviceId> <command> [key=value ...]');
      out(
        await api(`/api/devices/${encodeURIComponent(id)}/command`, {
          method: 'POST',
          body: { command: cmd, params: parseParams(params) },
        }),
      );
      return;
    }

    case 'discover': {
      const found = await api<Array<{ type: string; name: string; host?: string; suggestedConfig: unknown }>>(
        '/api/discover',
        { method: 'POST' },
      );
      if (found.length === 0) {
        out('nothing found. Nanoleaf and Roku TVs must be powered on; the Xbox must be awake.');
        return;
      }
      out(`found ${found.length} device(s). Add any of these under "devices:" in config/hub.yaml:\n`);
      for (const device of found) out(device.suggestedConfig);
      return;
    }

    case 'scenes':
      out(await api('/api/scenes'));
      return;

    case 'scene': {
      const id = rest[0];
      if (!id) throw new Error('usage: scene <sceneId>');
      out(await api(`/api/scenes/${encodeURIComponent(id)}/run`, { method: 'POST' }));
      return;
    }

    case 'automations':
      out(await api('/api/automations'));
      return;

    case 'pair': {
      const id = rest[0];
      if (!id) throw new Error('usage: pair <deviceId> [key=value ...]');
      out(await api(`/api/devices/${encodeURIComponent(id)}/pair`, { method: 'POST', body: parseParams(rest.slice(1)) }));
      return;
    }

    case 'events':
      out(await api(`/api/events?limit=${Number(rest[0] ?? 20)}`));
      return;

    case 'logs': {
      const records = await api<Array<{ ts: number; level: string; scope: string; message: string }>>(
        `/api/logs?level=${rest[0] ?? 'info'}&limit=100`,
      );
      out(
        records
          .map((r) => `${new Date(r.ts).toISOString().slice(11, 19)} ${r.level.padEnd(5)} [${r.scope}] ${r.message}`)
          .join('\n'),
      );
      return;
    }

    default:
      throw new Error(`unknown command "${command}". Run with --help for usage.`);
  }
}

void run(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
