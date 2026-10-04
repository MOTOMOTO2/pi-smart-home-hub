import dgram from 'node:dgram';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { sleep } from '../util/async.js';
import {
  HttpError,
  makeResponse,
  type ExecResult,
  type HttpRequest,
  type HttpResponse,
  type Transport,
  type UdpOptions,
  type UdpReply,
  type UdpTarget,
} from './transport.js';

const DEFAULT_HTTP_TIMEOUT = 6000;

/** The production transport: plain HTTP, UDP sockets, TCP probes, subprocesses. */
export class RealTransport implements Transport {
  readonly kind = 'real' as const;

  async http(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_HTTP_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        redirect: 'follow',
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = Buffer.from(await res.arrayBuffer());
      const response = makeResponse(res.status, headers, body);
      if (!response.ok && !req.allowStatus) {
        throw new HttpError(res.status, url, body.toString('utf8'));
      }
      return response;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async udp(target: UdpTarget, packet: Buffer, opts: UdpOptions = {}): Promise<UdpReply[]> {
    const { broadcast = false, collectMs = 0, repeat = 1, repeatDelayMs = 250, localPort, multicastTtl } = opts;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const replies: UdpReply[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(localPort ?? 0, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });

    try {
      if (broadcast) socket.setBroadcast(true);
      if (multicastTtl !== undefined) socket.setMulticastTTL(multicastTtl);
      socket.on('message', (data, rinfo) => {
        replies.push({ from: rinfo.address, port: rinfo.port, data: Buffer.from(data) });
      });

      for (let i = 0; i < Math.max(1, repeat); i += 1) {
        if (i > 0) await sleep(repeatDelayMs);
        await new Promise<void>((resolve, reject) => {
          socket.send(packet, target.port, target.host, (err) => (err ? reject(err) : resolve()));
        });
      }

      if (collectMs > 0) await sleep(collectMs);
      return replies;
    } finally {
      socket.removeAllListeners('message');
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  }

  tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, host);
    });
  }

  exec(command: string, args: string[], timeoutMs = 10000): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }
}
