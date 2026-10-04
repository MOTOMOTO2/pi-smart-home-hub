/**
 * Nanoleaf separates colour from intensity: hue and saturation set the colour,
 * brightness is its own control. The adapter therefore reports `hex` as the
 * *chroma* -- the hue/saturation pair rendered at full value -- so a dimmed
 * strip still shows its true colour in the UI.
 *
 * The consequence is that a preset swatch like #22c55e (a 77%-value green) is
 * reported back as #2bff79, so the picker has to compare chroma to chroma
 * rather than comparing hex strings.
 */
export function hexToChroma(hex: string): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const hsv = rgbToHsv(rgb);
  return rgbToHex(hsvToRgb({ h: hsv.h, s: hsv.s, v: 100 }));
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match || !match[1]) return null;
  const body = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = 60 * (((gg - bb) / d) % 6);
    else if (max === gg) h = 60 * ((bb - rr) / d + 2);
    else h = 60 * ((rr - gg) / d + 4);
  }
  if (h < 0) h += 360;
  return { h: Math.round(h), s: Math.round(max === 0 ? 0 : (d / max) * 100), v: Math.round(max * 100) };
}

export function hsvToRgb({ h, s, v }: { h: number; s: number; v: number }): Rgb {
  const hh = ((((h % 360) + 360) % 360) / 60);
  const ss = Math.max(0, Math.min(100, s)) / 100;
  const vv = Math.max(0, Math.min(100, v)) / 100;
  const c = vv * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = vv - c;
  const table: ReadonlyArray<readonly [number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[Math.floor(hh) % 6] ?? [0, 0, 0];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** True when two hex colours are the same to within a per-channel tolerance. */
export function hexNear(a: string | null, b: string | null, tolerance = 6): boolean {
  if (!a || !b) return false;
  const left = hexToRgb(a);
  const right = hexToRgb(b);
  if (!left || !right) return false;
  return (
    Math.abs(left.r - right.r) <= tolerance &&
    Math.abs(left.g - right.g) <= tolerance &&
    Math.abs(left.b - right.b) <= tolerance
  );
}
