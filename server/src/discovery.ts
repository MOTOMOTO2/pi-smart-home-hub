import { SMARTGLASS_PORT, discoveryRequest, parseDiscoveryResponse } from './protocols/smartglass.js';
import { SEARCH_TARGETS, discover, hostFromLocation } from './protocols/ssdp.js';
import { createLogger } from './logger.js';
import type { Transport } from './net/transport.js';
import { xmlText } from './util/xml.js';
import type { DeviceType } from './config.js';

const log = createLogger('discovery');

export interface Discovered {
  type: DeviceType;
  name: string;
  host?: string;
  /** A ready-to-paste config block for config/hub.yaml. */
  suggestedConfig: Record<string, unknown>;
  details: Record<string, unknown>;
}

/**
 * LAN scan for the things that announce themselves: Roku TVs and Nanoleaf
 * controllers over SSDP, Xbox consoles over the SmartGlass discovery broadcast.
 *
 * Ecobee and Ring are cloud accounts rather than LAN devices, so they cannot be
 * discovered -- add them to config with an API key and pair from the UI. TCL
 * Google TV sets have no discovery protocol either; use the IP from the TV
 * network settings screen.
 */
export async function discoverDevices(transport: Transport, broadcastAddress?: string): Promise<Discovered[]> {
  const results: Discovered[] = [];
  const [roku, nanoleaf, xbox] = await Promise.allSettled([
    discoverRoku(transport),
    discoverNanoleaf(transport),
    discoverXbox(transport, broadcastAddress),
  ]);

  for (const settled of [roku, nanoleaf, xbox]) {
    if (settled.status === 'fulfilled') results.push(...settled.value);
    else log.warn('a discovery probe failed', settled.reason);
  }
  return results;
}

async function discoverRoku(transport: Transport): Promise<Discovered[]> {
  const responses = await discover(transport, SEARCH_TARGETS.roku);
  const out: Discovered[] = [];
  for (const response of responses) {
    const host = hostFromLocation(response.headers['LOCATION']) ?? response.address;
    let name = 'Roku TV';
    let model: string | undefined;
    let isTv = true;
    try {
      const info = await transport.http(`http://${host}:8060/query/device-info`, { timeoutMs: 3000 });
      const xml = info.text();
      name = xmlText(xml, 'friendly-device-name') ?? xmlText(xml, 'model-name') ?? name;
      model = xmlText(xml, 'model-name');
      isTv = xmlText(xml, 'is-tv') !== 'false';
    } catch (err) {
      log.debug(`could not read device-info from ${host}`, err);
    }
    out.push({
      type: 'rokutv',
      name,
      host,
      suggestedConfig: {
        id: slug(name),
        name,
        type: 'rokutv',
        host,
      },
      details: { model: model ?? null, isTv, usn: response.headers['USN'] ?? null },
    });
  }
  return out;
}

async function discoverNanoleaf(transport: Transport): Promise<Discovered[]> {
  const responses = [
    ...(await discover(transport, SEARCH_TARGETS.nanoleaf)),
    ...(await discover(transport, SEARCH_TARGETS.nanoleafAurora)),
  ];
  const seen = new Set<string>();
  const out: Discovered[] = [];
  for (const response of responses) {
    const host = hostFromLocation(response.headers['LOCATION']) ?? response.address;
    if (seen.has(host)) continue;
    seen.add(host);
    const name = response.headers['NL-DEVICENAME'] ?? response.headers['NL-DEVICEID'] ?? 'Nanoleaf';
    out.push({
      type: 'nanoleaf',
      name,
      host,
      suggestedConfig: { id: slug(name), name, type: 'nanoleaf', host },
      details: { st: response.headers['ST'] ?? null, usn: response.headers['USN'] ?? null },
    });
  }
  return out;
}

async function discoverXbox(transport: Transport, broadcastAddress?: string): Promise<Discovered[]> {
  const targets = broadcastAddress ? [broadcastAddress, '255.255.255.255'] : ['255.255.255.255'];
  const out: Discovered[] = [];
  const seen = new Set<string>();

  for (const host of targets) {
    const replies = await transport.udp({ host, port: SMARTGLASS_PORT }, discoveryRequest(), {
      broadcast: true,
      collectMs: 1500,
    });
    for (const reply of replies) {
      const parsed = parseDiscoveryResponse(reply.data);
      if (!parsed || seen.has(reply.from)) continue;
      seen.add(reply.from);
      const name = parsed.name || 'Xbox';
      const suggested: Record<string, unknown> = { id: slug(name), name, type: 'xbox', host: reply.from };
      if (parsed.liveId) suggested['liveId'] = parsed.liveId;
      out.push({
        type: 'xbox',
        name,
        host: reply.from,
        suggestedConfig: suggested,
        details: { liveId: parsed.liveId ?? null, uuid: parsed.uuid || null },
      });
    }
  }
  return out;
}

export function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'device';
}
