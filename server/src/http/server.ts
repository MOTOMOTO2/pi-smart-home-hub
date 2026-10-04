import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Hub, HubEvent } from '../hub.js';
import { createLogger, logBus, type LogRecord } from '../logger.js';
import type { Transport } from '../net/transport.js';
import { createApiRouter } from './routes/api.js';

const log = createLogger('http');

export interface ServerOptions {
  hub: Hub;
  transport: Transport;
  rootDir: string;
  version: string;
  token?: string | undefined;
}

export interface RunningServer {
  server: http.Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Optional shared-secret auth. A hub on a trusted home LAN usually runs open,
 * but if you forward a port or share wifi with guests, set `auth.token` and
 * every API/WS call needs it.
 */
function authMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const provided = bearer ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
    if (provided === token) {
      next();
      return;
    }
    res.status(401).json({ error: 'missing or invalid token' });
  };
}

export function createApp(options: ServerOptions): express.Express {
  const { hub, transport, rootDir, version, token } = options;
  const app = express();

  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  const api = express.Router();
  if (token) api.use(authMiddleware(token));
  api.use(createApiRouter(hub, transport, version));
  app.use('/api', api);

  // The built dashboard. Absent until `npm run build:web` has run, so the
  // fallback explains that rather than 404ing mysteriously.
  const webDist = path.join(rootDir, 'web', 'dist');
  const indexHtml = path.join(webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (res, filePath) => {
          // Vite emits content-hashed asset names, so they can cache hard.
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('cache-control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: `no such endpoint: ${req.path}` });
      return;
    }
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
      return;
    }
    res
      .status(503)
      .type('text/plain')
      .send(
        'The dashboard has not been built yet.\n\nRun:  npm run build\n\nThe JSON API is available at /api/state.\n',
      );
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('unhandled error in request', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  return app;
}

/**
 * Pushes live state to the dashboard so the UI never has to poll. Clients get
 * a full snapshot on connect and deltas after that.
 */
function attachWebsocket(server: http.Server, hub: Hub, token?: string): () => void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (token && url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws: WebSocket, type: string, payload: unknown): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, payload }));
  };

  const broadcast = (type: string, payload: unknown): void => {
    const message = JSON.stringify({ type, payload });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  };

  const onDeviceState = (payload: unknown): void => broadcast('device.state', payload);
  const onEvent = (event: HubEvent): void => broadcast('event', event);
  const onLog = (record: LogRecord): void => {
    if (record.level === 'debug') return; // too chatty for the UI
    broadcast('log', record);
  };

  hub.on('device.state', onDeviceState);
  hub.on('event', onEvent);
  logBus.on('log', onLog);

  wss.on('connection', (ws) => {
    send(ws, 'hello', {
      devices: hub.listDevices(),
      scenes: hub.scenes(),
      automations: hub.automations(),
      events: hub.events(30),
      demo: hub.config.demo,
    });
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === 'ping') send(ws, 'pong', { at: Date.now() });
      } catch {
        // Ignore malformed frames; the dashboard only ever sends pings.
      }
    });
    ws.on('error', (err) => log.debug('websocket error', err));
  });

  // Keep-alive so a sleeping tablet does not leave a half-open socket behind.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  return () => {
    clearInterval(heartbeat);
    hub.off('device.state', onDeviceState);
    hub.off('event', onEvent);
    logBus.off('log', onLog);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}

export async function startServer(
  options: ServerOptions & { host: string; port: number },
): Promise<RunningServer> {
  const app = createApp(options);
  const server = http.createServer(app);
  const detachWs = attachWebsocket(server, options.hub, options.token);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const displayHost = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host;

  return {
    server,
    port,
    url: `http://${displayHost}:${port}`,
    close: async () => {
      detachWs();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
