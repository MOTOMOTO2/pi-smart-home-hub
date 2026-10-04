import { useState } from 'react';
import { api } from '../lib/api';
import type { HubStore } from '../lib/useHub';
import type { Device, ParamSpec, Scene, SceneAction } from '../lib/types';
import { Icon } from '../components/Icon';
import { Button, Empty, Field, IconButton, Modal } from '../components/controls';

export function ScenesView({ store }: { store: HubStore }): JSX.Element {
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    store.setScenes(await api.scenes());
  };

  const run = async (scene: Scene): Promise<void> => {
    setBusy(scene.id);
    try {
      const result = await api.runScene(scene.id);
      if (result.failed.length > 0) {
        store.notify('error', `${scene.name}: ${result.failed.map((f) => `${f.device} (${f.error})`).join(', ')}`);
      } else {
        store.notify('ok', `${scene.name} · ${result.ran} action${result.ran === 1 ? '' : 's'}`);
      }
    } catch (err) {
      store.notify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (scene: Scene): Promise<void> => {
    try {
      await api.deleteScene(scene.id);
      await reload();
      store.notify('ok', `Deleted ${scene.name}`);
    } catch (err) {
      store.notify('error', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="scenes-view">
      <header className="view-head">
        <p className="muted">
          Scenes run a list of device commands in order. Ones defined in <code>config/hub.yaml</code> are read-only
          here; scenes you create below are stored by the hub.
        </p>
        <Button icon="plus" variant="primary" onClick={() => setBuilding(true)}>
          New scene
        </Button>
      </header>

      {store.scenes.length === 0 ? (
        <Empty icon="wand">No scenes yet. Create one, or add a `scenes:` block to your config.</Empty>
      ) : (
        <div className="scene-list">
          {store.scenes.map((scene) => (
            <article className="scene-card" key={scene.id}>
              <div className="scene-head">
                <span className="scene-icon">
                  <Icon name={scene.icon} size={20} />
                </span>
                <div>
                  <h3>{scene.name}</h3>
                  <span className="muted">
                    {scene.actions.length} action{scene.actions.length === 1 ? '' : 's'} ·{' '}
                    {scene.source === 'config' ? 'from config' : 'created here'}
                  </span>
                </div>
                <div className="scene-card-actions">
                  <Button variant="primary" busy={busy === scene.id} onClick={() => void run(scene)}>
                    Run
                  </Button>
                  {scene.source === 'user' ? (
                    <IconButton icon="close" label={`Delete ${scene.name}`} onClick={() => void remove(scene)} />
                  ) : null}
                </div>
              </div>
              <ol className="scene-steps">
                {scene.actions.map((action, index) => (
                  <li key={index}>{describeAction(action, store.devices)}</li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      )}

      {building ? (
        <SceneBuilder
          devices={store.devices}
          onClose={() => setBuilding(false)}
          onSaved={async (name) => {
            await reload();
            store.notify('ok', `Created ${name}`);
            setBuilding(false);
          }}
          notify={store.notify}
        />
      ) : null}
    </div>
  );
}

function describeAction(action: SceneAction, devices: Device[]): string {
  if (action.delayMs !== undefined && !action.command) return `wait ${action.delayMs}ms`;
  const name = devices.find((d) => d.descriptor.id === action.device)?.descriptor.name ?? action.device ?? '?';
  const params = action.params && Object.keys(action.params).length > 0 ? ` (${formatParams(action.params)})` : '';
  const wait = action.delayMs ? `, then wait ${action.delayMs}ms` : '';
  return `${name} · ${action.command}${params}${wait}`;
}

function formatParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}

interface DraftAction {
  device: string;
  command: string;
  params: Record<string, string>;
  delayMs: string;
}

const ICONS = ['wand', 'film', 'gamepad', 'sun', 'moon', 'bell', 'power', 'star'];

/**
 * Builds a scene from the command metadata the adapters publish, so the form
 * offers exactly the commands and parameters each device actually supports.
 */
function SceneBuilder({
  devices,
  onClose,
  onSaved,
  notify,
}: {
  devices: Device[];
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
  notify: (kind: 'ok' | 'error', message: string) => void;
}): JSX.Element {
  const usable = devices.filter((d) => d.descriptor.commands.length > 0);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('wand');
  const [favorite, setFavorite] = useState(true);
  const [actions, setActions] = useState<DraftAction[]>([
    { device: usable[0]?.descriptor.id ?? '', command: '', params: {}, delayMs: '' },
  ]);
  const [busy, setBusy] = useState(false);

  const update = (index: number, patch: Partial<DraftAction>): void => {
    setActions((current) => current.map((action, i) => (i === index ? { ...action, ...patch } : action)));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const body = {
        id: slugify(name),
        name: name.trim(),
        icon,
        favorite,
        actions: actions
          .filter((action) => action.device && action.command)
          .map((action) => {
            const spec = commandSpec(devices, action.device, action.command);
            const params: Record<string, unknown> = {};
            for (const [key, raw] of Object.entries(action.params)) {
              if (raw === '') continue;
              const param = spec?.params?.find((p) => p.name === key);
              params[key] = coerce(raw, param);
            }
            return {
              device: action.device,
              command: action.command,
              params,
              ...(action.delayMs ? { delayMs: Number(action.delayMs) } : {}),
            };
          }),
      };
      if (body.actions.length === 0) throw new Error('Add at least one action with a command');
      await fetchCreate(body);
      await onSaved(body.name);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New scene"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>
            Save scene
          </Button>
        </>
      }
    >
      <Field label="Name">
        <input value={name} placeholder="Movie night" onChange={(event) => setName(event.target.value)} />
      </Field>

      <Field label="Icon">
        <div className="chips">
          {ICONS.map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              data-active={icon === option ? 'true' : 'false'}
              onClick={() => setIcon(option)}
            >
              <Icon name={option} size={16} />
            </button>
          ))}
        </div>
      </Field>

      <label className="checkbox">
        <input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} />
        Show on the dashboard
      </label>

      <h4 className="builder-title">Actions</h4>
      {actions.map((action, index) => {
        const device = devices.find((d) => d.descriptor.id === action.device);
        const spec = device?.descriptor.commands.find((c) => c.name === action.command);
        return (
          <div className="builder-row" key={index}>
            <select value={action.device} onChange={(event) => update(index, { device: event.target.value, command: '', params: {} })}>
              {usable.map((option) => (
                <option key={option.descriptor.id} value={option.descriptor.id}>
                  {option.descriptor.name}
                </option>
              ))}
            </select>

            <select value={action.command} onChange={(event) => update(index, { command: event.target.value, params: {} })}>
              <option value="">choose a command</option>
              {device?.descriptor.commands.map((command) => (
                <option key={command.name} value={command.name}>
                  {command.label}
                </option>
              ))}
            </select>

            {spec?.params?.map((param) => (
              <ParamInput
                key={param.name}
                param={param}
                value={action.params[param.name] ?? ''}
                onChange={(value) => update(index, { params: { ...action.params, [param.name]: value } })}
              />
            ))}

            <input
              className="delay-input"
              type="number"
              min={0}
              step={100}
              placeholder="delay ms"
              value={action.delayMs}
              onChange={(event) => update(index, { delayMs: event.target.value })}
            />

            <IconButton
              icon="close"
              label="Remove action"
              onClick={() => setActions((current) => current.filter((_, i) => i !== index))}
            />
          </div>
        );
      })}

      <Button
        icon="plus"
        onClick={() =>
          setActions((current) => [...current, { device: usable[0]?.descriptor.id ?? '', command: '', params: {}, delayMs: '' }])
        }
      >
        Add action
      </Button>
    </Modal>
  );
}

function ParamInput({
  param,
  value,
  onChange,
}: {
  param: ParamSpec;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  if (param.type === 'enum') {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{param.label ?? param.name}</option>
        {param.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (param.type === 'boolean') {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{param.label ?? param.name}</option>
        <option value="true">on</option>
        <option value="false">off</option>
      </select>
    );
  }
  return (
    <input
      type={param.type === 'number' ? 'number' : 'text'}
      placeholder={`${param.label ?? param.name}${param.unit ? ` (${param.unit})` : ''}`}
      min={param.min}
      max={param.max}
      step={param.step}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function commandSpec(devices: Device[], deviceId: string, command: string) {
  return devices.find((d) => d.descriptor.id === deviceId)?.descriptor.commands.find((c) => c.name === command);
}

function coerce(raw: string, param?: ParamSpec): unknown {
  if (!param) return raw;
  if (param.type === 'number') return Number(raw);
  if (param.type === 'boolean') return raw === 'true';
  return raw;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || `scene-${Date.now()}`;
}

async function fetchCreate(body: unknown): Promise<void> {
  const token = localStorage.getItem('hub.token');
  const res = await fetch('/api/scenes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Could not save the scene (${res.status})`);
  }
}
