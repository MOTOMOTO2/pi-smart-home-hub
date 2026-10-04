export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
  constructor(ms: number, what = 'operation') {
    super(`${what} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Reject if `promise` has not settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what?: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(ms, what)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Spread repeated timers so every device does not poll on the same tick. */
export function jitter(ms: number, spread = 0.15): number {
  const delta = ms * spread;
  return Math.round(ms - delta + Math.random() * delta * 2);
}

/**
 * Collapses concurrent calls: while a call is in flight, later callers get the
 * same promise instead of starting a second one. Keeps a burst of UI refreshes
 * from stacking up requests against one device.
 */
export function single<T>(fn: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return () => {
    if (!inflight) {
      inflight = fn().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
