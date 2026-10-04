import { useMemo, useState } from 'react';
import { api, snapshotUrl } from '../lib/api';
import { bool, formatTemp, list, num, obj, text } from '../lib/state';
import type { Device, RingEvent, ThermostatSensor } from '../lib/types';
import { Icon, type IconName } from './Icon';
import { Button, Chip, ColorPicker, IconButton, Modal, Slider, Toggle, relativeTime } from './controls';
import { PairDialog } from './PairDialog';

type Run = (deviceId: string, command: string, params?: Record<string, unknown>) => Promise<boolean>;

export function DevicePanel({
  device,
  onClose,
  run,
  notify,
}: {
  device: Device;
  onClose: () => void;
  run: Run;
  notify: (kind: 'ok' | 'error', message: string) => void;
}): JSX.Element {
  const [pairing, setPairing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { descriptor, state } = device;
  const caps = descriptor.capabilities;
  const id = descriptor.id;
  const disabled = !state.online && !state.needsSetup;

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await api.refresh(id);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const needsPairing = ['nanoleaf', 'ecobee', 'ring'].includes(descriptor.type);

  return (
    <>
      <Modal
        title={descriptor.name}
        onClose={onClose}
        footer={
          <>
            <span className="modal-meta">
              {descriptor.type}
              {descriptor.room ? ` · ${descriptor.room}` : ''} · updated {relativeTime(state.updatedAt)}
            </span>
            <Button icon="refresh" busy={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
          </>
        }
      >
        {state.needsSetup ? (
          <div className="banner" data-kind="setup">
            <Icon name="info" size={18} />
            <div>
              <strong>Setup needed</strong>
              <p>{descriptor.setupHint ?? state.error ?? 'This device needs to be paired before it can be used.'}</p>
            </div>
            {needsPairing ? (
              <Button variant="primary" onClick={() => setPairing(true)}>
                Pair
              </Button>
            ) : null}
          </div>
        ) : null}

        {!state.online && !state.needsSetup ? (
          <div className="banner" data-kind="error">
            <Icon name="info" size={18} />
            <div>
              <strong>Unreachable</strong>
              <p>{state.error ?? 'No response from the device.'}</p>
            </div>
          </div>
        ) : null}

        {state.online && state.error ? (
          <div className="banner" data-kind="warn">
            <Icon name="info" size={18} />
            <div>
              <p>{state.error}</p>
            </div>
          </div>
        ) : null}

        <PowerSection device={device} run={run} disabled={disabled} />
        {caps.includes('brightness') || caps.includes('color') || caps.includes('effects') ? (
          <LightSection device={device} run={run} disabled={disabled} />
        ) : null}
        {caps.includes('thermostat') ? <ThermostatSection device={device} run={run} disabled={disabled} /> : null}
        {caps.includes('inputs') || caps.includes('apps') ? (
          <SourceSection device={device} run={run} disabled={disabled} />
        ) : null}
        {caps.includes('volume') || caps.includes('remote') ? (
          <RemoteSection device={device} run={run} disabled={disabled} />
        ) : null}
        {caps.includes('media') ? <NowPlaying state={device.state} /> : null}
        {caps.includes('camera') ? <CameraSection device={device} run={run} disabled={disabled} /> : null}
        {caps.includes('events') ? <EventsSection state={device.state} /> : null}
        {caps.includes('sensors') ? <SensorsSection device={device} /> : null}
        {descriptor.setupHint && !state.needsSetup ? <p className="hint">{descriptor.setupHint}</p> : null}
      </Modal>

      {pairing ? (
        <PairDialog device={device} notify={notify} onClose={() => setPairing(false)} onDone={() => void refresh()} />
      ) : null}
    </>
  );
}

function Section({
  title,
  icon,
  children,
  actions,
}: {
  title: string;
  icon?: IconName;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): JSX.Element {
  return (
    <section className="panel-section">
      <header>
        {icon ? <Icon name={icon} size={15} /> : null}
        <h3>{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  );
}

function PowerSection({ device, run, disabled }: { device: Device; run: Run; disabled: boolean }): JSX.Element | null {
  const { descriptor, state } = device;
  const id = descriptor.id;
  const commands = new Set(descriptor.commands.map((c) => c.name));
  const on = bool(state, 'on');
  // `power` as a capability means both directions work; the Xbox, for one,
  // can be woken but never powered off without an Xbox Live session.
  const hasPower = descriptor.capabilities.includes('power') && commands.has('power');
  const extras = ['sleep', 'restart', 'shutdown', 'lock', 'identify'].filter((c) => commands.has(c));
  if (!hasPower && !commands.has('wake') && extras.length === 0) return null;

  return (
    <Section title="Power" icon="power">
      <div className="power-row">
        {hasPower && on !== null ? (
          <div className="power-main">
            <Toggle
              checked={on}
              disabled={disabled}
              label={`Turn ${descriptor.name} ${on ? 'off' : 'on'}`}
              onChange={(next) => void run(id, 'power', { on: next })}
            />
            <span>{on ? 'On' : 'Off'}</span>
          </div>
        ) : null}
        <div className="button-row">
          {commands.has('wake') ? (
            <Button icon="power" disabled={disabled} onClick={() => void run(id, 'wake')}>
              Wake
            </Button>
          ) : null}
          {extras.map((command) => (
            <Button key={command} disabled={disabled} onClick={() => void run(id, command)}>
              {descriptor.commands.find((c) => c.name === command)?.label ?? command}
            </Button>
          ))}
        </div>
      </div>
    </Section>
  );
}

function LightSection({ device, run, disabled }: { device: Device; run: Run; disabled: boolean }): JSX.Element {
  const { descriptor, state } = device;
  const id = descriptor.id;
  const caps = descriptor.capabilities;
  const brightness = num(state, 'brightness') ?? 0;
  const kelvin = num(state, 'colorTempK') ?? 4000;
  const effects = list<string>(state, 'effects');
  const currentEffect = text(state, 'effect');

  return (
    <Section title="Light" icon="sun">
      {caps.includes('brightness') ? (
        <Slider
          label="Brightness"
          unit="%"
          value={brightness}
          disabled={disabled}
          onCommit={(value) => void run(id, 'brightness', { value })}
        />
      ) : null}

      {caps.includes('color') ? (
        <ColorPicker
          value={text(state, 'hex')}
          disabled={disabled}
          onPick={(hex) => void run(id, 'color', { hex, keepBrightness: true })}
        />
      ) : null}

      {caps.includes('colorTemp') ? (
        <Slider
          label="White temperature"
          unit="K"
          min={1200}
          max={6500}
          step={100}
          value={kelvin}
          disabled={disabled}
          gradient="linear-gradient(90deg, #ff9e4a, #ffd9a0, #ffffff, #cfe4ff)"
          onCommit={(value) => void run(id, 'colorTemp', { kelvin: value })}
        />
      ) : null}

      {caps.includes('effects') && effects.length > 0 ? (
        <div className="chips">
          {effects.map((effect) => (
            <Chip
              key={effect}
              active={effect === currentEffect}
              disabled={disabled}
              onClick={() => void run(id, 'effect', { name: effect })}
            >
              {effect}
            </Chip>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function ThermostatSection({ device, run, disabled }: { device: Device; run: Run; disabled: boolean }): JSX.Element {
  const { descriptor, state } = device;
  const id = descriptor.id;
  const scale = text(state, 'scale');
  const temperature = num(state, 'temperature');
  const heat = num(state, 'heatSetpoint');
  const cool = num(state, 'coolSetpoint');
  const running = text(state, 'running') ?? 'idle';
  const mode = text(state, 'hvacMode') ?? 'unknown';
  const modes = descriptor.commands.find((c) => c.name === 'hvacMode')?.params?.[0]?.options ?? [];
  const step = scale === 'C' ? 0.5 : 1;

  const adjust = (side: 'heat' | 'cool', delta: number): void => {
    const base = side === 'heat' ? heat : cool;
    if (base === null) return;
    void run(id, 'setpoint', { [side]: Math.round((base + delta) * 10) / 10 });
  };

  return (
    <Section title="Climate" icon="thermostat">
      <div className="thermo">
        <div className="thermo-reading" data-running={running}>
          <span className="thermo-temp">{formatTemp(temperature, scale)}</span>
          <span className="thermo-state">
            {running === 'idle' ? `Idle · ${mode}` : running}
            {num(state, 'humidity') !== null ? ` · ${num(state, 'humidity')}% RH` : ''}
          </span>
          {bool(state, 'holdActive') ? <span className="thermo-hold">Hold active</span> : null}
        </div>

        <div className="setpoints">
          {(['heat', 'cool'] as const).map((side) => {
            const value = side === 'heat' ? heat : cool;
            return (
              <div className="setpoint" key={side} data-side={side}>
                <span className="setpoint-label">{side === 'heat' ? 'Heat to' : 'Cool to'}</span>
                <div className="setpoint-controls">
                  <IconButton
                    icon="minus"
                    label={`Lower ${side} setpoint`}
                    disabled={disabled || value === null}
                    onClick={() => adjust(side, -step)}
                  />
                  <span className="setpoint-value">{formatTemp(value, scale)}</span>
                  <IconButton
                    icon="plus"
                    label={`Raise ${side} setpoint`}
                    disabled={disabled || value === null}
                    onClick={() => adjust(side, step)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="chips">
        {modes.map((option) => (
          <Chip
            key={option.value}
            active={option.value === mode}
            disabled={disabled}
            onClick={() => void run(id, 'hvacMode', { mode: option.value })}
          >
            {option.label}
          </Chip>
        ))}
      </div>

      <div className="button-row">
        <Button disabled={disabled} onClick={() => void run(id, 'fan', { mode: 'on' })}>
          Fan on
        </Button>
        <Button disabled={disabled} onClick={() => void run(id, 'fan', { mode: 'auto' })}>
          Fan auto
        </Button>
        <Button disabled={disabled} onClick={() => void run(id, 'resume')}>
          Resume schedule
        </Button>
      </div>

      <SensorGrid sensors={list<ThermostatSensor>(state, 'sensors')} scale={scale} />
    </Section>
  );
}

function SensorGrid({ sensors, scale }: { sensors: ThermostatSensor[]; scale: string | null }): JSX.Element | null {
  if (sensors.length === 0) return null;
  return (
    <div className="sensor-grid">
      {sensors.map((sensor) => (
        <div className="sensor" key={sensor.id} data-occupied={sensor.occupied ? 'true' : 'false'}>
          <span className="sensor-name">{sensor.name}</span>
          <span className="sensor-temp">{formatTemp(sensor.temperature, scale)}</span>
          {sensor.occupied !== null ? (
            <span className="sensor-occupancy">{sensor.occupied ? 'occupied' : 'empty'}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SourceSection({ device, run, disabled }: { device: Device; run: Run; disabled: boolean }): JSX.Element {
  const { descriptor, state } = device;
  const id = descriptor.id;
  const activeId = text(state, 'activeAppId');
  const activeName = text(state, 'activeApp');
  const inputOptions = descriptor.commands.find((c) => c.name === 'input')?.params?.[0]?.options ?? [];
  const appOptions = descriptor.commands.find((c) => c.name === 'launch')?.params?.[0]?.options ?? [];
  const appCommand = descriptor.commands.find((c) => c.name === 'launch');
  const appParam = appCommand?.params?.[0]?.name ?? 'appId';
  // Inputs appear in both lists on Roku; show them once, under Inputs.
  const apps = appOptions.filter((option) => !option.value.startsWith('tvinput.'));

  return (
    <Section title="Source" icon="link">
      {inputOptions.length > 0 ? (
        <div className="chips">
          {inputOptions.map((option) => (
            <Chip
              key={option.value}
              active={activeName?.toLowerCase() === option.label.toLowerCase()}
              disabled={disabled}
              onClick={() => void run(id, 'input', { input: option.value })}
            >
              {option.label}
            </Chip>
          ))}
        </div>
      ) : null}

      {apps.length > 0 ? (
        <div className="chips">
          {apps.map((option) => (
            <Chip
              key={option.value}
              active={option.value === activeId}
              disabled={disabled}
              onClick={() => void run(id, 'launch', { [appParam]: option.value })}
            >
              {option.label}
            </Chip>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

const DPAD: Array<{ key: string; icon: IconName; label: string; area: string }> = [
  { key: 'Up', icon: 'up', label: 'Up', area: 'up' },
  { key: 'Left', icon: 'left', label: 'Left', area: 'left' },
  { key: 'Select', icon: 'star', label: 'Select', area: 'ok' },
  { key: 'Right', icon: 'right', label: 'Right', area: 'right' },
  { key: 'Down', icon: 'down', label: 'Down', area: 'down' },
];

function RemoteSection({ device, run, disabled }: { device: Device; run: Run; disabled: boolean }): JSX.Element {
  const { descriptor, state } = device;
  const id = descriptor.id;
  const caps = descriptor.capabilities;
  const keys = new Set(descriptor.commands.find((c) => c.name === 'key')?.params?.[0]?.options?.map((o) => o.value) ?? []);
  const volume = num(state, 'volume');
  const muted = bool(state, 'muted');

  return (
    <Section title="Remote" icon="tv">
      {caps.includes('remote') ? (
        <div className="remote">
          <div className="dpad">
            {DPAD.filter((b) => keys.has(b.key)).map((button) => (
              <button
                key={button.key}
                type="button"
                className="dpad-btn"
                style={{ gridArea: button.area }}
                aria-label={button.label}
                disabled={disabled}
                onClick={() => void run(id, 'key', { key: button.key })}
              >
                {button.key === 'Select' ? 'OK' : <Icon name={button.icon} size={18} />}
              </button>
            ))}
          </div>

          <div className="remote-side">
            <div className="button-row">
              {keys.has('Back') ? <IconButton icon="back" label="Back" disabled={disabled} onClick={() => void run(id, 'key', { key: 'Back' })} /> : null}
              {keys.has('Home') ? <IconButton icon="home" label="Home" disabled={disabled} onClick={() => void run(id, 'key', { key: 'Home' })} /> : null}
              {keys.has('Info') ? <IconButton icon="info" label="Info" disabled={disabled} onClick={() => void run(id, 'key', { key: 'Info' })} /> : null}
              {keys.has('Search') ? <IconButton icon="search" label="Search" disabled={disabled} onClick={() => void run(id, 'key', { key: 'Search' })} /> : null}
            </div>
            <div className="button-row">
              {keys.has('Rev') ? <IconButton icon="rewind" label="Rewind" disabled={disabled} onClick={() => void run(id, 'key', { key: 'Rev' })} /> : null}
              {keys.has('Play') ? <IconButton icon="play" label="Play or pause" size="lg" disabled={disabled} onClick={() => void run(id, 'key', { key: 'Play' })} /> : null}
              {keys.has('Fwd') ? <IconButton icon="forward" label="Fast forward" disabled={disabled} onClick={() => void run(id, 'key', { key: 'Fwd' })} /> : null}
            </div>
          </div>
        </div>
      ) : null}

      {caps.includes('volume') ? (
        <div className="volume-row">
          <IconButton icon="minus" label="Volume down" disabled={disabled} onClick={() => void run(id, 'volume', { delta: -2 })} />
          <span className="volume-value">{muted ? 'Muted' : volume !== null ? `Volume ${volume}` : 'Volume'}</span>
          <IconButton icon="plus" label="Volume up" disabled={disabled} onClick={() => void run(id, 'volume', { delta: 2 })} />
          <IconButton icon={muted ? 'mute' : 'volumeUp'} label="Mute" disabled={disabled} onClick={() => void run(id, 'mute')} />
        </div>
      ) : null}
    </Section>
  );
}

function NowPlaying({ state }: { state: Device['state'] }): JSX.Element | null {
  const playing = obj(state, 'nowPlaying');
  if (!playing) return null;
  const title = typeof playing['title'] === 'string' ? playing['title'] : null;
  const position = typeof playing['positionMs'] === 'number' ? playing['positionMs'] : null;
  const duration = typeof playing['durationMs'] === 'number' ? playing['durationMs'] : null;
  const pct = position !== null && duration && duration > 0 ? Math.min(100, (position / duration) * 100) : null;

  return (
    <Section title="Now playing" icon="play">
      <div className="now-playing">
        <strong>{title ?? 'Playing'}</strong>
        {pct !== null ? (
          <div className="progress">
            <div style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        {position !== null && duration ? (
          <span className="muted">
            {formatClock(position)} / {formatClock(duration)}
          </span>
        ) : null}
      </div>
    </Section>
  );
}

function formatClock(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function CameraSection({ device, run, disabled }: { device: Device; run: Run; disabled: boolean }): JSX.Element {
  const id = device.descriptor.id;
  const [nonce, setNonce] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  const url = useMemo(() => snapshotUrl(id, nonce), [id, nonce]);
  const commands = new Set(device.descriptor.commands.map((c) => c.name));

  const reload = (): void => {
    setFailed(false);
    setNonce(Date.now());
  };

  return (
    <Section
      title="Camera"
      icon="camera"
      actions={
        <button type="button" className="section-action" onClick={reload}>
          <Icon name="refresh" size={14} /> Reload
        </button>
      }
    >
      <div className="camera">
        {failed ? (
          <div className="camera-failed">
            <Icon name="camera" size={24} />
            <p>No snapshot available yet. Ask for a new one, then reload.</p>
          </div>
        ) : (
          <img src={url} alt={`Latest snapshot from ${device.descriptor.name}`} onError={() => setFailed(true)} />
        )}
      </div>
      <div className="button-row">
        {commands.has('snapshot') ? (
          <Button
            icon="camera"
            disabled={disabled}
            onClick={async () => {
              if (await run(id, 'snapshot')) {
                // Ring needs a moment to capture and upload the new frame.
                setTimeout(reload, 2500);
              }
            }}
          >
            New snapshot
          </Button>
        ) : null}
        {commands.has('light') && bool(device.state, 'hasLight') ? (
          <>
            <Button disabled={disabled} onClick={() => void run(id, 'light', { on: true })}>
              Light on
            </Button>
            <Button disabled={disabled} onClick={() => void run(id, 'light', { on: false })}>
              Light off
            </Button>
          </>
        ) : null}
        {commands.has('siren') && bool(device.state, 'hasSiren') ? (
          <Button variant="danger" disabled={disabled} onClick={() => void run(id, 'siren', { on: true })}>
            Siren
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function EventsSection({ state }: { state: Device['state'] }): JSX.Element {
  const events = list<RingEvent>(state, 'events');
  return (
    <Section title="Recent activity" icon="bell">
      {events.length === 0 ? (
        <p className="muted">No events recorded yet.</p>
      ) : (
        <ul className="event-list">
          {events.map((event) => (
            <li key={event.id}>
              <Icon name={event.kind === 'ding' ? 'bell' : 'activity'} size={15} />
              <span className="event-kind">{event.kind === 'ding' ? 'Doorbell' : event.kind}</span>
              <span className="event-time">{relativeTime(event.at)}</span>
              {event.answered ? <span className="event-tag">answered</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const HIDDEN_KEYS = new Set([
  'online',
  'updatedAt',
  'needsSetup',
  'error',
  'on',
  'events',
  'sensors',
  'effects',
  'apps',
  'nowPlaying',
  'paired',
  'snapshotUrl',
  'hex',
  'brightness',
  'hue',
  'saturation',
  'colorTempK',
  'temperature',
  'heatSetpoint',
  'coolSetpoint',
  'volume',
  'muted',
  'activeApp',
  'activeAppId',
]);

function SensorsSection({ device }: { device: Device }): JSX.Element | null {
  const entries = Object.entries(device.state)
    .filter(([key, value]) => !HIDDEN_KEYS.has(key) && value !== null && typeof value !== 'object')
    .slice(0, 14);
  if (entries.length === 0) return null;

  return (
    <Section title="Details" icon="info">
      <dl className="detail-grid">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{humanize(key)}</dt>
            <dd>{formatValue(key, value)}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bId\b/, 'ID');
}

function formatValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    if (key === 'battery') return `${Math.round(value)}%`;
    if (key === 'signalStrength') return `${value} dBm`;
    if (key === 'uptimeSeconds') {
      const hours = Math.floor(value / 3600);
      return hours > 0 ? `${hours}h ${Math.floor((value % 3600) / 60)}m` : `${Math.floor(value / 60)}m`;
    }
    if (key === 'lastSeen' || key === 'updatedAt') return relativeTime(value);
    return String(value);
  }
  return String(value);
}
