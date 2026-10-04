import { Icon } from './Icon';
import { Toggle } from './controls';
import { deviceAccent, isActive, summarize } from '../lib/state';
import { bool } from '../lib/state';
import type { Device } from '../lib/types';

export function DeviceTile({
  device,
  onOpen,
  onToggle,
}: {
  device: Device;
  onOpen: () => void;
  onToggle: (next: boolean) => void;
}): JSX.Element {
  const { descriptor, state } = device;
  const active = isActive(device);
  const accent = deviceAccent(device);
  const on = bool(state, 'on');
  const canToggle = descriptor.capabilities.includes('power') && state.online && !state.needsSetup;

  return (
    <article
      className="tile"
      data-active={active}
      data-offline={!state.online}
      style={accent ? ({ '--tile-accent': accent } as React.CSSProperties) : undefined}
    >
      <button type="button" className="tile-main" onClick={onOpen} aria-label={`Open ${descriptor.name}`}>
        <span className="tile-icon">
          <Icon name={descriptor.icon} size={22} />
        </span>
        <span className="tile-text">
          <span className="tile-name">{descriptor.name}</span>
          <span className="tile-status">{summarize(device)}</span>
        </span>
      </button>

      <div className="tile-actions">
        {state.needsSetup ? (
          <button type="button" className="tile-badge" onClick={onOpen}>
            Set up
          </button>
        ) : canToggle && on !== null ? (
          <Toggle checked={on} onChange={onToggle} label={`Toggle ${descriptor.name}`} />
        ) : (
          <Icon name="chevronRight" size={18} className="tile-chevron" />
        )}
      </div>
    </article>
  );
}
