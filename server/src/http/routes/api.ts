import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { sceneSchema } from '../../config.js';
import { discoverDevices } from '../../discovery.js';
import { EcobeeAdapter } from '../../devices/ecobee.js';
import { NanoleafAdapter } from '../../devices/nanoleaf.js';
import { RingAdapter } from '../../devices/ring.js';
import type { Hub } from '../../hub.js';
import { LOG_LEVELS, logBus, type LogLevel } from '../../logger.js';
import { SimTransport } from '../../net/sim/index.js';
import type { Transport } from '../../net/transport.js';
import { statusForError } from '../../errors.js';
import { errorMessage } from '../../util/async.js';
import { XboxAdapter } from '../../devices/xbox.js';

const commandSchema = z.object({
  command: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

/**
 * Express types model `params` as an index signature, so under
 * noUncheckedIndexedAccess a route param reads as possibly-undefined even
 * though the router guarantees it. This narrows it in one place.
 */
function param(req: Request, name = 'id'): string {
  const value = req.params[name];
  if (value === undefined) throw new Error(`missing route parameter "${name}"`);
  return value;
}

/** Wrap an async handler so a rejection becomes a 400/500 instead of a hang. */
function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err: unknown) => {
      if (res.headersSent) return;
      res.status(statusForError(err)).json({ error: errorMessage(err) });
    });
  };
}

