import type { Transport } from '../net/transport.js';

/** Ports that WoL implementations listen on; we spray all three. */
export const WOL_PORTS = [9, 7, 40000] as const;

export function normalizeMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) throw new Error(`invalid MAC address: "${mac}"`);
  return hex.match(/.{2}/g)!.join(':');
}

export function macToBuffer(mac: string): Buffer {
  const hex = normalizeMac(mac).replace(/:/g, '');
  return Buffer.from(hex, 'hex');
}

/**
 * A magic packet is 6 bytes of 0xFF followed by the target MAC repeated 16
 * times, for 102 bytes total.
 */
export function magicPacket(mac: string): Buffer {
  const addr = macToBuffer(mac);
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i += 1) {
    addr.copy(packet, 6 + i * 6);
  }
  return packet;
}

export interface WakeOptions {
  /** Directed broadcast (for example 192.168.1.255) reaches more NICs than the global one. */
  broadcastAddress?: string;
  ports?: readonly number[];
  repeat?: number;
}

export async function wake(transport: Transport, mac: string, opts: WakeOptions = {}): Promise<void> {
  const packet = magicPacket(mac);
  const hosts = new Set<string>(['255.255.255.255']);
  if (opts.broadcastAddress) hosts.add(opts.broadcastAddress);
  const ports = opts.ports ?? WOL_PORTS;

  for (const host of hosts) {
    for (const port of ports) {
      await transport.udp({ host, port }, packet, {
        broadcast: true,
        repeat: opts.repeat ?? 3,
        repeatDelayMs: 120,
      });
    }
  }
}

/** Derive x.y.z.255 from an IPv4 address, for a directed broadcast. */
export function broadcastFor(ip: string): string | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return undefined;
  return `${parts[0]}.${parts[1]}.${parts[2]}.255`;
}
