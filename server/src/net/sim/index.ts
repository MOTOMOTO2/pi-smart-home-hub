import { MessageType, SMARTGLASS_PORT } from '../../protocols/smartglass.js';
import { WOL_PORTS } from '../../protocols/wol.js';
import { SSDP_PORT } from '../../protocols/ssdp.js';
import type {
  ExecResult,
  HttpRequest,
  HttpResponse,
  Transport,
  UdpOptions,
  UdpReply,
  UdpTarget,
} from '../transport.js';
import { handleSimHttp } from './http.js';
import { SimWorld } from './world.js';

export { SimWorld } from './world.js';
export { DEMO_NANOLEAF_TOKEN } from './http.js';

/** MAC addresses the demo profile uses, so Wake-on-LAN has something to hit. */
export const DEMO_MACS = {
  pc: 'A4:BB:6D:11:22:33',
  tv: '9C:76:0E:44:55:66',
} as const;

export const DEMO_HOSTS = {
  nanoleaf: '10.0.0.41',
  tv: '10.0.0.52',
  xbox: '10.0.0.63',
  pc: '10.0.0.74',
} as const;

function sgString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(2 + body.length + 1);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

/**
 * A stand-in for the console certificate: the adapter only reads the live ID
 * out of it, so the demo just needs those bytes present in a DER-ish blob.
 */
function fakeCertificate(liveId: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x30, 0x82, 0x01, 0x22, 0x06, 0x03, 0x55, 0x04, 0x03, 0x13, liveId.length]),
    Buffer.from(liveId, 'latin1'),
    Buffer.from([0x02, 0x01, 0x01]),
  ]);
}

function discoveryResponsePacket(name: string, uuid: string, liveId: string): Buffer {
  const cert = fakeCertificate(liveId);
  const head = Buffer.alloc(6);
  head.writeUInt32BE(0x02, 0); // flags: AllowConsoleUsers
  head.writeUInt16BE(1, 4); // client type: Xbox
  const tail = Buffer.alloc(6);
  tail.writeUInt32BE(0, 0); // last error
  tail.writeUInt16BE(cert.length, 4);
  const payload = Buffer.concat([head, sgString(name), sgString(uuid), tail, cert]);

  const header = Buffer.alloc(6);
  header.writeUInt16BE(MessageType.DiscoveryResponse, 0);
  header.writeUInt16BE(payload.length, 2);
  header.writeUInt16BE(2, 4);
  return Buffer.concat([header, payload]);
}

