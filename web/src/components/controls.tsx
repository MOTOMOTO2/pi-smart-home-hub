import { useEffect, useRef, useState } from 'react';
import { hexNear, hexToChroma } from '../lib/color';
import { Icon, type IconName } from './Icon';

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-on={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

/**
 * A slider that commits on release rather than on every pixel: dragging a
 * brightness bar should not fire fifty HTTP requests at a lightbulb.
 */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  unit,
  label,
  disabled,
  gradient,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label: string;
  disabled?: boolean;
  gradient?: string;
  onCommit: (next: number) => void;
}): JSX.Element {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);

  // Follow the device while idle, but never yank the handle out from under a finger.
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);

  const commit = (next: number): void => {
    dragging.current = false;
    if (next !== value) onCommit(next);
  };

  return (
    <label className="slider">
      <span className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value">
          {Math.round(local)}
          {unit ?? ''}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        disabled={disabled}
        style={gradient ? { background: gradient } : undefined}
        onChange={(event) => {
          dragging.current = true;
          setLocal(Number(event.target.value));
        }}
        onPointerUp={(event) => commit(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => commit(Number((event.target as HTMLInputElement).value))}
        onBlur={(event) => commit(Number(event.target.value))}
      />
    </label>
  );
}

export function Chip({
  active,
  children,
  onClick,
  disabled,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button type="button" className="chip" data-active={active ? 'true' : 'false'} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  icon,
  disabled,
  busy,
  type = 'button',
}: {
  children?: React.ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
}): JSX.Element {
  return (
    <button type={type} className="btn" data-variant={variant} disabled={disabled || busy} onClick={onClick}>
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  size = 'md',
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
}): JSX.Element {
  return (
    <button type="button" className="icon-btn" data-size={size} title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={size === 'lg' ? 24 : size === 'sm' ? 16 : 20} />
    </button>
  );
}

const PRESETS = [
  '#ffffff',
  '#ffd9a0',
  '#ff8c1a',
  '#ff3b30',
  '#ff2d95',
  '#a855f7',
  '#4f46e5',
  '#1e90ff',
  '#06b6d4',
  '#22c55e',
];

export function ColorPicker({
  value,
  onPick,
  disabled,
}: {
  /** The chroma the device reports, i.e. hue/saturation at full value. */
  value: string | null;
  onPick: (hex: string) => void;
  disabled?: boolean;
}): JSX.Element {
  const [custom, setCustom] = useState(value ?? '#ff8c1a');

  useEffect(() => {
    if (value) setCustom(value);
  }, [value]);

  return (
    <div className="color-picker">
      <div className="swatches">
        {PRESETS.map((hex) => (
          <button
            key={hex}
            type="button"
            className="swatch"
            style={{ background: hex }}
            // Compare chroma to chroma: the device drops the preset value.
            data-active={hexNear(value, hexToChroma(hex)) ? 'true' : 'false'}
            aria-label={`Set colour ${hex}`}
            disabled={disabled}
            onClick={() => onPick(hex)}
          />
        ))}
      </div>
      <div className="color-custom">
        <input
          type="color"
          value={custom}
          disabled={disabled}
          aria-label="Custom colour"
          onChange={(event) => setCustom(event.target.value)}
          onBlur={() => onPick(custom)}
        />
        <code>{custom}</code>
        <Button onClick={() => onPick(custom)} disabled={disabled}>
          Apply
        </Button>
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Empty({ icon, children }: { icon: IconName; children: React.ReactNode }): JSX.Element {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <p>{children}</p>
    </div>
  );
}

export function relativeTime(at: number | string | null | undefined): string {
  if (at === null || at === undefined) return 'never';
  const ts = typeof at === 'string' ? Date.parse(at) : at;
  if (!Number.isFinite(ts)) return 'unknown';
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
