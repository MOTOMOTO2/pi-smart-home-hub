import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('store');

/**
 * Credentials and tokens the hub earns at runtime (Nanoleaf auth tokens,
 * Ecobee/Ring refresh tokens, discovered live IDs) live here rather than in the
 * config file, so the config stays hand-editable and the secrets file can be
 * chmod 600 and git-ignored.
 *
 * Writes are atomic (temp file + rename) and debounced, because a flash card
 * in a Pi is the thing most likely to be mid-write when the power goes out.
 */
export class Store {
  private data: Record<string, unknown> = {};
  private writeTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(private readonly file: string, private readonly debounceMs = 250) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, unknown>;
      }
      log.debug(`loaded ${Object.keys(this.data).length} namespaces from ${this.file}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log.info(`no state file yet, starting fresh at ${this.file}`);
        this.data = {};
        return;
      }
      log.error(`could not read ${this.file}, starting with empty state`, err);
      this.data = {};
    }
  }

  /** Namespaced view so each device owns its own slice of the file. */
  namespace(name: string): StoreNamespace {
    return new StoreNamespace(this, name);
  }

  get<T>(namespace: string, key: string): T | undefined {
    const bucket = this.data[namespace];
    if (!bucket || typeof bucket !== 'object') return undefined;
    return (bucket as Record<string, unknown>)[key] as T | undefined;
  }

  set(namespace: string, key: string, value: unknown): void {
    let bucket = this.data[namespace];
    if (!bucket || typeof bucket !== 'object') {
      bucket = {};
      this.data[namespace] = bucket;
    }
    (bucket as Record<string, unknown>)[key] = value;
    this.schedule();
  }

  delete(namespace: string, key: string): void {
    const bucket = this.data[namespace];
    if (bucket && typeof bucket === 'object') {
      delete (bucket as Record<string, unknown>)[key];
      this.schedule();
    }
  }

  all(namespace: string): Record<string, unknown> {
    const bucket = this.data[namespace];
    return bucket && typeof bucket === 'object' ? { ...(bucket as Record<string, unknown>) } : {};
  }

  private schedule(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, this.debounceMs);
    this.writeTimer.unref?.();
  }

  /** Serialised so two flushes never race on the same temp file. */
  async flush(): Promise<void> {
    if (!this.dirty) return await this.writing;
    this.dirty = false;
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(tmp, this.file);
      } catch (err) {
        log.error(`failed to persist state to ${this.file}`, err);
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    });
    return await this.writing;
  }

  async close(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flush();
  }
}

export class StoreNamespace {
  constructor(private readonly store: Store, private readonly name: string) {}

  get<T>(key: string): T | undefined {
    return this.store.get<T>(this.name, key);
  }

  set(key: string, value: unknown): void {
    this.store.set(this.name, key, value);
  }

  delete(key: string): void {
    this.store.delete(this.name, key);
  }

  all(): Record<string, unknown> {
    return this.store.all(this.name);
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