function ssdpResponse(location: string, st: string, usn: string): Buffer {
  return Buffer.from(
    [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=3600',
      'EXT:',
      `LOCATION: ${location}`,
      `ST: ${st}`,
      `USN: ${usn}`,
      'SERVER: Demo/1.0 UPnP/1.0',
      '',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

function isMagicPacket(packet: Buffer): string | null {
  if (packet.length < 102) return null;
  for (let i = 0; i < 6; i += 1) if (packet[i] !== 0xff) return null;
  const mac = packet.subarray(6, 12);
  for (let rep = 1; rep < 16; rep += 1) {
    if (!mac.equals(packet.subarray(6 + rep * 6, 12 + rep * 6))) return null;
  }
  return [...mac].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

/**
 * Drop-in replacement for {@link RealTransport} that answers from in-process
 * device simulators. Device adapters are byte-for-byte the same code in demo
 * mode, which is what makes the demo profile a real smoke test rather than a
 * set of hardcoded screens.
 */
export class SimTransport implements Transport {
  readonly kind = 'sim' as const;
  readonly world: SimWorld;
  /** Every request, for assertions in tests. */
  readonly httpLog: Array<{ url: string; method: string }> = [];
  readonly udpLog: Array<{ target: UdpTarget; packet: Buffer }> = [];

  constructor(world = new SimWorld(), private readonly latencyMs = 0) {
    this.world = world;
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  async http(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    await this.delay();
    this.httpLog.push({ url, method: req.method ?? 'GET' });
    const res = handleSimHttp(url, req, this.world);
    if (!res.ok && !req.allowStatus) {
      throw new Error(`HTTP ${res.status} from ${url}: ${res.text().slice(0, 200)}`);
    }
    return res;
  }

  async udp(target: UdpTarget, packet: Buffer, _opts: UdpOptions = {}): Promise<UdpReply[]> {
    await this.delay();
    this.udpLog.push({ target, packet });

    if (target.port === SMARTGLASS_PORT) return this.handleSmartGlass(packet);
    if ((WOL_PORTS as readonly number[]).includes(target.port)) {
      const mac = isMagicPacket(packet);
      if (mac === DEMO_MACS.pc) {
        this.world.pc.wakeCount += 1;
        this.world.pc.on = true;
        this.world.pc.bootedAt = Date.now();
      } else if (mac === DEMO_MACS.tv) {
        this.world.roku.on = true;
      }
      return [];
    }
    if (target.port === SSDP_PORT) return this.handleSsdp(packet);
    return [];
  }

  private handleSmartGlass(packet: Buffer): UdpReply[] {
    if (packet.length < 6) return [];
    const type = packet.readUInt16BE(0);
    const xbox = this.world.xbox;

    if (type === MessageType.PowerOnRequest) {
      const liveId = packet.subarray(8, packet.length - 1).toString('utf8');
      if (liveId === xbox.liveId) {
        // Real hardware takes a few seconds to answer discovery after a wake.
        setTimeout(() => {
          xbox.on = true;
        }, 1500).unref?.();
      }
      return [];
    }

    if (type === MessageType.DiscoveryRequest && xbox.on) {
      return [
        {
          from: DEMO_HOSTS.xbox,
          port: SMARTGLASS_PORT,
          data: discoveryResponsePacket(xbox.name, xbox.uuid, xbox.liveId),
        },
      ];
    }
    return [];
  }

  private handleSsdp(packet: Buffer): UdpReply[] {
    const text = packet.toString('utf8');
    const st = /^ST:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
    const replies: UdpReply[] = [];
    if (st === 'roku:ecp' || st === 'ssdp:all') {
      replies.push({
        from: DEMO_HOSTS.tv,
        port: SSDP_PORT,
        data: ssdpResponse(`http://${DEMO_HOSTS.tv}:8060/`, 'roku:ecp', 'uuid:roku:ecp:X01500DEMO42'),
      });
    }
    if (st === 'nanoleaf_aurora:light' || st === 'nanoleaf:nlpublic' || st === 'ssdp:all') {
      replies.push({
        from: DEMO_HOSTS.nanoleaf,
        port: SSDP_PORT,
        data: ssdpResponse(
          `http://${DEMO_HOSTS.nanoleaf}:16021/`,
          'nanoleaf:nlpublic',
          'uuid:nanoleaf:S19042H00123',
        ),
      });
    }
    return replies;
  }

  async tcpProbe(host: string, port: number, _timeoutMs = 1500): Promise<boolean> {
    await this.delay();
    if (host === DEMO_HOSTS.pc) return this.world.pc.on;
    if (host === DEMO_HOSTS.tv) return this.world.roku.on && port === 8060;
    if (host === DEMO_HOSTS.nanoleaf) return port === 16021;
    return false;
  }

  async exec(command: string, args: string[], _timeoutMs = 10_000): Promise<ExecResult> {
    await this.delay();
    const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
    if (!command.includes('adb')) return { code: 127, stdout: '', stderr: `${command}: not found (demo)` };

    if (args[0] === 'connect') return ok(`connected to ${args[1] ?? ''}\n`);

    const script = args[args.indexOf('shell') + 1] ?? '';
    if (script.includes('mWakefulness')) {
      return ok(`  mWakefulness=${this.world.roku.on ? 'Awake' : 'Asleep'}\n`);
    }
    if (script.includes('mCurrentFocus')) {
      return ok(`  mCurrentFocus=Window{9a7f2c1 u0 ${this.world.roku.activeApp || 'com.google.android.tvlauncher'}/.MainActivity}\n`);
    }
    if (script.includes('media_session volume')) {
      return ok(`volume is ${this.world.roku.volume} in range [0..100]\n`);
    }
    if (script.startsWith('input keyevent')) {
      const code = script.split(/\s+/)[2] ?? '';
      if (code === 'KEYCODE_SLEEP') this.world.roku.on = false;
      if (code === 'KEYCODE_WAKEUP') this.world.roku.on = true;
      if (code === 'KEYCODE_POWER') this.world.roku.on = !this.world.roku.on;
      if (code === 'KEYCODE_VOLUME_UP') this.world.roku.volume = Math.min(100, this.world.roku.volume + 1);
      if (code === 'KEYCODE_VOLUME_DOWN') this.world.roku.volume = Math.max(0, this.world.roku.volume - 1);
      return ok('');
    }
    return ok('');
  }
}
