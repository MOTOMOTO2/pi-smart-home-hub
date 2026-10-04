import { useEffect, useState } from 'react';
import { useHub } from './lib/useHub';
import type { Device } from './lib/types';
import { Icon, type IconName } from './components/Icon';
import { DevicePanel } from './components/DevicePanel';
import { Dashboard } from './views/Dashboard';
import { ScenesView } from './views/ScenesView';
import { ActivityView } from './views/ActivityView';
import { SettingsView } from './views/SettingsView';

type Tab = 'home' | 'scenes' | 'activity' | 'settings';

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'home', label: 'Home', icon: 'grid' },
  { id: 'scenes', label: 'Scenes', icon: 'wand' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function App(): JSX.Element {
  const store = useHub();
  const [tab, setTab] = useState<Tab>('home');
  const [openDeviceId, setOpenDeviceId] = useState<string | null>(null);

  // Hold the id, not the object, so the open panel re-renders from live state.
  const openDevice: Device | null =
    store.devices.find((device) => device.descriptor.id === openDeviceId) ?? null;

  useEffect(() => {
    if (openDeviceId && !openDevice) setOpenDeviceId(null);
  }, [openDeviceId, openDevice]);

  const unreachable = store.devices.filter((d) => !d.state.online && !d.state.needsSetup).length;
  const needsSetup = store.devices.filter((d) => d.state.needsSetup).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Icon name="home" size={22} />
          <span>Home Hub</span>
          {store.hub?.demo ? <span className="badge" data-kind="demo">demo</span> : null}
        </div>

        <div className="topbar-status">
          {needsSetup > 0 ? (
            <button type="button" className="badge" data-kind="warn" onClick={() => setTab('home')}>
              {needsSetup} need{needsSetup === 1 ? 's' : ''} setup
            </button>
          ) : null}
          {unreachable > 0 ? (
            <span className="badge" data-kind="error">
              {unreachable} offline
            </span>
          ) : null}
          <span className="conn" data-state={store.connection} title={`Connection: ${store.connection}`}>
            <span className="conn-dot" />
            {store.connection === 'live' ? 'live' : store.connection}
          </span>
        </div>
      </header>

      {store.connection === 'unauthorized' ? (
        <div className="app-banner">
          This hub requires an API token. Add it under <strong>Settings &rarr; API token</strong>.
        </div>
      ) : null}

      <main className="content">
        {tab === 'home' ? (
          <Dashboard store={store} onOpenDevice={(device) => setOpenDeviceId(device.descriptor.id)} />
        ) : null}
        {tab === 'scenes' ? <ScenesView store={store} /> : null}
        {tab === 'activity' ? <ActivityView store={store} /> : null}
        {tab === 'settings' ? <SettingsView store={store} /> : null}
      </main>

      <nav className="tabbar">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="tab"
            data-active={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {openDevice ? (
        <DevicePanel
          device={openDevice}
          run={store.run}
          notify={store.notify}
          onClose={() => setOpenDeviceId(null)}
        />
      ) : null}

      <div className="toasts" role="status" aria-live="polite">
        {store.toasts.map((toast) => (
          <button key={toast.id} type="button" className="toast" data-kind={toast.kind} onClick={() => store.dismiss(toast.id)}>
            <Icon name={toast.kind === 'ok' ? 'star' : 'info'} size={16} />
            {toast.message}
          </button>
        ))}
      </div>
    </div>
  );
}
