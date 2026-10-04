import os from 'node:os';
import path from 'node:path';
import { describeValidationError, loadConfig } from './config.js';
import { Hub } from './hub.js';
import { createLogger, logBus } from './logger.js';
import { RealTransport } from './net/real.js';
import { SimTransport } from './net/sim/index.js';
import type { Transport } from './net/transport.js';
import { findRootDir, readVersion } from './paths.js';
import { Store } from './store.js';
import { startServer } from './http/server.js';

const log = createLogger('main');

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) out.push(address.address);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const rootDir = findRootDir();
  const version = readVersion(rootDir);

  let loaded;
  try {
    loaded = loadConfig(rootDir);
  } catch (err) {
    process.stderr.write(`\nConfiguration is invalid:\n${describeValidationError(err)}\n\n`);
    process.exitCode = 1;
    return;
  }
  const { config, source, usedFallback } = loaded;

  logBus.setLevel(config.logLevel);
  log.info(`pi-smart-home-hub ${version} on node ${process.version} (${process.platform}/${process.arch})`);
  if (source) log.info(`config: ${path.relative(rootDir, source)}`);
  if (usedFallback) {
    log.warn('no config/hub.yaml found, running the bundled demo profile with simulated devices');
    log.warn('copy config/hub.example.yaml to config/hub.yaml and edit it to control real hardware');
  }

  const dataDir = path.isAbsolute(config.dataDir) ? config.dataDir : path.join(rootDir, config.dataDir);
  const store = new Store(path.join(dataDir, 'state.json'));
  await store.load();

  const transport: Transport = config.demo ? new SimTransport(undefined, 15) : new RealTransport();
  if (config.demo) log.warn('DEMO MODE: devices are simulated in-process, nothing touches the network');

  const hub = new Hub(config, transport, store);
  await hub.start();

  const running = await startServer({
    hub,
    transport,
    rootDir,
    version,
    token: config.auth.token,
    host: config.server.host,
    port: config.server.port,
  });

  const urls = [running.url, ...lanAddresses().map((ip) => `http://${ip}:${running.port}`)];
  log.info(`dashboard ready: ${[...new Set(urls)].join('  ')}`);
  if (config.auth.token) log.info('API token auth is enabled');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref?.();
    await running.close().catch(() => {});
    await hub.stop().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled promise rejection', reason));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', err);
    void shutdown('uncaughtException');
  });
}

void main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
