/**
 * The handful of Xbox SmartGlass packets that need no console pairing or Xbox
 * Live token: discovery (is the console awake, what is it called) and power-on.
 *
 * Wire format for these "simple" messages is a 6-byte big-endian header --
 * message type, unprotected payload length, version -- followed by the
 * payload. Strings are length-prefixed and NUL-terminated.
 *
 * Anything beyond this (power off, launching a title, sending input) needs an
 * authenticated and cryptographically paired session, which is out of scope;
 * see docs/devices.md.
 */
export const SMARTGLASS_PORT = 5050;

export const MessageType = {
  DiscoveryRequest: 0xdd00,
  DiscoveryResponse: 0xdd01,
  PowerOnRequest: 0xdd02,
} as const;

export const ClientType = {
  Xbox: 1,
  PC: 3,
  Android: 4,
  iOS: 5,
  WindowsStore: 6,
  WindowsUniversal: 7,
} as const;

export const DeviceFlags = {
  AllowConsoleUsers: 0x02,
  AllowAuthenticatedUsers: 0x04,
  AllowAnonymousUsers: 0x08,
  CertificateDisabled: 0x10,
} as const;

function sgString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(2 + body.length + 1);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  out[out.length - 1] = 0;
  return out;
}

function readSgString(buf: Buffer, offset: number): { value: string; next: number } {
  if (offset + 2 > buf.length) return { value: '', next: buf.length };
  const len = buf.readUInt16BE(offset);
  const start = offset + 2;
  const end = Math.min(start + len, buf.length);
  return { value: buf.subarray(start, end).toString('utf8'), next: end + 1 };
}

function simpleMessage(type: number, payload: Buffer, version = 0): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(payload.length, 2);
  header.writeUInt16BE(version, 4);
  return Buffer.concat([header, payload]);
}

/** Broadcast this on UDP/5050; awake consoles answer with a DiscoveryResponse. */
export function discoveryRequest(clientType: number = ClientType.PC): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUInt32BE(0, 0); // flags
  payload.writeUInt16BE(clientType, 4);
  payload.writeUInt16BE(0, 6); // minimum version
  payload.writeUInt16BE(2, 8); // maximum version
  return simpleMessage(MessageType.DiscoveryRequest, payload);
}

/**
 * Wakes a console from standby. The live ID is the console certificate CN --
 * a 16-character string beginning with `FD`, which `discover()` recovers for
 * you while the console is awake so you can store it in config.
 */
export function powerOnRequest(liveId: string): Buffer {
  const id = liveId.trim().toUpperCase();
  if (!/^[0-9A-F]{16,}$/.test(id)) {
    throw new Error(`invalid Xbox live ID "${liveId}" (expected 16 hex characters, usually starting with FD)`);
  }
  return simpleMessage(MessageType.PowerOnRequest, sgString(id));
}

export interface DiscoveryResponse {
  type: number;
  flags: number;
  clientType: number;
  name: string;
  uuid: string;
  lastError: number;
  /** Recovered from the certificate CN when present. */
  liveId?: string;
  certificate?: Buffer;
}

export function parseDiscoveryResponse(packet: Buffer): DiscoveryResponse | null {
  if (packet.length < 6) return null;
  const type = packet.readUInt16BE(0);
  if (type !== MessageType.DiscoveryResponse) return null;
  const payloadLength = packet.readUInt16BE(2);
  const payload = packet.subarray(6, Math.min(6 + payloadLength, packet.length));
  if (payload.length < 6) return null;

  const flags = payload.readUInt32BE(0);
  const clientType = payload.readUInt16BE(4);
  const name = readSgString(payload, 6);
  const uuid = readSgString(payload, name.next);
  let cursor = uuid.next;
  let lastError = 0;
  if (cursor + 4 <= payload.length) {
    lastError = payload.readUInt32BE(cursor);
    cursor += 4;
  }
  let certificate: Buffer | undefined;
  if (cursor + 2 <= payload.length) {
    const certLen = payload.readUInt16BE(cursor);
    cursor += 2;
    if (certLen > 0 && cursor + certLen <= payload.length) {
      certificate = Buffer.from(payload.subarray(cursor, cursor + certLen));
    }
  }

  const response: DiscoveryResponse = {
    type,
    flags,
    clientType,
    name: name.value,
    uuid: uuid.value,
    lastError,
  };
  if (certificate) {
    response.certificate = certificate;
    const liveId = liveIdFromCertificate(certificate);
    if (liveId) response.liveId = liveId;
  }
  return response;
}

/**
 * Pulls the live ID out of the DER certificate without an ASN.1 parser: the
 * subject CN is the only 16-char FD-prefixed hex token in there.
 */
export function liveIdFromCertificate(der: Buffer): string | undefined {
  const ascii = der.toString('latin1');
  const match = /FD[0-9A-F]{14}/.exec(ascii);
  return match ? match[0] : undefined;
}
