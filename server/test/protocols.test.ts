import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ClientType,
  MessageType,
  discoveryRequest,
  liveIdFromCertificate,
  parseDiscoveryResponse,
  powerOnRequest,
} from '../src/protocols/smartglass.js';
import { broadcastFor, macToBuffer, magicPacket, normalizeMac } from '../src/protocols/wol.js';
import { mSearch, parseSsdpResponse, hostFromLocation } from '../src/protocols/ssdp.js';

describe('wake-on-lan', () => {
  it('normalises MAC addresses written in any common style', () => {
    assert.equal(normalizeMac('a4bb6d112233'), 'A4:BB:6D:11:22:33');
    assert.equal(normalizeMac('a4-bb-6d-11-22-33'), 'A4:BB:6D:11:22:33');
    assert.equal(normalizeMac('A4:BB:6D:11:22:33'), 'A4:BB:6D:11:22:33');
  });

  it('rejects anything that is not six octets', () => {
    assert.throws(() => normalizeMac('a4:bb:6d:11:22'), /invalid MAC/);
    assert.throws(() => normalizeMac('nonsense'), /invalid MAC/);
  });

  it('builds a 102-byte magic packet: 6 sync bytes then the MAC 16 times', () => {
    const packet = magicPacket('A4:BB:6D:11:22:33');
    assert.equal(packet.length, 102);
    assert.deepEqual([...packet.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const mac = macToBuffer('A4:BB:6D:11:22:33');
    for (let i = 0; i < 16; i += 1) {
      assert.deepEqual(packet.subarray(6 + i * 6, 12 + i * 6), mac, `repetition ${i}`);
    }
  });

  it('derives the directed broadcast address for a subnet', () => {
    assert.equal(broadcastFor('192.168.1.74'), '192.168.1.255');
    assert.equal(broadcastFor('10.0.0.1'), '10.0.0.255');
    assert.equal(broadcastFor('not-an-ip'), undefined);
  });
});

describe('xbox smartglass', () => {
  it('frames a discovery request with the 6-byte simple header', () => {
    const packet = discoveryRequest(ClientType.PC);
    assert.equal(packet.readUInt16BE(0), MessageType.DiscoveryRequest);
    assert.equal(packet.readUInt16BE(2), packet.length - 6, 'header declares the payload length');
    assert.equal(packet.readUInt16BE(4), 0, 'version');
    assert.equal(packet.readUInt16BE(10), ClientType.PC, 'client type follows the 4-byte flags');
  });

  it('encodes the live ID as a length-prefixed, NUL-terminated string', () => {
    const liveId = 'FD00A1B2C3D4E5F6';
    const packet = powerOnRequest(liveId);
    assert.equal(packet.readUInt16BE(0), MessageType.PowerOnRequest);
    assert.equal(packet.readUInt16BE(2), liveId.length + 3);
    assert.equal(packet.readUInt16BE(6), liveId.length);
    assert.equal(packet.subarray(8, 8 + liveId.length).toString('ascii'), liveId);
    assert.equal(packet[packet.length - 1], 0, 'NUL terminator');
  });

  it('lower-cases are accepted but normalised, and junk is rejected', () => {
    assert.deepEqual(powerOnRequest('fd00a1b2c3d4e5f6'), powerOnRequest('FD00A1B2C3D4E5F6'));
    assert.throws(() => powerOnRequest('nope'), /invalid Xbox live ID/);
    assert.throws(() => powerOnRequest(''), /invalid Xbox live ID/);
  });

  it('recovers the live ID from the certificate subject', () => {
    const der = Buffer.concat([
      Buffer.from([0x30, 0x82, 0x01, 0x22, 0x06, 0x03, 0x55, 0x04, 0x03]),
      Buffer.from('FD00A1B2C3D4E5F6', 'latin1'),
    ]);
    assert.equal(liveIdFromCertificate(der), 'FD00A1B2C3D4E5F6');
    assert.equal(liveIdFromCertificate(Buffer.from('no id here', 'latin1')), undefined);
  });

  it('parses a discovery response round-trip', () => {
    // Build the same shape the console sends, then read it back.
    const sg = (value: string): Buffer => {
      const body = Buffer.from(value, 'utf8');
      const out = Buffer.alloc(2 + body.length + 1);
      out.writeUInt16BE(body.length, 0);
      body.copy(out, 2);
      return out;
    };
    const cert = Buffer.from('xxFD00A1B2C3D4E5F6xx', 'latin1');
    const head = Buffer.alloc(6);
    head.writeUInt32BE(2, 0);
    head.writeUInt16BE(1, 4);
    const tail = Buffer.alloc(6);
    tail.writeUInt32BE(0, 0);
    tail.writeUInt16BE(cert.length, 4);
    const payload = Buffer.concat([head, sg('LIVING ROOM XBOX'), sg('some-uuid'), tail, cert]);
    const header = Buffer.alloc(6);
    header.writeUInt16BE(MessageType.DiscoveryResponse, 0);
    header.writeUInt16BE(payload.length, 2);
    header.writeUInt16BE(2, 4);

    const parsed = parseDiscoveryResponse(Buffer.concat([header, payload]));
    assert.ok(parsed);
    assert.equal(parsed.name, 'LIVING ROOM XBOX');
    assert.equal(parsed.uuid, 'some-uuid');
    assert.equal(parsed.clientType, 1);
    assert.equal(parsed.liveId, 'FD00A1B2C3D4E5F6');
  });

  it('ignores packets that are not discovery responses', () => {
    assert.equal(parseDiscoveryResponse(discoveryRequest()), null);
    assert.equal(parseDiscoveryResponse(Buffer.alloc(2)), null);
  });
});

describe('ssdp', () => {
  it('builds a well-formed M-SEARCH', () => {
    const text = mSearch('roku:ecp', 3).toString('utf8');
    assert.match(text, /^M-SEARCH \* HTTP\/1\.1\r\n/);
    assert.match(text, /HOST: 239\.255\.255\.250:1900\r\n/);
    assert.match(text, /MAN: "ssdp:discover"\r\n/);
    assert.match(text, /ST: roku:ecp\r\n/);
    assert.match(text, /MX: 3\r\n/);
    assert.ok(text.endsWith('\r\n\r\n'), 'blank line terminates the request');
  });

  it('parses response headers case-insensitively', () => {
    const raw = Buffer.from(
      ['HTTP/1.1 200 OK', 'location: http://10.0.0.52:8060/', 'ST: roku:ecp', '', ''].join('\r\n'),
      'utf8',
    );
    const parsed = parseSsdpResponse(raw, '10.0.0.52');
    assert.ok(parsed);
    assert.equal(parsed.headers['LOCATION'], 'http://10.0.0.52:8060/');
    assert.equal(parsed.headers['ST'], 'roku:ecp');
    assert.equal(parsed.address, '10.0.0.52');
  });

  it('rejects non-SSDP traffic', () => {
    assert.equal(parseSsdpResponse(Buffer.from('garbage'), '1.2.3.4'), null);
  });

  it('extracts the host from a LOCATION header', () => {
    assert.equal(hostFromLocation('http://10.0.0.52:8060/'), '10.0.0.52');
    assert.equal(hostFromLocation('not a url'), undefined);
    assert.equal(hostFromLocation(undefined), undefined);
  });
});
