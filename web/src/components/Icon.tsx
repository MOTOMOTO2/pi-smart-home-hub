/**
 * Inline SVG icon set. Hand-rolled rather than pulled from a library so the
 * bundle stays small on a Pi serving a tablet over wifi, and so device icons
 * can come straight from the adapter descriptors.
 */
const PATHS: Record<string, string> = {
  // device types
  nanoleaf: 'M12 3 4 8.5v7L12 21l8-5.5v-7L12 3Zm0 2.4 5.8 4v5.2L12 18.6l-5.8-4V9.4l5.8-4Z M12 8.2 9 10.3v3.4l3 2.1 3-2.1v-3.4l-3-2.1Z',
  tv: 'M3 5h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1 2v8h16V7H4Zm4 12h8v2H8v-2Z',
  xbox: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2c1.6 0 3.1.5 4.3 1.3-1.3.5-2.8 1.7-4.3 3.3-1.5-1.6-3-2.8-4.3-3.3A7.9 7.9 0 0 1 12 4ZM5.6 6.9c1.3.6 3.1 2.2 4.6 4-2 2.4-3.4 5-4 7.2A8 8 0 0 1 5.6 6.9Zm12.8 0a8 8 0 0 1-.6 11.2c-.6-2.2-2-4.8-4-7.2 1.5-1.8 3.3-3.4 4.6-4Z',
  desktop: 'M3 4h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7v3h3v2H7v-2h3v-3H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 2v7h16V6H4Z',
  thermostat: 'M12 2a3 3 0 0 1 3 3v7.2a5 5 0 1 1-6 0V5a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v8.3l-.5.4a3 3 0 1 0 3 0l-.5-.4V5a1 1 0 0 0-1-1Zm.8 4h-1.6v6.6a1 1 0 1 0 1.6 0V8Z',
  doorbell: 'M12 2a6 6 0 0 1 6 6v6l1.5 3H4.5L6 14V8a6 6 0 0 1 6-6Zm0 2a4 4 0 0 0-4 4v6.5L7.6 15h8.8L16 14.5V8a4 4 0 0 0-4-4Zm0 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM9.5 19h5a2.5 2.5 0 0 1-5 0Z',

  // actions
  power: 'M12 2a1 1 0 0 1 1 1v8a1 1 0 0 1-2 0V3a1 1 0 0 1 1-1Zm5.7 2.6a1 1 0 0 1 1.4 0A9.5 9.5 0 1 1 4.9 4.6a1 1 0 1 1 1.4 1.4 7.5 7.5 0 1 0 11.4 0 1 1 0 0 1 0-1.4Z',
  refresh: 'M12 4a8 8 0 0 1 7.5 5.2l1.9-.7A10 10 0 0 0 4 6.5V3H2v6h6V7H5.3A8 8 0 0 1 12 4Zm0 16a8 8 0 0 1-7.5-5.2l-1.9.7A10 10 0 0 0 20 17.5V21h2v-6h-6v2h2.7A8 8 0 0 1 12 20Z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  minus: 'M5 11h14v2H5v-2Z',
  close: 'M6.2 4.8 12 10.6l5.8-5.8 1.4 1.4L13.4 12l5.8 5.8-1.4 1.4L12 13.4l-5.8 5.8-1.4-1.4L10.6 12 4.8 6.2l1.4-1.4Z',
  chevronRight: 'M9 5.8 10.4 4.4 18 12l-7.6 7.6L9 18.2 15.2 12 9 5.8Z',

  // navigation / remote
  up: 'M12 6 5 14h14L12 6Z',
  down: 'M12 18 5 10h14l-7 8Z',
  left: 'M6 12l8-7v14l-8-7Z',
  right: 'M18 12l-8 7V5l8 7Z',
  home: 'M12 3 2 11h3v10h6v-6h2v6h6V11h3L12 3Z',
  back: 'M11 5.8 9.6 4.4 2 12l7.6 7.6L11 18.2 5.8 13H22v-2H5.8L11 5.8Z',
  play: 'M8 5v14l11-7L8 5Z',
  pause: 'M7 5h4v14H7V5Zm6 0h4v14h-4V5Z',
  rewind: 'M11 12l9-6v12l-9-6Zm-9 0 9-6v12l-9-6Z',
  forward: 'M13 12 4 18V6l9 6Zm9 0-9 6V6l9 6Z',
  volumeUp: 'M3 9h3l5-4v14l-5-4H3V9Zm13.5-3.3a7 7 0 0 1 0 12.6v-2.2a5 5 0 0 0 0-8.2V5.7Zm-2 3.1a4 4 0 0 1 0 6.4v-2.4a2 2 0 0 0 0-1.6V8.8Z',
  mute: 'M3 9h3l5-4v14l-5-4H3V9Zm12.3.3 1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1Z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 5h2v2h-2V7Zm0 4h2v6h-2v-6Z',
  search: 'M10 3a7 7 0 1 1-4.2 12.6l-3.1 3.1-1.4-1.4 3.1-3.1A7 7 0 0 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',

  // nav tabs and misc
  grid: 'M3 3h8v8H3V3Zm10 0h8v8h-8V3ZM3 13h8v8H3v-8Zm10 0h8v8h-8v-8Z',
  wand: 'M14.7 3.3 16 2l6 6-1.3 1.3-6-6ZM2 20.7 13.4 9.3l1.3 1.4L3.3 22 2 20.7ZM5 3l.9 2.1L8 6l-2.1.9L5 9l-.9-2.1L2 6l2.1-.9L5 3Zm14 10 .9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9L19 13Z',
  activity: 'M3 12h3l3 7 4-14 3 7h5v2h-6.3l-1.7-4-3.6 12.6L4.7 14H3v-2Z',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-1.4-8h2.8l.4 2.3 1.9.8 2-1.2 2 2-1.2 2 .8 1.9 2.3.4v2.8l-2.3.4-.8 1.9 1.2 2-2 2-2-1.2-1.9.8-.4 2.3h-2.8l-.4-2.3-1.9-.8-2 1.2-2-2 1.2-2-.8-1.9L2 13.4v-2.8l2.3-.4.8-1.9-1.2-2 2-2 2 1.2 1.9-.8.4-2.3Z',
  sun: 'M12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-1-7h2v3h-2V1Zm0 19h2v3h-2v-3ZM1 11h3v2H1v-2Zm19 0h3v2h-3v-2ZM4.2 2.8l2.1 2.1L4.9 6.3 2.8 4.2l1.4-1.4Zm13.5 13.5 2.1 2.1-1.4 1.4-2.1-2.1 1.4-1.4ZM19.8 2.8l1.4 1.4-2.1 2.1-1.4-1.4 2.1-2.1ZM6.3 17.7l1.4 1.4-2.1 2.1-1.4-1.4 2.1-2.1Z',
  moon: 'M12.3 2a8 8 0 1 0 9.7 9.7 7 7 0 0 1-9.7-9.7Zm-1.9 2.6a9 9 0 0 0 8.4 8.4A6 6 0 1 1 10.4 4.6Z',
  film: 'M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 2v2h2V6H4Zm4 0v12h8V6H8Zm10 0v2h2V6h-2ZM4 10v2h2v-2H4Zm14 0v2h2v-2h-2ZM4 14v2h2v-2H4Zm14 0v2h2v-2h-2Z',
  gamepad: 'M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7Zm0 2a3 3 0 0 0 0 6h10a3 3 0 0 0 0-6H7Zm1 1h2v1.5h1.5v2H10V15H8v-1.5H6.5v-2H8V10Zm7.5 1a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm2 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
  bell: 'M12 2a6 6 0 0 1 6 6v5l2 3H4l2-3V8a6 6 0 0 1 6-6Zm0 2a4 4 0 0 0-4 4v5.6L7.7 14h8.6L16 13.6V8a4 4 0 0 0-4-4ZM9.5 19h5a2.5 2.5 0 0 1-5 0Z',
  wifi: 'M12 18a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm0-4.5a5 5 0 0 1 3.5 1.4l-1.4 1.5a3 3 0 0 0-4.2 0l-1.4-1.5A5 5 0 0 1 12 13.5Zm0-4.5a9.5 9.5 0 0 1 6.7 2.8l-1.4 1.4a7.5 7.5 0 0 0-10.6 0l-1.4-1.4A9.5 9.5 0 0 1 12 9Z',
  battery: 'M4 7h13a1 1 0 0 1 1 1v2h2v4h-2v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Zm1 2v6h11V9H5Z',
  camera: 'M9 4h6l1 2h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4l1-2Zm3 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z',
  star: 'M12 2l2.9 6.3 6.8.8-5 4.7 1.3 6.8L12 17.3 5.9 20.6 7.2 13.8 2.2 9.1l6.9-.8L12 2Z',
  link: 'M9 7h2v2H9a3 3 0 0 0 0 6h2v2H9a5 5 0 0 1 0-10Zm4 0h2a5 5 0 0 1 0 10h-2v-2h2a3 3 0 0 0 0-6h-2V7ZM8 11h8v2H8v-2Z',
};

export type IconName = keyof typeof PATHS | string;

export function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}): JSX.Element | null {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}

export function hasIcon(name: string): boolean {
  return name in PATHS;
}
