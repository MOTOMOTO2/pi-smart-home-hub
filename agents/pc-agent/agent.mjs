#!/usr/bin/env node
/**
 * Companion agent for pi-smart-home-hub.
 *
 * Wake-on-LAN can start a PC but there is no standard way to put one to sleep
 * from the network, so this tiny service runs on the PC and exposes exactly
 * four actions to the hub: sleep, shutdown, restart and lock. It has no
 * dependencies, speaks plain HTTP, and only answers requests carrying the
 * shared token.
 *
 *   node agent.mjs --token=<secret>
 *
 * Environment variables work too: HUB_AGENT_TOKEN, HUB_AGENT_PORT,
 * HUB_AGENT_HOST, HUB_AGENT_ALLOW.
 *
 * Then in config/hub.yaml:
 *   - id: pc
 *     type: pc
 *     mac: "A4:BB:6D:11:22:33"
 *     agentUrl: http://192.168.1.74:3445
 *     agentToken: <the same secret>
 *
 * See README.md in this folder for running it at boot on Windows and Linux.
 */
import http from 'node:http';
import os from 'node:os';
import { exec } from 'node:child_process';

const VERSION = '1.0.0';

function arg(name, fallback) {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

const PORT = Number(arg('port', process.env.HUB_AGENT_PORT ?? 3445));
const HOST = arg('host', process.env.HUB_AGENT_HOST ?? '0.0.0.0');
const TOKEN = arg('token', process.env.HUB_AGENT_TOKEN ?? '');
/** Optional comma-separated allowlist of hub IPs, e.g. --allow=192.168.1.10 */
const ALLOW = (arg('allow', process.env.HUB_AGENT_ALLOW ?? '') || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (!TOKEN) {
  process.stderr.write(
    'refusing to start without a token.\n\n' +
      '  node agent.mjs --token=$(openssl rand -hex 16)\n\n' +
      'Use the same value for agentToken in the hub config.\n',
  );
  process.exit(1);
}

/**
 * Per-platform commands. Windows sleep goes through SetSuspendState, which
 * hibernates instead if hibernation is enabled -- disable it with
 * `powercfg -hibernate off` if you want true sleep.
 */
const ACTIONS = {
  win32: {
    sleep: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
    shutdown: 'shutdown /s /t 0',
    restart: 'shutdown /r /t 0',
    lock: 'rundll32.exe user32.dll,LockWorkStation',
  },
  linux: {
    sleep: 'systemctl suspend',
    shutdown: 'systemctl poweroff',
    restart: 'systemctl reboot',
    lock: 'loginctl lock-session',
  },
  darwin: {
    sleep: 'pmset sleepnow',
    shutdown: 'osascript -e \'tell app "System Events" to shut down\'',
    restart: 'osascript -e \'tell app "System Events" to restart\'',
    lock: 'pmset displaysleepnow',
  },
};

const platform = ACTIONS[process.platform] ?? ACTIONS.linux;

function run(command) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function clientIp(req) {
  const raw = req.socket.remoteAddress ?? '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/** Constant-time compare so the token cannot be guessed a character at a time. */
function tokenMatches(provided) {
  if (provided.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i += 1) diff |= TOKEN.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const ip = clientIp(req);

  if (ALLOW.length > 0 && !ALLOW.includes(ip)) {
    process.stdout.write(`${new Date().toISOString()} refused ${url.pathname} from ${ip} (not allowlisted)\n`);
    json(res, 403, { error: 'address not allowed' });
    return;
  }

  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') ?? '');
  if (!tokenMatches(provided)) {
    json(res, 401, { error: 'invalid token' });
    return;
  }

  if (url.pathname === '/status' && req.method === 'GET') {
    const total = os.totalmem() / 1024 / 1024;
    const free = os.freemem() / 1024 / 1024;
    json(res, 200, {
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      uptimeSeconds: Math.round(os.uptime()),
      loadAverage: os.loadavg(),
      memory: { totalMb: Math.round(total), freeMb: Math.round(free) },
      agentVersion: VERSION,
    });
    return;
  }

  const action = url.pathname.slice(1);
  if (req.method === 'POST' && action in platform) {
    process.stdout.write(`${new Date().toISOString()} ${action} requested by ${ip}\n`);
    // Answer before running it: shutdown kills the process mid-response.
    json(res, 200, { ok: true, action });
    setTimeout(() => {
      run(platform[action]).catch((err) => {
        process.stderr.write(`${action} failed: ${err.message}\n`);
      });
    }, 150);
    return;
  }

  json(res, 404, { error: `unknown endpoint ${req.method} ${url.pathname}` });
});

server.listen(PORT, HOST, () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${PORT}`);
  process.stdout.write(`pc-agent ${VERSION} listening on ${HOST}:${PORT} (${process.platform})\n`);
  for (const address of addresses) process.stdout.write(`  agentUrl: ${address}\n`);
  if (ALLOW.length > 0) process.stdout.write(`  allowlist: ${ALLOW.join(', ')}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
