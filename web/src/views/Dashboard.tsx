import { api } from '../lib/api';
import { groupByRoom } from '../lib/state';
import type { HubStore } from '../lib/useHub';
import type { Device, Scene } from '../lib/types';
import { DeviceTile } from '../components/DeviceTile';
import { Icon } from '../components/Icon';
import { Empty } from '../components/controls';

export function Dashboard({
  store,
  onOpenDevice,
}: {
  store: HubStore;
  onOpenDevice: (device: Device) => void;
}): JSX.Element {
  const favorites = store.scenes.filter((scene) => scene.favorite);
  const rooms = groupByRoom(store.devices);

  const runScene = async (scene: Scene): Promise<void> => {
    try {
      const result = await api.runScene(scene.id);
      if (result.failed.length > 0) {
        store.notify('error', `${scene.name}: ${result.failed.map((f) => `${f.device} (${f.error})`).join(', ')}`);
      } else {
        store.notify('ok', `${scene.name} · ${result.ran} action${result.ran === 1 ? '' : 's'}`);
      }
    } catch (err) {
      store.notify('error', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="dashboard">
      {favorites.length > 0 ? (
        <section className="scene-bar">
          {favorites.map((scene) => (
            <button key={scene.id} type="button" className="scene-btn" onClick={() => void runScene(scene)}>
              <Icon name={scene.icon} size={20} />
              <span>{scene.name}</span>
            </button>
          ))}
        </section>
      ) : null}

      {store.devices.length === 0 ? (
        <Empty icon="grid">
          No devices configured yet. Copy <code>config/hub.example.yaml</code> to <code>config/hub.yaml</code>, add your
          devices and restart the hub.
        </Empty>
      ) : (
        rooms.map(([room, devices]) => (
          <section className="room" key={room}>
            <h2 className="room-name">{room}</h2>
            <div className="tile-grid">
              {devices.map((device) => (
                <DeviceTile
                  key={device.descriptor.id}
                  device={device}
                  onOpen={() => onOpenDevice(device)}
                  onToggle={(next) => void store.run(device.descriptor.id, 'power', { on: next })}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
