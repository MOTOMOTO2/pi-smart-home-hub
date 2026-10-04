/**
 * Every device adapter talks to the outside world through this interface and
 * never through `fetch`/`dgram` directly. That buys two things: a demo profile
 * that exercises the real adapter logic against in-process device simulators,
 * and unit tests that assert on the exact bytes/URLs an adapter produces.
 */
export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  /** Treat a non-2xx status as a resolved response instead of throwing. */
  allowStatus?: boolean;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

export interface UdpTarget {
  host: string;
  port: number;
}

export interface UdpOptions {
  /** Enable SO_BROADCAST; required for 255.255.255.255 style targets. */
  broadcast?: boolean;
  /** How long to keep the socket open collecting replies. 0 = fire and forget. */
  collectMs?: number;
  /** Repeat each packet this many times (some protocols expect bursts). */
  repeat?: number;
  /** Delay between repeats. */
  repeatDelayMs?: number;
  /** Bind to a specific local port (SSDP responses sometimes need this). */
  localPort?: number;
  multicastTtl?: number;
}

export interface UdpReply {
  from: string;
  port: number;
  data: Buffer;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Transport {
  readonly kind: 'real' | 'sim';
  http(url: string, req?: HttpRequest): Promise<HttpResponse>;
  udp(target: UdpTarget, packet: Buffer, opts?: UdpOptions): Promise<UdpReply[]>;
  tcpProbe(host: string, port: number, timeoutMs?: number): Promise<boolean>;
  exec(command: string, args: string[], timeoutMs?: number): Promise<ExecResult>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodyText: string,
  ) {
    super(`HTTP ${status} from ${url}${bodyText ? `: ${truncate(bodyText, 240)}` : ''}`);
    this.name = 'HttpError';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export function makeResponse(status: number, headers: Record<string, string>, body: Buffer): HttpResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: lower,
    body,
    text: () => body.toString('utf8'),
    json: <T>() => JSON.parse(body.toString('utf8') || 'null') as T,
  };
}
