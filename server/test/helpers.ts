import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, logBus } from '../src/logger.js';
import { SimTransport, SimWorld } from '../src/net/sim/index.js';
import { Store } from '../src/store.js';
import type { DeviceContext } from '../src/devices/types.js';

// Tests assert on behaviour, not on log output.
logBus.setLevel('error');

export function tempStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
  return new Store(path.join(dir, 'state.json'), 5);
}

export interface TestContext {
  ctx: DeviceContext;
  transport: SimTransport;
  world: SimWorld;
  store: Store;
  events: Array<{ event: string; payload: Record<string, unknown> }>;
}

export function testContext(id = 'test-device', name = 'Test Device'): TestContext {
  const world = new SimWorld();
  const transport = new SimTransport(world);
  const store = tempStore();
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const ctx: DeviceContext = {
    id,
    name,
    room: 'Lab',
    transport,
    store,
    logger: createLogger(`test:${id}`),
    emit: (event, payload) => events.push({ event, payload }),
  };
  return { ctx, transport, world, store, events };
}
