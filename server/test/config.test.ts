import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { expandEnv, loadConfig, parseConfig } from '../src/config.js';

const minimal = {
  devices: [{ id: 'lights', name: 'Lights', type: 'nanoleaf', host: '10.0.0.41' }],
};

describe('config parsing', () => {
  it('applies defaults for everything that is omitted', () => {
    const config = parseConfig(minimal, {});
    assert.equal(config.server.port, 8080);
    assert.equal(config.server.host, '0.0.0.0');
    assert.equal(config.demo, false);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.dataDir, 'data');
    const device = config.devices[0];
    assert.ok(device && device.type === 'nanoleaf');
    assert.equal(device.port, 16021, 'nanoleaf default port');
    assert.equal(device.enabled, true);
  });

  it('discriminates device types and keeps their own fields', () => {
    const config = parseConfig(
      {
        devices: [
          { id: 'tv', name: 'TV', type: 'rokutv', host: '10.0.0.52' },
          { id: 'pc', name: 'PC', type: 'pc', mac: 'a4:bb:6d:11:22:33' },
          { id: 'door', name: 'Door', type: 'ring' },
        ],
      },
      {},
    );
    const [tv, pc, door] = config.devices;
    assert.ok(tv?.type === 'rokutv' && tv.port === 8060);
    assert.ok(pc?.type === 'pc' && pc.probePort === 3389);
    assert.ok(door?.type === 'ring' && door.pollSeconds === 45, 'ring gets a slow default poll');
  });

  it('rejects an unknown device type', () => {
    assert.throws(() => parseConfig({ devices: [{ id: 'x', name: 'X', type: 'toaster' }] }, {}));
  });

  it('rejects duplicate device and scene ids', () => {
    assert.throws(
      () =>
        parseConfig(
          {
            devices: [
              { id: 'a', name: 'A', type: 'nanoleaf', host: 'h' },
              { id: 'a', name: 'B', type: 'nanoleaf', host: 'h' },
            ],
          },
          {},
        ),
      /duplicate device id "a"/,
    );
    assert.throws(
      () =>
        parseConfig(
          {
            ...minimal,
            scenes: [
              { id: 's', name: 'S', actions: [{ device: 'lights', command: 'toggle' }] },
              { id: 's', name: 'T', actions: [{ device: 'lights', command: 'toggle' }] },
            ],
          },
          {},
        ),
      /duplicate scene id "s"/,
    );
  });

  it('catches references to devices and scenes that do not exist', () => {
    assert.throws(
      () => parseConfig({ ...minimal, scenes: [{ id: 's', name: 'S', actions: [{ device: 'ghost', command: 'on' }] }] }, {}),
      /scene "s" references unknown device "ghost"/,
    );
    assert.throws(
      () => parseConfig({ ...minimal, automations: [{ id: 'a', name: 'A', when: { event: 'x' }, scene: 'ghost' }] }, {}),
      /references unknown scene "ghost"/,
    );
    assert.throws(
      () => parseConfig({ ...minimal, automations: [{ id: 'a', name: 'A', when: { event: 'x' } }] }, {}),
      /needs either "scene" or "run"/,
    );
  });

  it('requires a scene action to do something', () => {
    assert.throws(() => parseConfig({ ...minimal, scenes: [{ id: 's', name: 'S', actions: [{}] }] }, {}));
  });

  it('accepts all three automation trigger shapes', () => {
    const config = parseConfig(
      {
        ...minimal,
        automations: [
          { id: 'a', name: 'A', when: { event: 'ring.ding' }, run: [{ device: 'lights', command: 'toggle' }] },
          { id: 'b', name: 'B', when: { schedule: '30 7 * * 1-5' }, run: [{ device: 'lights', command: 'toggle' }] },
          {
            id: 'c',
            name: 'C',
            when: { deviceState: { device: 'lights', path: 'on', equals: false } },
            run: [{ device: 'lights', command: 'toggle' }],
          },
        ],
      },
      {},
    );
    assert.equal(config.automations.length, 3);
    assert.equal(config.automations[0]?.cooldownSeconds, 0);
  });

  it('validates the format of a between window', () => {
    assert.throws(() =>
      parseConfig(
        {
          ...minimal,
          automations: [
            {
              id: 'a',
              name: 'A',
              when: { event: 'x' },
              between: { from: '10pm', to: '06:00' },
              run: [{ device: 'lights', command: 'toggle' }],
            },
          ],
        },
        {},
      ),
    );
  });
});