export function createApiRouter(hub: Hub, transport: Transport, version: string): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const devices = hub.listDevices();
    res.json({
      ok: true,
      version,
      demo: hub.config.demo,
      uptimeSeconds: Math.round((Date.now() - hub.startedAt) / 1000),
      devices: {
        total: devices.length,
        online: devices.filter((d) => d.state.online).length,
        needsSetup: devices.filter((d) => d.state['needsSetup'] === true).length,
      },
    });
  });

  router.get('/state', (_req, res) => {
    res.json({
      hub: {
        version,
        demo: hub.config.demo,
        startedAt: hub.startedAt,
        logLevel: hub.config.logLevel,
      },
      devices: hub.listDevices(),
      scenes: hub.scenes(),
      automations: hub.automations(),
      events: hub.events(30),
    });
  });

  // -- devices --------------------------------------------------------------

  router.get('/devices', (_req, res) => {
    res.json(hub.listDevices());
  });

  router.get(
    '/devices/:id',
    wrap(async (req, res) => {
      res.json(hub.getDevice(param(req)));
    }),
  );

  router.post(
    '/devices/:id/refresh',
    wrap(async (req, res) => {
      const state = await hub.refreshDevice(param(req));
      res.json({ state });
    }),
  );

  router.post(
    '/devices/:id/command',
    wrap(async (req, res) => {
      const parsed = commandSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const result = await hub.execute(param(req), parsed.data.command, parsed.data.params);
      res.json(result);
    }),
  );

  router.get(
    '/devices/:id/snapshot',
    wrap(async (req, res) => {
      const { contentType, body } = await hub.snapshot(param(req));
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'no-store');
      res.send(body);
    }),
  );

  // -- pairing --------------------------------------------------------------

  const ringStart = z.object({ username: z.string().min(1), password: z.string().min(1) });
  const ringVerify = z.object({ code: z.string().min(4) });

  router.post(
    '/devices/:id/pair',
    wrap(async (req, res) => {
      const adapter = hub.adapter(param(req));
      const step = typeof req.body?.step === 'string' ? req.body.step : 'start';

      if (adapter instanceof NanoleafAdapter) {
        await adapter.pair();
        await hub.refreshDevice(adapter.id).catch(() => {});
        res.json({ paired: true, message: 'Nanoleaf paired' });
        return;
      }

      if (adapter instanceof EcobeeAdapter) {
        if (step === 'start') {
          const { pin, expiresInSeconds } = await adapter.pairStart();
          res.json({
            paired: false,
            pin,
            expiresInSeconds,
            message: `Add PIN ${pin} at ecobee.com under My Apps, then press Complete.`,
          });
          return;
        }
        await adapter.pairComplete();
        await hub.refreshDevice(adapter.id).catch(() => {});
        res.json({ paired: true, message: 'Ecobee paired' });
        return;
      }
      
      if (adapter instanceof XboxAdapter) {
        if (step === 'start') {
          const { pin, expiresInSeconds } = await adapter.pairStart();
          res.json({
            paired: false,
            pin,
            expiresInSeconds,
            message: `Enter code ${pin} at https://www.microsoft.com/link, sign in with your Xbox account, then run pair again with step=complete.`,
          });
          return;
        }
        await adapter.pairComplete();
        await hub.refreshDevice(adapter.id).catch(() => {});
        res.json({ paired: true, message: 'Signed in to Xbox Live' });
        return;
      }

      if (adapter instanceof RingAdapter) {
        if (step === 'start') {
          const parsed = ringStart.safeParse(req.body);
          if (!parsed.success) {
            res.status(400).json({ error: 'username and password are required' });
            return;
          }
          const result = await adapter.pairStart(parsed.data.username, parsed.data.password);
          if (result.paired) await hub.refreshDevice(adapter.id).catch(() => {});
          res.json({ paired: result.paired, needsCode: result.needsCode, message: result.hint });
          return;
        }
        const parsed = ringVerify.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'a verification code is required' });
          return;
        }
        await adapter.pairVerify(parsed.data.code);
        await hub.refreshDevice(adapter.id).catch(() => {});
        res.json({ paired: true, message: 'Ring paired' });
        return;
      }

      res.status(400).json({ error: `device "${param(req)}" does not need pairing` });
    }),
  );

  // -- scenes ---------------------------------------------------------------

  router.get('/scenes', (_req, res) => {
    res.json(hub.scenes());
  });

  router.post(
    '/scenes',
    wrap(async (req, res) => {
      const parsed = sceneSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        return;
      }
      const scene = hub.saveScene(parsed.data);
      res.status(201).json(scene);
    }),
  );

  router.delete(
    '/scenes/:id',
    wrap(async (req, res) => {
      hub.deleteScene(param(req));
      res.json({ ok: true });
    }),
  );

  router.post(
    '/scenes/:id/run',
    wrap(async (req, res) => {
      const result = await hub.runScene(param(req));
      res.json({ ok: result.failed.length === 0, ...result });
    }),
  );

  // -- automations ----------------------------------------------------------

  router.get('/automations', (_req, res) => {
    res.json(hub.automations());
  });

  router.post(
    '/automations/:id/enabled',
    wrap(async (req, res) => {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'body must be {"enabled": true|false}' });
        return;
      }
      hub.setAutomationEnabled(param(req), enabled);
      res.json({ ok: true, enabled });
    }),
  );

  // -- system ---------------------------------------------------------------

  router.get('/events', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json(hub.events(limit));
  });

  router.get('/logs', (req, res) => {
    const level = String(req.query.level ?? 'debug');
    const minLevel: LogLevel = (LOG_LEVELS as readonly string[]).includes(level) ? (level as LogLevel) : 'debug';
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
    res.json(logBus.recent(limit, minLevel));
  });

  router.post(
    '/discover',
    wrap(async (_req, res) => {
      const found = await discoverDevices(transport, hub.config.network.broadcastAddress);
      res.json(found);
    }),
  );

  router.post(
    '/refresh',
    wrap(async (_req, res) => {
      await hub.refreshAll();
      res.json({ ok: true, devices: hub.listDevices() });
    }),
  );

  /**
   * Demo-only hook: makes the simulated doorbell ring so the event feed and
   * any doorbell automations can be exercised without a visitor.
   */
  router.post(
    '/demo/doorbell',
    wrap(async (req, res) => {
      if (!(transport instanceof SimTransport)) {
        res.status(400).json({ error: 'the demo doorbell is only available in demo mode' });
        return;
      }
      const kind = req.body?.kind === 'motion' ? 'motion' : 'ding';
      transport.world.pushRingEvent(kind);
      const ringDevice = hub.listDevices().find((d) => d.descriptor.type === 'ring');
      if (ringDevice) await hub.refreshDevice(ringDevice.descriptor.id).catch(() => {});
      res.json({ ok: true, kind });
    }),
  );

  return router;
}
