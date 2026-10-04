import type { Transport } from '../net/transport.js';

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;

/**
 * Search targets we care about:
 *  - `roku:ecp`                 TCL/Roku TVs
 *  - `nanoleaf_aurora:light`    Light Panels / Aurora
 *  - `nanoleaf:nlpublic`        Shapes / Canvas / Lines
 */
export const SEARCH_TARGETS = {
  roku: 'roku:ecp',
  nanoleafAurora: 'nanoleaf_aurora:light',
  nanoleaf: 'nanoleaf:nlpublic',
  all: 'ssdp:all',
} as const;

export function mSearch(target: string, mx = 2): Buffer {
  const lines = [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `ST: ${target}`,
    `MX: ${mx}`,
    '',
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

export interface SsdpResponse {
  address: string;
  headers: Record<string, string>;
}

export function parseSsdpResponse(data: Buffer, address: string): SsdpResponse | null {
  const text = data.toString('utf8');
  if (!/^HTTP\/1\.[01]\s+200/i.test(text) && !/^NOTIFY/i.test(text)) return null;
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
  }
  return { address, headers };
}

export async function discover(
  transport: Transport,
  target: string,
  collectMs = 2500,
): Promise<SsdpResponse[]> {
  const replies = await transport.udp({ host: SSDP_ADDRESS, port: SSDP_PORT }, mSearch(target), {
    collectMs,
    repeat: 2,
    repeatDelayMs: 400,
    multicastTtl: 4,
    broadcast: true,
  });

  const byAddress = new Map<string, SsdpResponse>();
  for (const reply of replies) {
    const parsed = parseSsdpResponse(reply.data, reply.from);
    if (!parsed) continue;
    const key = `${parsed.address}|${parsed.headers['USN'] ?? ''}`;
    if (!byAddress.has(key)) byAddress.set(key, parsed);
  }
  return [...byAddress.values()];
}

/** `http://192.168.1.50:8060/` -> `192.168.1.50`. */
export function hostFromLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  try {
    return new URL(location).hostname;
  } catch {
    return undefined;
  }
}
