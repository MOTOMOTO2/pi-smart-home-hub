import { useState } from 'react';
import { api, getToken, setToken } from '../lib/api';
import type { HubStore } from '../lib/useHub';
import type { Discovered } from '../lib/types';
import { Icon } from '../components/Icon';
import { Button, Empty, Field, Toggle, relativeTime } from '../components/controls';

export function SettingsView({ store }: { store: HubStore }): JSX.Element {
  const [found, setFound] = useState<Discovered[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [token, setTokenValue] = useState(getToken() ?? '');

  const scan = async (): Promise<void> => {
    setScanning(true);
    try {
      const results = await api.discover();
      setFound(results);
      store.notify('ok', `Found ${results.length} device${results.length === 1 ? '' : 's'}`);
    } catch (err) {
      store.notify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const toggleAutomation = async (id: string, enabled: boolean): Promise<void> => {
    try {
      await api.setAutomation(id, enabled);
      store.setAutomations(await api.automations());
    } catch (err) {
      store.notify('error', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="settings-view">
      <section className="card">
        <h3>Hub</h3>
        <dl className="detail-grid">
          <div>
            <dt>Version</dt>
            <dd>{store.hub?.version ?? '-'}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{store.hub?.demo ? 'demo (simulated devices)' : 'live'}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{store.hub ? relativeTime(store.hub.startedAt) : '-'}</dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>{store.connection}</dd>
          </div>
          <div>
            <dt>Devices</dt>
            <dd>
              {store.devices.filter((d) => d.state.online).length} of {store.devices.length} online
            </dd>
          </div>
        </dl>
        <div className="button-row">
          <Button
            icon="refresh"
            onClick={async () => {
              try {
                await api.refreshAll();
                await store.reload();
                store.notify('ok', 'Re-polled every device');
              } catch (err) {
                store.notify('error', err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Re-poll all devices
          </Button>
        </div>
      </section>

      <section className="card">
        <h3>Automations</h3>
        {store.automations.length === 0 ? (
          <p className="muted">
            None configured. Add an <code>automations:</code> block to <code>config/hub.yaml</code>.
          </p>
        ) : (
          <ul className="automation-list">
            {store.automations.map((automation) => (
              <li key={automation.id}>
                <div>
                  <strong>{automation.name}</strong>
                  <span className="muted">
                    {automation.trigger} · last run {relativeTime(automation.lastRunAt)}
                  </span>
                </div>
                <Toggle
                  checked={automation.enabled}
                  label={`Enable ${automation.name}`}
                  onChange={(next) => void toggleAutomation(automation.id, next)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3>Find devices on the network</h3>
        <p className="muted">
          Scans for Nanoleaf controllers and Roku TVs over SSDP, and for an awake Xbox over the SmartGlass broadcast.
          Ecobee and Ring are cloud accounts, so they are added in config and paired from their tile.
        </p>
        <div className="button-row">
          <Button icon="search" variant="primary" busy={scanning} onClick={() => void scan()}>
            Scan the LAN
          </Button>
        </div>
        {found ? (
          found.length === 0 ? (
            <Empty icon="search">
              Nothing answered. Nanoleaf and Roku TVs must be powered on, and the Xbox must be awake.
            </Empty>
          ) : (
            <div className="discovered">
              {found.map((device, index) => (
                <div className="discovered-item" key={`${device.type}-${index}`}>
                  <header>
                    <Icon name={device.type === 'rokutv' ? 'tv' : device.type} size={18} />
                    <strong>{device.name}</strong>
                    <span className="muted">{device.host}</span>
                  </header>
                  <p className="muted">Paste this under devices: in config/hub.yaml, then restart the hub.</p>
                  <pre>{toYaml(device.suggestedConfig)}</pre>
                </div>
              ))}
            </div>
          )
        ) : null}
      </section>

      <section className="card">
        <h3>API token</h3>
        <p className="muted">
          Only needed when <code>auth.token</code> is set in the hub config. Stored in this browser only.
        </p>
        <Field label="Token">
          <input
            type="password"
            value={token}
            placeholder="leave empty if auth is disabled"
            onChange={(event) => setTokenValue(event.target.value)}
          />
        </Field>
        <div className="button-row">
          <Button
            variant="primary"
            onClick={() => {
              setToken(token.trim() || null);
              window.location.reload();
            }}
          >
            Save and reconnect
          </Button>
        </div>
      </section>
    </div>
  );
}

/** Just enough YAML for a flat suggested-config block. */
function toYaml(config: Record<string, unknown>): string {
  const lines = Object.entries(config).map(([key, value], index) => {
    const rendered = typeof value === 'string' && /[:#]/.test(value) ? JSON.stringify(value) : String(value);
    return `${index === 0 ? '  - ' : '    '}${key}: ${rendered}`;
  });
  return lines.join('\n');
}
