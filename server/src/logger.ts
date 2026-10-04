import { EventEmitter } from 'node:events';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogRecord {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  detail?: unknown;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<LogLevel, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';

/**
 * Logs go to stdout (journald picks them up under systemd) and into a bounded
 * ring buffer the dashboard can read, so you can debug a device from the couch
 * without SSH.
 */
class LogBus extends EventEmitter {
  private level: LogLevel = 'info';
  private readonly buffer: LogRecord[] = [];
  private readonly capacity = 500;
  private color = process.stdout.isTTY === true;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setColor(enabled: boolean): void {
    this.color = enabled;
  }

  recent(limit = 200, minLevel: LogLevel = 'debug'): LogRecord[] {
    const floor = RANK[minLevel];
    return this.buffer.filter((r) => RANK[r.level] >= floor).slice(-limit);
  }

  write(record: LogRecord): void {
    if (RANK[record.level] < RANK[this.level]) return;
    this.buffer.push(record);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);

    const time = new Date(record.ts).toISOString().slice(11, 23);
    const tint = this.color ? COLORS[record.level] : '';
    const reset = this.color ? RESET : '';
    const head = `${time} ${tint}${record.level.toUpperCase().padEnd(5)}${reset} [${record.scope}]`;
    const detail = record.detail === undefined ? '' : ` ${formatDetail(record.detail)}`;
    const line = `${head} ${record.message}${detail}`;
    if (record.level === 'error' || record.level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);

    this.emit('log', record);
  }
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) return detail.stack ?? detail.message;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export const logBus = new LogBus();

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel) => (message: string, detail?: unknown) =>
    logBus.write({ ts: Date.now(), level, scope, message, detail });
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}