describe('environment substitution', () => {
  it('replaces ${VAR} anywhere in the tree', () => {
    const result = expandEnv({ a: '${FOO}', b: ['x', '${FOO}'], c: { d: 'pre-${FOO}-post' } }, { FOO: 'bar' });
    assert.deepEqual(result, { a: 'bar', b: ['x', 'bar'], c: { d: 'pre-bar-post' } });
  });

  it('supports ${VAR:-default} and blanks unset variables', () => {
    assert.equal(expandEnv('${NOPE:-fallback}', {}), 'fallback');
    assert.equal(expandEnv('${NOPE}', {}), '');
    assert.equal(expandEnv('${EMPTY:-used}', { EMPTY: '' }), 'used', 'empty counts as unset');
  });

  it('leaves non-strings alone', () => {
    assert.deepEqual(expandEnv({ n: 5, b: true, z: null }, {}), { n: 5, b: true, z: null });
  });

  it('feeds secrets into device config without them appearing in the file', () => {
    const config = parseConfig(
      { devices: [{ id: 'thermo', name: 'T', type: 'ecobee', apiKey: '${ECOBEE_API_KEY}' }] },
      { ECOBEE_API_KEY: 'secret-key' },
    );
    const device = config.devices[0];
    assert.ok(device?.type === 'ecobee');
    assert.equal(device.apiKey, 'secret-key');
  });
});

describe('environment overrides', () => {
  it('lets HUB_* variables win over the file', () => {
    const config = parseConfig(minimal, {
      HUB_PORT: '9999',
      HUB_HOST: '127.0.0.1',
      HUB_TOKEN: 'shh',
      HUB_DEMO: 'true',
      HUB_LOG_LEVEL: 'debug',
      HUB_DATA_DIR: '/var/lib/hub',
    });
    assert.equal(config.server.port, 9999);
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.auth.token, 'shh');
    assert.equal(config.demo, true);
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.dataDir, '/var/lib/hub');
  });

  it('ignores junk values rather than crashing at boot', () => {
    const config = parseConfig(minimal, { HUB_PORT: 'not-a-port', HUB_LOG_LEVEL: 'loud' });
    assert.equal(config.server.port, 8080);
    assert.equal(config.logLevel, 'info');
  });
});

describe('config file loading', () => {
  it('prefers hub.yaml and falls back to the bundled demo profile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cfg-'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config', 'demo.yaml'), yaml.dump({ demo: true, ...minimal }));

    const fallback = loadConfig(root, {});
    assert.equal(fallback.usedFallback, true);
    assert.equal(fallback.config.demo, true);

    fs.writeFileSync(path.join(root, 'config', 'hub.yaml'), yaml.dump({ server: { port: 1234 }, ...minimal }));
    const real = loadConfig(root, {});
    assert.equal(real.usedFallback, false);
    assert.equal(real.config.server.port, 1234);
    assert.equal(real.config.demo, false);
  });

  it('honours HUB_CONFIG for an explicit path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cfg-'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config', 'other.yaml'), yaml.dump({ server: { port: 4321 }, ...minimal }));
    const loaded = loadConfig(root, { HUB_CONFIG: path.join('config', 'other.yaml') });
    assert.equal(loaded.config.server.port, 4321);
  });

  it('returns defaults when there is no config at all', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cfg-'));
    const loaded = loadConfig(root, {});
    assert.equal(loaded.source, null);
    assert.deepEqual(loaded.config.devices, []);
  });
});
